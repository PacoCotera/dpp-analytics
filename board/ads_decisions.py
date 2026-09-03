from __future__ import annotations

from collections import defaultdict
from hashlib import sha256
import math
import re
import unicodedata
from typing import Any, Iterable


WINDOW_DAYS = 28
MIN_SIGNAL_CLICKS = 8
MIN_REPEAT_PURCHASES = 2
MIN_PRODUCT_OBSERVED_DAYS = 14
SEARCH_QUERY_LIMIT = 8
SEARCH_QUERY_MIN_IMPRESSIONS = 100
SEARCH_QUERY_MIN_CLICKS = 8
SEARCH_QUERY_MIN_CART_ADDS = 3
SEARCH_QUERY_MIN_VOLUME = 1000
SEARCH_QUERY_MAX_VISIBILITY_SHARE = 0.01
SEARCH_QUERY_RATE_RATIO = 0.75
SEARCH_QUERY_SCENARIO_LOW = 0.25
SEARCH_QUERY_SCENARIO_HIGH = 0.50

SEARCH_OPPORTUNITY_RULES = {
    "SQP_PURCHASE_GAP": {
        "key": "SQP_PURCHASE_GAP",
        "version": 1,
        "label": "Purchase gap",
        "minimum_evidence": {"asin_cart_adds": SEARCH_QUERY_MIN_CART_ADDS},
        "comparison": "ASIN purchases per cart add are below 75% of the Amazon-wide query rate.",
        "review": "Review offer availability, price, delivery promise and purchase friction.",
    },
    "SQP_CART_GAP": {
        "key": "SQP_CART_GAP",
        "version": 1,
        "label": "Cart gap",
        "minimum_evidence": {"asin_clicks": SEARCH_QUERY_MIN_CLICKS},
        "comparison": "ASIN cart adds per click are below 75% of the Amazon-wide query rate.",
        "review": "Review product-page fit, value communication, price and query promise.",
    },
    "SQP_CLICK_GAP": {
        "key": "SQP_CLICK_GAP",
        "version": 1,
        "label": "Click gap",
        "minimum_evidence": {"asin_impressions": SEARCH_QUERY_MIN_IMPRESSIONS},
        "comparison": "ASIN clicks per impression are below 75% of the Amazon-wide query rate.",
        "review": "Review title, main image, price and delivery promise for this query.",
    },
    "SQP_VISIBILITY_REVIEW": {
        "key": "SQP_VISIBILITY_REVIEW",
        "version": 1,
        "label": "Visibility review",
        "minimum_evidence": {
            "search_query_volume": SEARCH_QUERY_MIN_VOLUME,
            "total_query_impressions": SEARCH_QUERY_MIN_VOLUME,
        },
        "comparison": "ASIN impression share is below 1% for a query with meaningful demand.",
        "review": "Check relevance and indexing, then consider a controlled paid-search test if the query fits.",
    },
}

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
    "ADS_INVENTORY_EXPOSURE_REVIEW": {
        "key": "ADS_INVENTORY_EXPOSURE_REVIEW",
        "version": 1,
        "title": "Paid-support inventory review",
        "eligibility": (
            "The record is a current commercial offer, Inventory has assigned STOCKOUT, PRODUCE or PLAN, "
            "paid support is active, and the reporting window passes reconciliation and attribution maturity."
        ),
        "thresholds": {
            "inventory_actions": ["STOCKOUT", "PRODUCE", "PLAN"],
            "minimum_spend_exclusive": 0,
            "minimum_observed_days": MIN_PRODUCT_OBSERVED_DAYS,
        },
        "observation_window": {"kind": "rolling", "days": WINDOW_DAYS},
        "attribution_maturity": "All observed days outside the declared attribution lookback must be mature.",
        "required_economic_inputs": [],
        "economic_claims_allowed": False,
        "plain_language": (
            "Active paid support and a current inventory constraint require a fulfillment-readiness review. "
            "The rule does not prescribe a bid, budget, pause or spend change."
        ),
        "evidence_fields": [
            "inventory_action",
            "available",
            "inbound",
            "days_cover_with_inbound",
            "spend",
            "observed_ads_days",
            "mature_ads_days",
        ],
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


def normalize_search_query_key(value: Any) -> str:
    """Match the canonical Brand Analytics query-key contract."""
    normalized = unicodedata.normalize("NFKC", str(value or ""))
    return " ".join(normalized.split()).casefold()


def paid_support_by_query(rows: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Aggregate exact same-month Ads evidence without assigning it to an ASIN."""
    grouped: dict[str, dict[str, Any]] = {}
    for row in rows:
        key = normalize_search_query_key(row.get("search_term"))
        if not key:
            continue
        item = grouped.setdefault(
            key,
            {
                "exact_query_match": True,
                "spend": 0.0,
                "clicks": 0,
                "attributed_purchases": 0,
                "attributed_sales": 0.0,
                "campaign_ids": set(),
            },
        )
        item["spend"] += _number(row.get("spend"))
        item["clicks"] += int(row.get("clicks") or 0)
        item["attributed_purchases"] += int(row.get("purchases") or 0)
        item["attributed_sales"] += _number(row.get("attributed_sales"))
        if row.get("campaign_id"):
            item["campaign_ids"].add(str(row["campaign_id"]))
    for item in grouped.values():
        item["campaign_count"] = len(item.pop("campaign_ids"))
        item["basis"] = (
            "Exact normalized query in Amazon Ads for the same calendar month. "
            "This evidence is query-level and is not assigned to the selected ASIN."
        )
    return grouped


def _search_confidence(evidence: int, minimum: int) -> dict[str, str]:
    if evidence >= minimum * 4:
        return {"state": "HIGH", "label": "High evidence"}
    if evidence >= minimum * 2:
        return {"state": "MEDIUM", "label": "Moderate evidence"}
    return {"state": "LOW", "label": "Directional"}


def _scenario_range(full_gap_purchases: float) -> dict[str, Any]:
    full_gap = max(0.0, full_gap_purchases)
    return {
        "metric": "additional_purchases",
        "low": round(full_gap * SEARCH_QUERY_SCENARIO_LOW, 2),
        "high": round(full_gap * SEARCH_QUERY_SCENARIO_HIGH, 2),
        "low_gap_closure": SEARCH_QUERY_SCENARIO_LOW,
        "high_gap_closure": SEARCH_QUERY_SCENARIO_HIGH,
        "basis": (
            "Arithmetic sensitivity if 25% to 50% of the measured gap closes while the query's "
            "Amazon-wide downstream rates hold. This is a scenario, not a forecast or causal lift estimate."
        ),
    }


def search_query_opportunity(
    row: dict[str, Any], paid_support: dict[str, Any] | None = None
) -> dict[str, Any] | None:
    """Convert one ASIN/query funnel into one bounded operational review."""
    total_impressions = int(row.get("total_query_impression_count") or 0)
    asin_impressions = int(row.get("asin_impression_count") or 0)
    total_clicks = int(row.get("total_click_count") or 0)
    asin_clicks = int(row.get("asin_click_count") or 0)
    total_carts = int(row.get("total_cart_add_count") or 0)
    asin_carts = int(row.get("asin_cart_add_count") or 0)
    total_purchases = int(row.get("total_purchase_count") or 0)
    asin_purchases = int(row.get("asin_purchase_count") or 0)
    volume = int(row.get("search_query_volume") or 0)
    impression_share = _number(row.get("asin_impression_share"))

    market_click_rate = safe_ratio(total_clicks, total_impressions)
    asin_click_rate = safe_ratio(asin_clicks, asin_impressions)
    market_cart_rate = safe_ratio(total_carts, total_clicks)
    asin_cart_rate = safe_ratio(asin_carts, asin_clicks)
    market_purchase_rate = safe_ratio(total_purchases, total_carts)
    asin_purchase_rate = safe_ratio(asin_purchases, asin_carts)

    rule_key = None
    evidence_count = 0
    minimum = 1
    full_gap_purchases = 0.0
    market_rate = None
    asin_rate = None
    evidence_label = ""

    if (
        asin_carts >= SEARCH_QUERY_MIN_CART_ADDS
        and market_purchase_rate is not None
        and asin_purchase_rate is not None
        and asin_purchase_rate < market_purchase_rate * SEARCH_QUERY_RATE_RATIO
    ):
        rule_key = "SQP_PURCHASE_GAP"
        evidence_count = asin_carts
        minimum = SEARCH_QUERY_MIN_CART_ADDS
        market_rate = market_purchase_rate
        asin_rate = asin_purchase_rate
        evidence_label = "ASIN cart adds"
        full_gap_purchases = asin_carts * (market_purchase_rate - asin_purchase_rate)
    elif (
        asin_clicks >= SEARCH_QUERY_MIN_CLICKS
        and market_cart_rate is not None
        and asin_cart_rate is not None
        and market_cart_rate > 0
        and market_purchase_rate is not None
        and asin_cart_rate < market_cart_rate * SEARCH_QUERY_RATE_RATIO
    ):
        rule_key = "SQP_CART_GAP"
        evidence_count = asin_clicks
        minimum = SEARCH_QUERY_MIN_CLICKS
        market_rate = market_cart_rate
        asin_rate = asin_cart_rate
        evidence_label = "ASIN clicks"
        full_gap_purchases = asin_clicks * (market_cart_rate - asin_cart_rate) * market_purchase_rate
    elif (
        asin_impressions >= SEARCH_QUERY_MIN_IMPRESSIONS
        and market_click_rate is not None
        and asin_click_rate is not None
        and market_click_rate > 0
        and market_cart_rate is not None
        and market_purchase_rate is not None
        and asin_click_rate < market_click_rate * SEARCH_QUERY_RATE_RATIO
    ):
        rule_key = "SQP_CLICK_GAP"
        evidence_count = asin_impressions
        minimum = SEARCH_QUERY_MIN_IMPRESSIONS
        market_rate = market_click_rate
        asin_rate = asin_click_rate
        evidence_label = "ASIN impressions"
        full_gap_purchases = (
            asin_impressions
            * (market_click_rate - asin_click_rate)
            * market_cart_rate
            * market_purchase_rate
        )
    elif (
        volume >= SEARCH_QUERY_MIN_VOLUME
        and total_impressions >= SEARCH_QUERY_MIN_VOLUME
        and impression_share < SEARCH_QUERY_MAX_VISIBILITY_SHARE
        and market_click_rate is not None
        and market_cart_rate is not None
        and market_purchase_rate is not None
    ):
        rule_key = "SQP_VISIBILITY_REVIEW"
        evidence_count = volume
        minimum = SEARCH_QUERY_MIN_VOLUME
        market_rate = SEARCH_QUERY_MAX_VISIBILITY_SHARE
        asin_rate = impression_share
        evidence_label = "query volume"
        full_gap_purchases = (
            total_impressions
            * (SEARCH_QUERY_MAX_VISIBILITY_SHARE - impression_share)
            * market_click_rate
            * market_cart_rate
            * market_purchase_rate
        )
    if not rule_key:
        return None

    rule = SEARCH_OPPORTUNITY_RULES[rule_key]
    query = str(row.get("search_query") or "").strip()
    query_key = str(row.get("search_query_key") or normalize_search_query_key(query))
    paid = paid_support or {
        "exact_query_match": False,
        "spend": 0.0,
        "clicks": 0,
        "attributed_purchases": 0,
        "attributed_sales": 0.0,
        "campaign_count": 0,
        "basis": (
            "No exact normalized query match was found in the available Amazon Ads report for the same month. "
            "This does not prove that paid advertising had no influence."
        ),
    }
    scenario = _scenario_range(full_gap_purchases)
    opportunity = {
        "id": _stable_id("sqp-opportunity", row.get("asin"), query_key, row.get("start_date"), rule_key),
        "rule_key": rule_key,
        "rule_version": rule["version"],
        "stage": rule_key.removeprefix("SQP_").removesuffix("_GAP").removesuffix("_REVIEW"),
        "label": rule["label"],
        "query": query,
        "query_key": query_key,
        "asin": row.get("asin"),
        "sku": row.get("sku"),
        "product": row.get("product") or row.get("sku") or row.get("asin"),
        "image_url": row.get("image_url"),
        "product_url": f"/product?sku={row.get('sku')}" if row.get("sku") else None,
        "diagnosis": rule["comparison"],
        "review": rule["review"],
        "confidence": _search_confidence(evidence_count, minimum),
        "scenario": scenario,
        "evidence": {
            "search_query_volume": volume,
            "evidence_count": evidence_count,
            "evidence_label": evidence_label,
            "asin_rate": asin_rate,
            "query_rate": market_rate,
            "asin_impression_share": impression_share,
            "asin_impressions": asin_impressions,
            "asin_clicks": asin_clicks,
            "asin_cart_adds": asin_carts,
            "asin_purchases": asin_purchases,
        },
        "paid_support": paid,
    }
    depth = {"SQP_PURCHASE_GAP": 3, "SQP_CART_GAP": 2, "SQP_CLICK_GAP": 1, "SQP_VISIBILITY_REVIEW": 0}
    measured_funnel_gap = rule_key != "SQP_VISIBILITY_REVIEW"
    opportunity["rank_score"] = round(
        int(measured_funnel_gap) * 1_000_000_000
        + scenario["high"] * 1_000_000
        + depth[rule_key] * 1_000
        + math.log1p(evidence_count),
        6,
    )
    return opportunity


def build_search_query_opportunities(
    rows: Iterable[dict[str, Any]], paid_rows: Iterable[dict[str, Any]], limit: int = SEARCH_QUERY_LIMIT
) -> list[dict[str, Any]]:
    paid = paid_support_by_query(paid_rows)
    opportunities = []
    for row in rows:
        key = str(row.get("search_query_key") or normalize_search_query_key(row.get("search_query")))
        opportunity = search_query_opportunity(row, paid.get(key))
        if opportunity:
            opportunities.append(opportunity)
    opportunities.sort(key=lambda item: (-item["rank_score"], item["query"], str(item.get("sku") or "")))
    return opportunities[: max(0, limit)]


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
        title = "Review listing relevance"
        explanation = (
            f"Amazon reports {clicks} clicks and no attributed purchase in the current window. "
            "Inspect the listing, query fit and campaign intent before changing bids."
        )
    elif evidence_ready and purchases >= MIN_REPEAT_PURCHASES:
        state = "OPPORTUNITY_TEST"
        rule_key = "ADS_PRODUCT_DEMAND_REVIEW"
        title = "Review converting demand"
        explanation = (
            f"Amazon reports {purchases} attributed purchases. Identify which demand signals are contributing, "
            "then verify product economics before changing support."
        )
    elif spend > 0:
        state = "SUPPORTED_MONITOR"
        rule_key = "ADS_SUPPORTED_MONITOR"
        title = "Monitor paid support"
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


def build_product_action(product: dict[str, Any]) -> dict[str, Any]:
    """Expose the canonical product action for other server-owned workspaces."""
    return _action_from_product(product)


def inventory_exposure_recommendation(
    row: dict[str, Any], *, trusted: bool, attribution_lookback_days: int = 7
) -> dict[str, Any]:
    """Combine API-owned inventory state with mature paid-support evidence.

    This rule requests a review only. It deliberately does not prescribe a bid,
    budget, pause or spend change and does not require profitability evidence.
    """
    action = str(row.get("inventory_action") or row.get("action") or "").upper()
    current_offer = bool(row.get("is_current_offer"))
    spend = _number(row.get("spend") or row.get("ad_spend_t28"))
    observed = int(row.get("observed_ads_days") or row.get("ad_observed_days") or 0)
    mature = int(row.get("mature_ads_days") or row.get("ad_mature_days") or 0)
    required_mature = _expected_mature_days(observed, attribution_lookback_days)
    constrained = action in {"STOCKOUT", "PRODUCE", "PLAN"}
    eligible = bool(
        current_offer
        and constrained
        and spend > 0
        and trusted
        and observed >= MIN_PRODUCT_OBSERVED_DAYS
        and mature >= required_mature
    )
    suppression = None
    if not current_offer:
        suppression = "Only a canonical current offer can enter the inventory decision queue."
    elif not constrained:
        suppression = "Inventory has not assigned a current stockout, production or planning constraint."
    elif spend <= 0:
        suppression = "No paid support is recorded for this offer in the current advertising window."
    elif not trusted:
        suppression = "The advertising reporting window has not passed reconciliation."
    elif observed < MIN_PRODUCT_OBSERVED_DAYS:
        suppression = (
            f"Only {observed} of {MIN_PRODUCT_OBSERVED_DAYS} required observed advertising days are available."
        )
    elif mature < required_mature:
        suppression = f"Only {mature} of {required_mature} eligible attribution days are mature."

    product = row.get("product") or row.get("sku") or "this product"
    rule = INTERPRETATION_RULES["ADS_INVENTORY_EXPOSURE_REVIEW"]
    action_id = _stable_id("ads-inventory-action", rule["key"], row.get("sku"), action)
    return {
        "state": "NEEDS_ATTENTION" if eligible else "NO_CURRENT_ACTION",
        "label": "Review paid support" if eligible else "No paid-support inventory action",
        "title": f"Review paid support while inventory is constrained for {product}",
        "explanation": (
            f"Inventory currently reports {action.lower()} while Amazon Ads records paid support. "
            "Review fulfillment readiness and current campaign intent before making an advertising change."
            if eligible
            else suppression
        ),
        "rule_key": rule["key"],
        "rule_version": rule["version"],
        "eligible": eligible,
        "suppression_reason": suppression,
        "action_id": action_id,
        "evidence": {
            "inventory_action": action,
            "available": row.get("available"),
            "inbound": row.get("inbound"),
            "days_cover_with_inbound": row.get("days_cover_with_inbound"),
            "spend": spend,
            "attributed_sales": row.get("attributed_sales") or row.get("ad_attributed_sales_t28"),
            "tacos": row.get("tacos") or row.get("ad_tacos_t28"),
            "observed_days": observed,
            "mature_days": mature,
        },
        "review_steps": [
            "Confirm available and inbound inventory against the current cover window.",
            "Review the SKU's traffic, attributed conversion and campaign intent.",
            "Make any campaign change only after checking fulfillment readiness and product economics.",
        ],
        "destination": {
            "view": "products",
            "sku": row.get("sku"),
            "action": action_id,
            "filter": "needs_attention",
        },
        "qualification": (
            "This is a fulfillment-readiness review, not a recommendation to pause, reduce, bid or scale."
        ),
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
