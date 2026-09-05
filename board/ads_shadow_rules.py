from __future__ import annotations

from datetime import datetime, timedelta, timezone
import math
from typing import Any, Mapping

from ads_rule_catalog import MIN_PRODUCT_OBSERVED_DAYS, MIN_SIGNAL_CLICKS
from decision_contract import DecisionCandidate, finalize_candidate
from decision_resolver import resolve_conditions


SHADOW_RULE_VERSIONS = {
    "ADS_DATA_BLOCKER": 2,
    "ADS_INVENTORY_CONFLICT": 2,
    "ADS_PRODUCT_CONVERSION_GAP": 2,
}
CONSTRAINED_INVENTORY_ACTIONS = {"STOCKOUT", "PRODUCE", "PLAN"}


def _number(value: Any) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return 0.0
    return result if math.isfinite(result) else 0.0


def _integer(value: Any) -> int:
    return int(_number(value))


def _timestamp(value: Any) -> str:
    if isinstance(value, datetime):
        parsed = value
    else:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("fact cutoffs must include a timezone")
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _source_cutoff(row: Mapping[str, Any], field: str, fallback: str) -> str:
    value = row.get(field)
    return _timestamp(value) if value is not None else fallback


def _window(values: Mapping[str, Any]) -> dict[str, Any]:
    required = ("id", "start", "through", "state", "cutoff")
    missing = [field for field in required if values.get(field) in (None, "")]
    if missing:
        raise ValueError(f"decision window missing: {', '.join(missing)}")
    return {
        "id": str(values["id"]),
        "start": str(values["start"]),
        "through": str(values["through"]),
        "state": str(values["state"]),
        "cutoff": _timestamp(values["cutoff"]),
        "currency": str(values.get("currency") or "MXN"),
    }


def _condition(
    *,
    domain: str,
    code: str,
    resolution: str,
    rule_key: str,
    reason: str,
    operands: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "domain": domain,
        "code": code,
        "resolution": resolution,
        "rule_key": rule_key,
        "reason": reason,
        "operands": operands,
    }


def _candidate(
    *,
    kind: str,
    lane: str,
    subject: Mapping[str, Any],
    recommendation: Mapping[str, Any],
    materiality: Mapping[str, Any],
    confidence: Mapping[str, Any],
    window: Mapping[str, Any],
    evidence: list[dict[str, Any]],
    conditions: list[dict[str, Any]],
    guardrails: list[Any],
    destination: Mapping[str, Any],
    now: datetime,
) -> DecisionCandidate:
    resolution = resolve_conditions(conditions)
    valid_until = now.astimezone(timezone.utc) + timedelta(hours=24)
    return finalize_candidate(
        {
            "domain": "ADVERTISING",
            "lane": lane,
            "kind": kind,
            "state": "SHADOW_CANDIDATE",
            "rule": {"key": kind, "version": SHADOW_RULE_VERSIONS[kind], "lifecycle": "SHADOW"},
            "subject": dict(subject),
            "recommendation": {**recommendation, "execution_state": "SHADOW_ONLY"},
            "materiality": dict(materiality),
            "confidence": dict(confidence),
            "window": {
                "id": window["id"],
                "start": window["start"],
                "through": window["through"],
                "state": window["state"],
            },
            "evidence": evidence,
            "cross_domain_conditions": resolution["conditions"],
            "guardrails": guardrails,
            "blockers": resolution["blockers"],
            "suppression": resolution["suppression"],
            "destination": dict(destination),
            "created_at": _timestamp(now),
            "valid_until": _timestamp(valid_until),
        }
    )


