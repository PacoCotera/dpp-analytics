from __future__ import annotations

from collections import defaultdict
from hashlib import sha256
import math
import re
from typing import Any, Iterable


WINDOW_DAYS = 28
MIN_SIGNAL_CLICKS = 8
MIN_REPEAT_PURCHASES = 2
MIN_PRODUCT_OBSERVED_DAYS = 14

ECONOMICS_CONTRACT = {
    "state": "UNAVAILABLE",
    "authoritative": False,
    "basis": (
        "Product economics are not yet reconciled for Advertising decisions. "
        "Review contribution in Finance before changing paid support."
    ),
    "missing_inputs": [
        "selling price and IVA basis",
        "Amazon commission and fulfillment fees",
        "current product COGS",
        "returns and refunds",
        "advertising allocation",
    ],
    "prohibited_claims": ["profitable", "scale", "winner", "reduce spend"],
}

INTERPRETATION_RULES = {
    "ADS_PRODUCT_CONVERSION_REVIEW": {
        "key": "ADS_PRODUCT_CONVERSION_REVIEW",
        "version": 1,
        "title": "Product conversion review",
        "eligibility": (
            "The product has at least 14 observed advertising days, its eligible attribution days are mature, "
            "and the reporting window passes reconciliation."
        ),
        "thresholds": {
            "minimum_clicks": MIN_SIGNAL_CLICKS,
            "maximum_attributed_purchases": 0,
            "minimum_observed_days": MIN_PRODUCT_OBSERVED_DAYS,
        },
        "observation_window": {"kind": "rolling", "days": WINDOW_DAYS},
        "attribution_maturity": "All observed days outside the declared attribution lookback must be mature.",
        "required_economic_inputs": [],
        "economic_claims_allowed": False,
        "plain_language": (
            "Enough shoppers clicked to warrant a listing and relevance review, but Amazon reports no attributed purchase."
        ),
        "evidence_fields": ["clicks", "attributed_purchases", "spend", "observed_ads_days", "mature_ads_days"],
    },
    "ADS_PRODUCT_DEMAND_REVIEW": {
        "key": "ADS_PRODUCT_DEMAND_REVIEW",
        "version": 1,
        "title": "Product demand review",
        "eligibility": (
            "The product has at least 14 observed advertising days, its eligible attribution days are mature, "
            "and the reporting window passes reconciliation."
        ),
        "thresholds": {"minimum_attributed_purchases": MIN_REPEAT_PURCHASES},
        "observation_window": {"kind": "rolling", "days": WINDOW_DAYS},
        "attribution_maturity": "All observed days outside the declared attribution lookback must be mature.",
        "required_economic_inputs": [],
        "economic_claims_allowed": False,
        "plain_language": "Repeated attributed purchases justify reviewing the product's converting demand, not a scaling claim.",
        "evidence_fields": ["attributed_purchases", "attributed_sales", "spend", "observed_ads_days", "mature_ads_days"],
    },
    "ADS_DEMAND_TEST": {
        "key": "ADS_DEMAND_TEST",
        "version": 1,
        "title": "Demand test opportunity",
        "eligibility": (
            "The business reporting window is reconciled, its eligible attribution days are mature, and the signal is a "
            "recognizable shopper query, matched product or configured target."
        ),
        "thresholds": {"minimum_attributed_purchases": MIN_REPEAT_PURCHASES},
        "observation_window": {"kind": "rolling", "days": WINDOW_DAYS},
        "attribution_maturity": "At least 21 of 28 days are mature for the current seven-day attribution contract.",
        "required_economic_inputs": [],
        "economic_claims_allowed": False,
        "plain_language": "Repeated attributed purchases make the signal worth a controlled targeting review.",
        "evidence_fields": ["signal", "attributed_purchases", "attributed_sales", "spend", "campaign_id"],
    },
    "ADS_SIGNAL_RELEVANCE_REVIEW": {
        "key": "ADS_SIGNAL_RELEVANCE_REVIEW",
        "version": 1,
        "title": "Demand relevance review",
        "eligibility": "The business reporting window is reconciled and its eligible attribution days are mature.",
        "thresholds": {"minimum_clicks": MIN_SIGNAL_CLICKS, "maximum_attributed_purchases": 0},
        "observation_window": {"kind": "rolling", "days": WINDOW_DAYS},
        "attribution_maturity": "At least 21 of 28 days are mature for the current seven-day attribution contract.",
        "required_economic_inputs": [],
        "economic_claims_allowed": False,
        "plain_language": "Click activity without an attributed purchase warrants a relevance review, not an automatic bid change.",
        "evidence_fields": ["signal", "clicks", "attributed_purchases", "spend", "campaign_id"],
    },
    "ADS_SUPPORTED_MONITOR": {
        "key": "ADS_SUPPORTED_MONITOR",
        "version": 1,
        "title": "Supported product monitoring",
        "eligibility": "The product has advertising spend but no stronger review signal is eligible.",
        "thresholds": {"minimum_spend": 0},
        "observation_window": {"kind": "rolling", "days": WINDOW_DAYS},
        "attribution_maturity": "Maturity is reported with the product and may qualify the monitoring state.",
        "required_economic_inputs": [],
        "economic_claims_allowed": False,
        "plain_language": "Keep the product under observation while attribution matures or evidence remains limited.",
        "evidence_fields": ["spend", "clicks", "attributed_purchases", "observed_ads_days", "mature_ads_days"],
    },
}