def data_blocker_candidate(
    source: Mapping[str, Any], window_values: Mapping[str, Any], *, now: datetime
) -> DecisionCandidate | None:
    """Record a source/reconciliation blocker without fabricating downstream advice."""

    if bool(source.get("trusted")):
        return None
    window = _window(window_values)
    source_key = str(source.get("source_key") or "amazon_ads")
    state = str(source.get("state") or "UNAVAILABLE")
    reason = str(source.get("reason") or "Required advertising evidence is not decision-ready.")
    cutoff = _timestamp(source.get("cutoff") or window["cutoff"])
    condition = _condition(
        domain="DATA_HEALTH",
        code=f"{source_key.upper()}_{state.upper()}",
        resolution="BLOCK_DOMAIN",
        rule_key="ADS_SOURCE_TRUST_V1",
        reason=reason,
        operands=[
            {"fact": "data_health.source_state", "value": state, "source": source_key},
            {"fact": "data_health.trusted", "value": False, "source": source_key},
        ],
    )
    return _candidate(
        kind="ADS_DATA_BLOCKER",
        lane="PROTECT",
        subject={
            "type": "SOURCE",
            "marketplace_id": str(source["marketplace_id"]),
            "source_key": source_key,
            "label": str(source.get("label") or "Advertising data"),
        },
        recommendation={
            "action_type": "INSPECT_DATA",
            "action_class": "INVESTIGATE",
            "title": "Restore trustworthy advertising evidence",
            "rationale": reason,
            "parameters": {"source_key": source_key, "state": state},
        },
        materiality={
            "type": "OBSERVED_EXPOSURE",
            "currency": window["currency"],
            "amount": 0,
            "low": None,
            "high": None,
            "basis": "Data blocker; no monetary impact is claimed while governing facts are untrusted.",
        },
        confidence={
            "band": "HIGH",
            "basis": "DETERMINISTIC_SOURCE_CONTRACT",
            "reasons": ["The source or reconciliation contract explicitly reports an untrusted state."],
        },
        window=window,
        evidence=[
            {
                "fact": "data_health.source_state",
                "value": state,
                "unit": "STATE",
                "basis": "Canonical source and reconciliation state",
                "source": source_key,
                "window": window["id"],
                "cutoff": cutoff,
            }
        ],
        conditions=[condition],
        guardrails=["Dependent advertising recommendations remain withheld until this blocker clears."],
        destination={"route": "/data-health", "view": "advertising"},
        now=now,
    )


def _product_conditions(row: Mapping[str, Any], *, required_mature: int) -> list[dict[str, Any]]:
    current_offer = bool(row.get("is_offer_owner"))
    trusted = bool(row.get("ads_trusted"))
    observed = _integer(row.get("observed_ads_days"))
    mature = _integer(row.get("mature_ads_days"))
    conditions = [
        _condition(
            domain="PRODUCT",
            code="CURRENT_COMMERCIAL_OWNER" if current_offer else "NON_CURRENT_OWNER",
            resolution="ALLOW" if current_offer else "SUPPRESS",
            rule_key="CANONICAL_OFFER_OWNER_V1",
            reason=(
                "The subject is the canonical current commercial offer."
                if current_offer
                else "A deleted, aliased, structural-parent, or non-current offer cannot receive an action."
            ),
            operands=[
                {"fact": "product.is_offer_owner", "value": current_offer},
                {"fact": "product.catalog_membership", "value": row.get("catalog_membership")},
            ],
        ),
        _condition(
            domain="ADVERTISING",
            code="WINDOW_TRUSTED" if trusted else "WINDOW_UNTRUSTED",
            resolution="ALLOW" if trusted else "BLOCK_DOMAIN",
            rule_key="ADS_SOURCE_TRUST_V1",
            reason=(
                "The advertising window passes source reconciliation."
                if trusted
                else "The advertising window does not pass source reconciliation."
            ),
            operands=[{"fact": "ads.window_trusted", "value": trusted}],
        ),
        _condition(
            domain="ADVERTISING",
            code="ATTRIBUTION_FINAL" if mature >= required_mature else "ATTRIBUTION_IMMATURE",
            resolution="ALLOW" if mature >= required_mature else "SUPPRESS",
            rule_key="ADS_ATTRIBUTION_FINALITY_V1",
            reason=(
                "Every eligible attribution day in the observed window is mature."
                if mature >= required_mature
                else "Recent attributed response can still restate."
            ),
            operands=[
                {"fact": "ads.observed_days", "value": observed},
                {"fact": "ads.mature_days", "value": mature},
                {"fact": "ads.required_mature_days", "value": required_mature},
            ],
        ),
        _condition(
            domain="ADVERTISING",
            code=(
                "OBSERVATION_WINDOW_SUFFICIENT"
                if observed >= MIN_PRODUCT_OBSERVED_DAYS
                else "INSUFFICIENT_OBSERVED_DAYS"
            ),
            resolution="ALLOW" if observed >= MIN_PRODUCT_OBSERVED_DAYS else "SUPPRESS",
            rule_key="ADS_PRODUCT_OBSERVATION_V1",
            reason=(
                "The product has enough observed advertising days for this diagnostic."
                if observed >= MIN_PRODUCT_OBSERVED_DAYS
                else f"Only {observed} of {MIN_PRODUCT_OBSERVED_DAYS} required observed days are available."
            ),
            operands=[
                {"fact": "ads.observed_days", "value": observed},
                {"fact": "ads.minimum_observed_days", "value": MIN_PRODUCT_OBSERVED_DAYS},
            ],
        ),
    ]
    return conditions


def inventory_conflict_candidate(
    row: Mapping[str, Any], window_values: Mapping[str, Any], *, now: datetime
) -> DecisionCandidate | None:
    window = _window(window_values)
    action = str(row.get("inventory_action") or "").upper()
    spend = _number(row.get("spend"))
    if action not in CONSTRAINED_INVENTORY_ACTIONS or spend <= 0:
        return None
    observed = _integer(row.get("observed_ads_days"))
    lookback = max(0, _integer(row.get("attribution_lookback_days") or 7))
    required_mature = max(0, observed - lookback)
    conditions = _product_conditions(row, required_mature=required_mature)
    conditions.append(
        _condition(
            domain="INVENTORY",
            code=f"ACTION_{action}",
            resolution="ALLOW",
            rule_key="INVENTORY_ACTION_V1",
            reason=f"Inventory currently assigns {action.lower()} to this offer.",
            operands=[
                {"fact": "inventory.action", "value": action},
                {"fact": "inventory.available", "value": row.get("available")},
                {"fact": "inventory.inbound", "value": row.get("inbound")},
                {"fact": "inventory.days_cover_with_inbound", "value": row.get("days_cover_with_inbound")},
            ],
        )
    )
    confidence = "HIGH" if all(item["resolution"] == "ALLOW" for item in conditions) else "LOW"
    cutoff = window["cutoff"]
    observed_at = _source_cutoff(row, "evaluation_captured_at", cutoff)
    inventory_cutoff = _source_cutoff(row, "inventory_snapshot_at", observed_at)
    label = str(row.get("product") or row.get("title") or row.get("sku") or row.get("asin"))
    return _candidate(
        kind="ADS_INVENTORY_CONFLICT",
        lane="PROTECT",
        subject={
            "type": "PRODUCT",
            "marketplace_id": str(row["marketplace_id"]),
            "sku": str(row.get("sku") or ""),
            "asin": str(row.get("asin") or ""),
            "label": label,
        },
        recommendation={
            "action_type": "REVIEW_EXPOSURE_AND_REPLENISHMENT",
            "action_class": "INVESTIGATE",
            "title": f"Protect constrained inventory for {label}",
            "rationale": (
                f"Paid support overlaps an Inventory {action.lower()} state. Review replenishment and campaign intent; "
                "this does not prescribe a bid, budget, or pause change."
            ),
            "parameters": {"inventory_action": action},
        },
        materiality={
            "type": "OBSERVED_EXPOSURE",
            "currency": window["currency"],
            "amount": spend,
            "low": None,
            "high": None,
            "basis": "Finalized Amazon Ads spend overlapping the current Inventory constraint; not lost profit.",
        },
        confidence={
            "band": confidence,
            "basis": "DETERMINISTIC_CROSS_DOMAIN_EVIDENCE",
            "reasons": ["Confidence falls when source trust, offer ownership, or attribution finality is incomplete."],
        },
        window=window,
        evidence=[
            {"fact": "ads.product.spend", "value": spend, "unit": window["currency"], "basis": "Amazon Ads product allocation", "source": "mart.ads_product_business_t28", "window": window["id"], "cutoff": cutoff},
            {"fact": "inventory.action", "value": action, "unit": "STATE", "basis": "Current inventory planning state", "source": "mart.inventory_attention", "window": "CURRENT_INVENTORY_SNAPSHOT", "cutoff": inventory_cutoff},
        ],
        conditions=conditions,
        guardrails=["Do not recommend increasing paid support while Inventory is constrained."],
        destination={"route": "/ads", "view": "decisions", "sku": row.get("sku")},
        now=now,
    )