_ASIN = re.compile(r"\bB0[A-Z0-9]{8}\b", re.IGNORECASE)


def _number(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if math.isfinite(number) else 0.0


def safe_ratio(numerator: Any, denominator: Any) -> float | None:
    denominator_value = _number(denominator)
    if denominator_value <= 0:
        return None
    return _number(numerator) / denominator_value


def metric_contract(row: dict[str, Any]) -> dict[str, Any]:
    """Return ratios only when their denominator is valid."""
    row = dict(row)
    row["ctr"] = safe_ratio(row.get("clicks"), row.get("impressions"))
    row["cpc"] = safe_ratio(row.get("spend"), row.get("clicks"))
    row["roas"] = safe_ratio(row.get("attributed_sales"), row.get("spend"))
    row["acos"] = safe_ratio(row.get("spend"), row.get("attributed_sales"))
    if "total_business_sales" in row:
        row["tacos"] = safe_ratio(row.get("spend"), row.get("total_business_sales"))
        row["attributed_sales_share"] = safe_ratio(
            row.get("attributed_sales"), row.get("total_business_sales")
        )
    row["conversion_rate"] = safe_ratio(row.get("purchases"), row.get("clicks"))
    return row


def _stable_id(prefix: str, *parts: Any) -> str:
    material = "|".join(str(part or "").strip().lower() for part in parts)
    return f"{prefix}-{sha256(material.encode()).hexdigest()[:14]}"


def _expected_mature_days(observed_days: int, attribution_lookback_days: int) -> int:
    return max(0, observed_days - max(0, attribution_lookback_days))


def product_recommendation(
    row: dict[str, Any], *, trusted: bool, attribution_lookback_days: int = 7
) -> dict[str, Any]:
    observed = int(row.get("observed_ads_days") or 0)
    mature = int(row.get("mature_ads_days") or 0)
    clicks = int(row.get("clicks") or 0)
    purchases = int(row.get("purchases") or 0)
    spend = _number(row.get("spend"))
    required_mature = _expected_mature_days(observed, attribution_lookback_days)
    evidence_ready = bool(
        trusted
        and observed >= MIN_PRODUCT_OBSERVED_DAYS
        and mature >= required_mature
    )
    suppression = None
    if not trusted:
        suppression = "The reporting window has not passed reconciliation."
    elif observed < MIN_PRODUCT_OBSERVED_DAYS:
        suppression = f"Only {observed} of {MIN_PRODUCT_OBSERVED_DAYS} required observed advertising days are available."
    elif mature < required_mature:
        suppression = f"Only {mature} of {required_mature} eligible attribution days are mature."

    if evidence_ready and clicks >= MIN_SIGNAL_CLICKS and purchases == 0:
        state = "NEEDS_ATTENTION"
        rule_key = "ADS_PRODUCT_CONVERSION_REVIEW"
        title = f"Review listing relevance for {row.get('product') or row.get('sku') or 'this product'}"
        explanation = (
            f"Amazon reports {clicks} clicks and no attributed purchase in the current window. "
            "Inspect the listing, query fit and campaign intent before changing bids."
        )
    elif evidence_ready and purchases >= MIN_REPEAT_PURCHASES:
        state = "OPPORTUNITY_TEST"
        rule_key = "ADS_PRODUCT_DEMAND_REVIEW"
        title = f"Review converting demand for {row.get('product') or row.get('sku') or 'this product'}"
        explanation = (
            f"Amazon reports {purchases} attributed purchases. Identify which demand signals are contributing, "
            "then verify product economics before changing support."
        )
    elif spend > 0:
        state = "SUPPORTED_MONITOR"
        rule_key = "ADS_SUPPORTED_MONITOR"
        title = f"Monitor paid support for {row.get('product') or row.get('sku') or 'this product'}"
        explanation = suppression or "Paid support is active without a stronger eligible review signal."
    else:
        state = "NO_CURRENT_ACTION"
        rule_key = "ADS_SUPPORTED_MONITOR"
        title = "No current advertising action"
        explanation = suppression or "No paid support is recorded in the current window."

    rule = INTERPRETATION_RULES[rule_key]
    return {
        "state": state,
        "label": {
            "NEEDS_ATTENTION": "Needs attention",
            "OPPORTUNITY_TEST": "Opportunity to test",
            "SUPPORTED_MONITOR": "Supported / monitor",
            "NO_CURRENT_ACTION": "No current action",
        }[state],
        "title": title,
        "explanation": explanation,
        "rule_key": rule_key,
        "rule_version": rule["version"],
        "eligible": evidence_ready,
        "suppression_reason": suppression,
        "evidence": {
            "spend": row.get("spend"),
            "clicks": clicks,
            "attributed_purchases": purchases,
            "attributed_sales": row.get("attributed_sales"),
            "total_business_sales": row.get("total_business_sales"),
            "tacos": row.get("tacos"),
            "observed_days": observed,
            "mature_days": mature,
        },
    }


def _signal_identity(raw: Any, source: str) -> tuple[str, str, str]:
    value = str(raw or "").strip()
    asin = _ASIN.search(value)
    if asin:
        normalized = asin.group(0).upper()
        return "MATCHED_PRODUCT", "Matched product", normalized
    if source == "search_term":
        return "SHOPPER_QUERY", "Shopper query", value or "Unspecified shopper query"
    return (
        "TARGET",
        "Configured target",
        value or "Configured target (expression unavailable)",
    )


def _plain_match(value: Any) -> str:
    normalized = str(value or "").strip().upper().replace("-", "_")
    labels = {
        "EXACT": "Exact match",
        "PHRASE": "Phrase match",
        "BROAD": "Broad match",
        "CLOSE_MATCH": "Close match",
        "LOOSE_MATCH": "Loose match",
        "SUBSTITUTES": "Substitutes",
        "COMPLEMENTS": "Complements",
        "TARGETING_EXPRESSION": "Product or category targeting",
    }
    return labels.get(normalized, normalized.replace("_", " ").title() if normalized else "Not reported")


def _product_context(product_refs: list[dict[str, Any]]) -> str:
    if not product_refs:
        return "Product association unavailable"
    if len(product_refs) == 1:
        return product_refs[0].get("product") or product_refs[0].get("sku") or "Associated product"
    return f"{len(product_refs)} associated products"


def normalize_demand_signal(
    row: dict[str, Any],
    *,
    source: str,
    product_refs: list[dict[str, Any]],
    trusted: bool,
    mature_days: int,
    observed_days: int,
    attribution_lookback_days: int = 7,
) -> dict[str, Any]:
    raw = (
        row.get("search_term")
        if source == "search_term"
        else row.get("target_expression")
    )
    signal_type, signal_type_label, display = _signal_identity(raw, source)
    signal_id = _stable_id(
        "ads-signal",
        source,
        row.get("account_id"),
        row.get("campaign_id"),
        row.get("target_id"),
        raw,
    )
    result = metric_contract(row)
    result.update(
        {
            "signal_id": signal_id,
            "source_grain": source,
            "signal_type": signal_type,
            "signal_type_label": signal_type_label,
            "signal": display,
            "match_label": _plain_match(row.get("match_type") or row.get("target_type")),
            "product_refs": product_refs,
            "product_context": _product_context(product_refs),
            "technical": {
                "account_id": row.get("account_id"),
                "campaign_id": row.get("campaign_id"),
                "ad_group_id": row.get("ad_group_id"),
                "target_id": row.get("target_id"),
                "raw_value": raw,
                "raw_match_type": row.get("match_type"),
                "raw_target_type": row.get("target_type"),
            },
        }
    )
    required_mature_days = _expected_mature_days(observed_days, attribution_lookback_days)
    maturity_ready = bool(
        trusted
        and observed_days >= WINDOW_DAYS
        and mature_days >= required_mature_days
    )
    purchases = int(result.get("purchases") or 0)
    clicks = int(result.get("clicks") or 0)
    if maturity_ready and purchases >= MIN_REPEAT_PURCHASES:
        state = "OPPORTUNITY_TEST"
        rule_key = "ADS_DEMAND_TEST"
        title = f'Review a dedicated test for “{display}”'
        rationale = (
            f"Amazon reports {purchases} attributed purchases for this {signal_type_label.lower()}. "
            "Confirm product relevance and economics before changing targeting."
        )
    elif maturity_ready and clicks >= MIN_SIGNAL_CLICKS and purchases == 0:
        state = "NEEDS_ATTENTION"
        rule_key = "ADS_SIGNAL_RELEVANCE_REVIEW"
        title = f'Review the relevance of “{display}”'
        rationale = (
            f"Amazon reports {clicks} clicks and no attributed purchase. Inspect the matched product, listing and "
            "campaign intent before changing targeting."
        )
    else:
        state = "SUPPORTED_MONITOR" if _number(result.get("spend")) > 0 else "NO_CURRENT_ACTION"
        rule_key = "ADS_SUPPORTED_MONITOR"
        title = f'Monitor “{display}”'
        rationale = (
            "The current evidence does not meet an eligible review threshold."
            if maturity_ready
            else "The signal remains in learning while attribution or the reporting window matures."
        )
    result["recommendation"] = {
        "state": state,
        "label": {
            "NEEDS_ATTENTION": "Needs attention",
            "OPPORTUNITY_TEST": "Opportunity to test",
            "SUPPORTED_MONITOR": "Supported / monitor",
            "NO_CURRENT_ACTION": "No current action",
        }[state],
        "title": title,
        "explanation": rationale,
        "rule_key": rule_key,
        "rule_version": INTERPRETATION_RULES[rule_key]["version"],
        "eligible": maturity_ready,
        "suppression_reason": (
            None
            if maturity_ready
            else (
                f"Only {mature_days} of {required_mature_days} eligible attribution days are mature."
                if trusted and observed_days >= WINDOW_DAYS
                else "The current decision window is not sufficiently complete."
            )
        ),
        "evidence": {
            "observed_days": observed_days,
            "mature_days": mature_days,
            "required_mature_days": required_mature_days,
            "attribution_lookback_days": attribution_lookback_days,
        },
    }
    return result


def product_reference_index(
    products: list[dict[str, Any]], associations: Iterable[dict[str, Any]]
) -> dict[tuple[str, str, str], list[dict[str, Any]]]:
    by_sku = {str(row.get("sku") or ""): row for row in products if row.get("sku")}
    by_asin = {str(row.get("asin") or ""): row for row in products if row.get("asin")}
    grouped: dict[tuple[str, str, str], dict[str, dict[str, Any]]] = defaultdict(dict)
    for association in associations:
        product = by_sku.get(str(association.get("sku") or "")) or by_asin.get(
            str(association.get("asin") or "")
        )
        if not product:
            continue
        reference = {
            "sku": product.get("sku"),
            "asin": product.get("asin"),
            "product": product.get("product"),
            "image_url": product.get("image_url"),
            "url": f"/product?sku={product.get('sku')}" if product.get("sku") else None,
        }
        account = str(association.get("account_id") or "")
        campaign = str(association.get("campaign_id") or "")
        ad_group = str(association.get("ad_group_id") or "")
        grouped[(account, campaign, ad_group)][str(reference.get("sku") or reference.get("asin"))] = reference
        grouped[(account, campaign, "")][str(reference.get("sku") or reference.get("asin"))] = reference
    return {key: sorted(values.values(), key=lambda item: str(item.get("product") or item.get("sku"))) for key, values in grouped.items()}


def refs_for_row(
    row: dict[str, Any], index: dict[tuple[str, str, str], list[dict[str, Any]]]
) -> list[dict[str, Any]]:
    exact = (
        str(row.get("account_id") or ""),
        str(row.get("campaign_id") or ""),
        str(row.get("ad_group_id") or ""),
    )
    fallback = (exact[0], exact[1], "")
    return list(index.get(exact) or index.get(fallback) or [])


def enrich_products(
    products: list[dict[str, Any]], *, trusted: bool, attribution_lookback_days: int
) -> list[dict[str, Any]]:
    result = []
    for product in products:
        row = metric_contract(product)
        row["recommendation"] = product_recommendation(
            row,
            trusted=trusted,
            attribution_lookback_days=attribution_lookback_days,
        )
        row["economics"] = ECONOMICS_CONTRACT
        result.append(row)
    state_order = {"NEEDS_ATTENTION": 0, "OPPORTUNITY_TEST": 1, "SUPPORTED_MONITOR": 2, "NO_CURRENT_ACTION": 3}
    return sorted(
        result,
        key=lambda row: (
            state_order.get(row["recommendation"]["state"], 9),
            -_number(row.get("spend")),
            str(row.get("product") or row.get("sku") or ""),
        ),
    )


def _action_from_product(product: dict[str, Any]) -> dict[str, Any]:
    recommendation = product["recommendation"]
    action_id = _stable_id("ads-action", recommendation["rule_key"], product.get("sku"))
    return {
        "id": action_id,
        "action_type": "PRODUCT_REVIEW",
        "lane": "PRODUCT",
        "rule_key": recommendation["rule_key"],
        "rule_version": recommendation["rule_version"],
        "state": recommendation["state"],
        "label": recommendation["label"],
        "product": product.get("product"),
        "image_url": product.get("image_url"),
        "sku": product.get("sku"),
        "asin": product.get("asin"),
        "title": recommendation["title"],
        "rationale": recommendation["explanation"],
        "metrics": recommendation["evidence"],
        "observation_window": {"days": WINDOW_DAYS, "start": product.get("period_start"), "end": product.get("through_date")},
        "maturity": {
            "observed_days": product.get("observed_ads_days"),
            "mature_days": product.get("mature_ads_days"),
            "ready": recommendation["eligible"],
        },
        "magnitude": {"spend": product.get("spend"), "attributed_sales": product.get("attributed_sales"), "total_business_sales": product.get("total_business_sales")},
        "review_steps": [
            "Review the product's traffic and attributed conversion.",
            "Inspect the demand signals and campaign intent supporting this SKU.",
            "Confirm product economics in Finance before changing paid support.",
        ],
        "destination": {
            "view": "products",
            "sku": product.get("sku"),
            "action": action_id,
            "filter": recommendation["state"].lower(),
        },
        "technical": {"asin": product.get("asin")},
        "qualification": recommendation.get("suppression_reason") or ECONOMICS_CONTRACT["basis"],
    }


def _action_from_signal(signal: dict[str, Any]) -> dict[str, Any]:
    recommendation = signal["recommendation"]
    refs = signal.get("product_refs") or []
    primary = refs[0] if len(refs) == 1 else {}
    action_type = "DEMAND_TEST" if recommendation["state"] == "OPPORTUNITY_TEST" else "DEMAND_RELEVANCE_REVIEW"
    action_id = _stable_id("ads-action", recommendation["rule_key"], signal.get("signal_id"))
    return {
        "id": action_id,
        "action_type": action_type,
        "lane": "DEMAND_OPPORTUNITY" if action_type == "DEMAND_TEST" else "NON_CONVERTING_DEMAND",
        "rule_key": recommendation["rule_key"],
        "rule_version": recommendation["rule_version"],
        "state": recommendation["state"],
        "label": recommendation["label"],
        "product": primary.get("product") or signal.get("product_context"),
        "image_url": primary.get("image_url"),
        "sku": primary.get("sku"),
        "asin": primary.get("asin"),
        "title": recommendation["title"],
        "rationale": recommendation["explanation"],
        "metrics": {key: signal.get(key) for key in ("spend", "clicks", "purchases", "attributed_sales", "roas", "acos")},
        "observation_window": {"days": WINDOW_DAYS},
        "maturity": {
            "ready": recommendation["eligible"],
            **recommendation.get("evidence", {}),
        },
        "magnitude": {"spend": signal.get("spend"), "attributed_sales": signal.get("attributed_sales")},
        "review_steps": [
            "Review the associated product and listing relevance.",
            "Inspect the campaign and signal history.",
            "Run a controlled test only after confirming product economics.",
        ],
        "destination": {
            "view": "demand",
            "signal": signal.get("signal_id"),
            "sku": primary.get("sku"),
            "campaign": signal.get("campaign_id"),
            "action": action_id,
            "filter": recommendation["state"].lower(),
        },
        "technical": signal.get("technical"),
        "qualification": ECONOMICS_CONTRACT["basis"],
    }


def build_action_groups(
    products: list[dict[str, Any]], demand_signals: list[dict[str, Any]], *, maximum: int = 8
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    product_actions = [
        _action_from_product(row)
        for row in products
        if row.get("recommendation", {}).get("state") in {"NEEDS_ATTENTION", "OPPORTUNITY_TEST"}
    ]
    demand_opportunities = [
        _action_from_signal(row)
        for row in demand_signals
        if row.get("recommendation", {}).get("state") == "OPPORTUNITY_TEST"
    ]
    non_converting = [
        _action_from_signal(row)
        for row in demand_signals
        if row.get("recommendation", {}).get("state") == "NEEDS_ATTENTION"
    ]
    watch = []
    for row in products:
        if row.get("recommendation", {}).get("state") != "SUPPORTED_MONITOR":
            continue
        action = _action_from_product(row)
        action["lane"] = "WATCH"
        watch.append(action)
    for lane in (product_actions, demand_opportunities, non_converting, watch):
        lane.sort(key=lambda action: -_number(action.get("magnitude", {}).get("spend")))

    lane_definitions = [
        ("PRODUCT", "Products requiring review", product_actions, 2),
        ("DEMAND_OPPORTUNITY", "Demand opportunities to test", demand_opportunities, 2),
        ("NON_CONVERTING_DEMAND", "Non-converting demand to inspect", non_converting, 2),
        ("WATCH", "Learning and monitoring", watch, 1),
    ]
    selected: list[dict[str, Any]] = []
    groups: list[dict[str, Any]] = []
    for key, label, lane, allocation in lane_definitions:
        allocated = lane[:allocation]
        selected.extend(allocated)
        groups.append({"key": key, "label": label, "total": len(lane), "actions": allocated})
    if len(selected) < maximum:
        seen = {action["id"] for action in selected}
        remainder = [action for _, _, lane, _ in lane_definitions for action in lane if action["id"] not in seen]
        remainder.sort(key=lambda action: -_number(action.get("magnitude", {}).get("spend")))
        selected.extend(remainder[: maximum - len(selected)])
    selected = selected[:maximum]
    selected_ids = {action["id"] for action in selected}
    for group in groups:
        group["actions"] = [action for action in selected if action["lane"] == group["key"]]
        group["shown"] = len(group["actions"])
    return selected, groups


def demand_page(
    signals: list[dict[str, Any]], query: dict[str, Any] | None = None, *, page_size: int = 20
) -> dict[str, Any]:
    query = query or {}
    value = lambda key: str(query.get(key) or "").strip()
    selected = list(signals)
    sku = value("sku")
    campaign = value("campaign")
    signal_id = value("signal")
    state_filter = value("filter").upper()
    signal_type = value("signal_type").upper()
    search = value("q").casefold()
    if sku:
        selected = [row for row in selected if any(str(ref.get("sku") or "") == sku for ref in row.get("product_refs") or [])]
    if campaign:
        selected = [row for row in selected if str(row.get("campaign_id") or "") == campaign]
    if signal_id:
        selected = [row for row in selected if row.get("signal_id") == signal_id]
    if state_filter in {"NEEDS_ATTENTION", "OPPORTUNITY_TEST", "SUPPORTED_MONITOR", "NO_CURRENT_ACTION"}:
        selected = [row for row in selected if row.get("recommendation", {}).get("state") == state_filter]
    if signal_type in {"SHOPPER_QUERY", "MATCHED_PRODUCT", "TARGET"}:
        selected = [row for row in selected if row.get("signal_type") == signal_type]
    if search:
        selected = [
            row
            for row in selected
            if search
            in " ".join(
                str(value or "")
                for value in (
                    row.get("signal"),
                    row.get("product_context"),
                    row.get("campaign_name"),
                    row.get("match_label"),
                )
            ).casefold()
        ]
    sort = value("sort") or "decision"
    state_order = {"NEEDS_ATTENTION": 0, "OPPORTUNITY_TEST": 1, "SUPPORTED_MONITOR": 2, "NO_CURRENT_ACTION": 3}
    if sort == "spend-desc":
        selected.sort(key=lambda row: (-_number(row.get("spend")), str(row.get("signal") or "")))
    elif sort == "sales-desc":
        selected.sort(key=lambda row: (-_number(row.get("attributed_sales")), str(row.get("signal") or "")))
    elif sort == "purchases-desc":
        selected.sort(key=lambda row: (-_number(row.get("purchases")), -_number(row.get("spend"))))
    else:
        sort = "decision"
        selected.sort(
            key=lambda row: (
                state_order.get(row.get("recommendation", {}).get("state"), 9),
                -_number(row.get("spend")),
                str(row.get("signal") or ""),
            )
        )
    page_size = max(5, min(int(page_size), 50))
    page_count = max(1, math.ceil(len(selected) / page_size))
    try:
        page = int(value("page") or 1)
    except ValueError:
        page = 1
    page = max(1, min(page, page_count))
    start = (page - 1) * page_size
    return {
        "items": selected[start : start + page_size],
        "total": len(selected),
        "page": page,
        "page_size": page_size,
        "page_count": page_count,
        "sort": sort,
        "filters": {
            "sku": sku or None,
            "campaign": campaign or None,
            "signal": signal_id or None,
            "state": state_filter if state_filter else None,
            "signal_type": signal_type if signal_type else None,
            "q": value("q") or None,
        },
    }