def product_conversion_gap_candidate(
    row: Mapping[str, Any], window_values: Mapping[str, Any], *, now: datetime
) -> DecisionCandidate | None:
    window = _window(window_values)
    clicks = _integer(row.get("clicks"))
    purchases = _integer(row.get("attributed_purchases") or row.get("purchases"))
    spend = _number(row.get("spend"))
    if clicks < MIN_SIGNAL_CLICKS or purchases != 0 or spend <= 0:
        return None
    observed = _integer(row.get("observed_ads_days"))
    lookback = max(0, _integer(row.get("attribution_lookback_days") or 7))
    required_mature = max(0, observed - lookback)
    conditions = _product_conditions(row, required_mature=required_mature)
    has_traffic_context = row.get("sessions_t28") is not None and row.get("traffic_updated_at") is not None
    has_listing_context = bool(str(row.get("status") or "").strip()) and row.get("listing_fetched_at") is not None
    has_product_context = has_traffic_context and has_listing_context
    conditions.append(
        _condition(
            domain="PRODUCT",
            code="PRODUCT_CONTEXT_AVAILABLE" if has_product_context else "PRODUCT_CONTEXT_MISSING",
            resolution="ALLOW" if has_product_context else "SUPPRESS",
            rule_key="PRODUCT_CONTEXT_V1",
            reason=(
                "Product traffic and current listing state are available."
                if has_product_context
                else "Product traffic or current listing state is unavailable, so the conversion diagnosis is incomplete."
            ),
            operands=[
                {"fact": "product.sessions.available", "value": has_traffic_context},
                {"fact": "product.listing_status.available", "value": has_listing_context},
            ],
        )
    )
    confidence = "HIGH" if all(item["resolution"] == "ALLOW" for item in conditions) else "LOW"
    cutoff = window["cutoff"]
    observed_at = _source_cutoff(row, "evaluation_captured_at", cutoff)
    traffic_cutoff = _source_cutoff(row, "traffic_updated_at", observed_at)
    listing_cutoff = _source_cutoff(row, "listing_fetched_at", observed_at)
    label = str(row.get("product") or row.get("title") or row.get("sku") or row.get("asin"))
    return _candidate(
        kind="ADS_PRODUCT_CONVERSION_GAP",
        lane="ELIMINATE",
        subject={
            "type": "PRODUCT",
            "marketplace_id": str(row["marketplace_id"]),
            "sku": str(row.get("sku") or ""),
            "asin": str(row.get("asin") or ""),
            "label": label,
        },
        recommendation={
            "action_type": "INVESTIGATE_PRODUCT_CONVERSION",
            "action_class": "INVESTIGATE",
            "title": f"Investigate paid-traffic conversion for {label}",
            "rationale": (
                f"Amazon reports {clicks} paid clicks and no attributed purchase. Inspect query fit, listing, price, "
                "offer, delivery, and suppression state before considering an advertising change."
            ),
            "parameters": {},
        },
        materiality={
            "type": "OBSERVED_EXPOSURE",
            "currency": window["currency"],
            "amount": spend,
            "low": None,
            "high": None,
            "basis": "Observed Amazon Ads spend associated with the diagnostic; not contribution loss or incremental sales.",
        },
        confidence={
            "band": confidence,
            "basis": "DETERMINISTIC_ATTRIBUTION_DIAGNOSTIC",
            "reasons": ["Attributed purchases can revise until the declared attribution window is mature."],
        },
        window=window,
        evidence=[
            {"fact": "ads.product.clicks", "value": clicks, "unit": "COUNT", "basis": "Amazon Ads attributed product report", "source": "mart.ads_product_business_t28", "window": window["id"], "cutoff": cutoff},
            {"fact": "ads.product.attributed_purchases", "value": purchases, "unit": "COUNT", "basis": "Amazon-attributed response, not incrementality", "source": "mart.ads_product_business_t28", "window": window["id"], "cutoff": cutoff},
            {"fact": "product.sessions", "value": _integer(row.get("sessions_t28")), "unit": "COUNT", "basis": "Sales and Traffic product sessions", "source": "core.asin_sales_traffic_daily", "window": window["id"], "cutoff": traffic_cutoff},
            {"fact": "product.listing_status", "value": row.get("status"), "unit": "STATE", "basis": "Current seller listing", "source": "core.seller_listing", "window": "CURRENT_LISTING_SNAPSHOT", "cutoff": listing_cutoff},
        ],
        conditions=conditions,
        guardrails=["Do not infer profitability, incrementality, or a bid change from attributed conversion alone."],
        destination={"route": "/ads", "view": "decisions", "sku": row.get("sku")},
        now=now,
    )


def evaluate_product_shadow_candidates(
    rows: list[Mapping[str, Any]], window_values: Mapping[str, Any], *, now: datetime
) -> list[DecisionCandidate]:
    candidates: list[DecisionCandidate] = []
    for row in rows:
        for evaluator in (inventory_conflict_candidate, product_conversion_gap_candidate):
            candidate = evaluator(row, window_values, now=now)
            if candidate is not None:
                candidates.append(candidate)
    return candidates
