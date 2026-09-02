from __future__ import annotations

from datetime import date, datetime


RULES = {
    "BUSINESS_MOMENTUM_V1": {
        "id": "BUSINESS_MOMENTUM_V1",
        "version": 1,
        "name": "28-day business momentum",
        "window": "Latest reconciled 28 days compared with the prior 28 days",
        "inputs": ["delta28_pct", "operating_decisions"],
        "input_labels": {
            "delta28_pct": "28-day shopper-spend change",
            "operating_decisions": "Operating decisions needing attention",
        },
        "thresholds": [
            "Strong: at least 8% above the prior period",
            "Growing: 2% to less than 8% above the prior period",
            "Steady: within 2% of the prior period",
            "Softened: 2% to less than 8% below the prior period",
            "Cooling: at least 8% below the prior period",
        ],
        "eligibility": "A prior 28-day sales denominator must be available.",
    },
    "TODAY_PACE_V1": {
        "id": "TODAY_PACE_V1",
        "version": 1,
        "name": "Same-weekday pace",
        "window": "Live day through the current Mexico City time, or the full selected closed day",
        "inputs": ["is_live", "orders", "pace_vs_same_weekday_pct"],
        "input_labels": {
            "is_live": "Day status",
            "orders": "Orders so far",
            "pace_vs_same_weekday_pct": "Pace versus a typical weekday",
        },
        "thresholds": [
            "Live days with fewer than 3 orders are low-signal",
            "Ahead: at least 15% above the same-weekday pace",
            "Behind: at least 15% below the same-weekday pace",
            "Near typical: within 15% of the same-weekday pace",
        ],
        "eligibility": "Pace requires a comparable same-weekday benchmark; live directional labels also require at least 3 orders.",
    },
    "TODAY_BUSINESS_CONTEXT_V1": {
        "id": "TODAY_BUSINESS_CONTEXT_V1",
        "version": 1,
        "name": "Today broader business context",
        "window": "Month to date and trailing 30 days, each against its prior comparable period",
        "inputs": ["mtd_delta_pct", "last30_delta_pct"],
        "input_labels": {
            "mtd_delta_pct": "Month-to-date change",
            "last30_delta_pct": "Trailing 30-day change",
        },
        "thresholds": [
            "Positive: every available comparison is at least 5% higher",
            "Negative: every available comparison is at least 5% lower",
            "Mixed: at least one comparison is 5% higher and one is 5% lower",
            "Mostly flat: every available comparison is within 5%",
            "Momentum: available comparisons do not meet another state",
        ],
        "eligibility": "At least one comparable-period percentage must be available.",
    },
    "SALES_PRODUCT_CHANGE_V1": {
        "id": "SALES_PRODUCT_CHANGE_V1",
        "version": 1,
        "name": "Product sales direction",
        "window": "Latest reconciled 28 days compared with the prior 28 days",
        "inputs": ["sales_change_t28"],
        "input_labels": {"sales_change_t28": "28-day product-sales change"},
        "thresholds": [
            "Improving: sales increased from the prior period",
            "Flat: sales were unchanged",
            "Weakening: sales decreased from the prior period",
        ],
        "eligibility": "Both 28-day product-sales periods must be available.",
    },
    "SALES_CONCENTRATION_V1": {
        "id": "SALES_CONCENTRATION_V1",
        "version": 1,
        "name": "Top-three product concentration",
        "window": "Latest reconciled 28 days",
        "inputs": ["top_three_share_pct"],
        "input_labels": {"top_three_share_pct": "Top-three product share"},
        "thresholds": [
            "Broad: the top three products contribute 55% or less",
            "Balanced: the top three products contribute between 55% and 75%",
            "Concentrated: the top three products contribute at least 75%",
        ],
        "eligibility": "Total included product sales must be greater than zero.",
    },
    "SALES_BREADTH_V1": {
        "id": "SALES_BREADTH_V1",
        "version": 1,
        "name": "Product movement breadth",
        "window": "Latest reconciled 28 days compared with the prior 28 days",
        "inputs": ["growing", "declining", "stable"],
        "input_labels": {
            "growing": "Growing products",
            "declining": "Declining products",
            "stable": "Stable products",
        },
        "thresholds": [
            "Broad improvement: at least two more products are growing than declining",
            "Broad weakening: at least two more products are declining than growing",
            "Mixed movement: neither side leads by 2 products",
            "Individual growth and decline require an 8% move",
        ],
        "eligibility": "At least one selling product with comparable 28-day sales must be available.",
    },
    "CATALOG_COMMERCIAL_STATE_V1": {
        "id": "CATALOG_COMMERCIAL_STATE_V1",
        "version": 1,
        "name": "Offer commercial state",
        "window": "Latest 28-day catalog demand window",
        "inputs": [
            "listing_status",
            "eligible_exposure_days",
            "inventory_action",
            "sessions_t28",
            "conversion_t28_pct",
            "sales_t28",
            "units_t28",
            "sales_delta28_pct",
            "portfolio_traffic_median_t28",
            "portfolio_conversion_median_t28_pct",
        ],
        "input_labels": {
            "listing_status": "Amazon listing status",
            "eligible_exposure_days": "Eligible demand days",
            "inventory_action": "Inventory action",
            "sessions_t28": "28-day sessions",
            "conversion_t28_pct": "28-day conversion",
            "sales_t28": "28-day shopper spend",
            "units_t28": "28-day units",
            "sales_delta28_pct": "28-day shopper-spend change",
            "portfolio_traffic_median_t28": "Portfolio median sessions",
            "portfolio_conversion_median_t28_pct": "Portfolio median conversion",
        },
        "thresholds": [
            "Learning: fewer than 28 eligible calendar days",
            "Traffic not converting: sessions meet the higher of 20 or 115% of the portfolio median, while conversion is below 72% of the portfolio median",
            "Converts, needs traffic: sessions are no more than the higher of 12 or 65% of the portfolio median, conversion is above 125% of the portfolio median, and units are positive",
            "Dormant: sessions are no more than the higher of 5 or 25% of the portfolio median, with no shopper spend",
            "Accelerating: 28-day shopper spend increased by at least 20%",
            "Declining: 28-day shopper spend decreased by at least 20%",
        ],
        "eligibility": "Demand labels require 28 eligible calendar days from the Amazon listing-open date through the traffic cutoff. Listing and inventory states do not require a complete demand window.",
    },
    "CATALOG_FAMILY_STATE_V1": {
        "id": "CATALOG_FAMILY_STATE_V1",
        "version": 1,
        "name": "Variation-family commercial state",
        "window": "Latest 28-day catalog demand window pooled across current sellable children",
        "inputs": ["active_sellable_count", "eligible_child_count", "child_states", "sessions_t28", "conversion_t28_pct", "units_t28"],
        "input_labels": {
            "active_sellable_count": "Active sellable products",
            "eligible_child_count": "Products with a complete demand window",
            "child_states": "Product states",
            "sessions_t28": "28-day sessions",
            "conversion_t28_pct": "28-day conversion",
            "units_t28": "28-day units",
        },
        "thresholds": [
            "Learning: all active children have fewer than 28 eligible calendar days",
            "Inventory risk: at least one active child is at inventory risk",
            "Funnel thresholds match the offer commercial-state rule",
            "Healthy: family units > 0 without a higher-priority exception",
            "Watch: sessions > 0 and units = 0",
            "Dormant: no meaningful demand signal after eligibility",
        ],
        "eligibility": "At least one active sellable child must have a complete 28-day demand window.",
    },
    "CATALOG_DIMENSION_CONVERSION_V1": {
        "id": "CATALOG_DIMENSION_CONVERSION_V1",
        "version": 1,
        "name": "Catalog dimension conversion comparison",
        "window": "Latest 28-day catalog demand window",
        "inputs": ["conversion_t28_pct", "portfolio_conversion_t28_pct"],
        "input_labels": {
            "conversion_t28_pct": "28-day conversion",
            "portfolio_conversion_t28_pct": "Portfolio conversion",
        },
        "thresholds": [
            "Above portfolio: conversion is at least 120% of the portfolio rate",
            "Below portfolio: conversion is no more than 80% of the portfolio rate",
            "Near portfolio: conversion is between 80% and 120% of the portfolio rate",
        ],
        "eligibility": "The dimension and portfolio must both have a conversion rate.",
    },
    "TRAJECTORY_STRUCTURE_V1": {
        "id": "TRAJECTORY_STRUCTURE_V1",
        "version": 1,
        "name": "Multi-horizon trajectory",
        "window": "7, 28, 56, and 90 reconciled days, each compared with its immediately prior equal window",
        "inputs": ["delta7_pct", "delta28_pct", "delta56_pct", "delta90_pct"],
        "input_labels": {
            "delta7_pct": "7-day change",
            "delta28_pct": "28-day change",
            "delta56_pct": "56-day change",
            "delta90_pct": "90-day change",
        },
        "thresholds": [
            "Structurally stronger: the 28-day change is above 5%, and both the 56- and 90-day changes are above 2%",
            "Structural slowdown: the 28-day change is below −5%, and both the 56- and 90-day changes are below −2%",
            "Short-term acceleration: the 7-day change is above 5% while the 28-day change is below 2%",
            "Recent softness: the 7-day change is below −5% while the 28-day change remains above 2%",
            "Flat: the 28-day change is within 2%",
        ],
        "eligibility": "All four comparison percentages must be available for a structural label.",
    },
}


def rule_catalog(*rule_ids: str) -> dict[str, dict]:
    return {rule_id: dict(RULES[rule_id]) for rule_id in rule_ids}


def _evaluation(rule_id: str, label: str, inputs: dict, *, eligible: bool = True, eligibility: str = "Eligible") -> dict:
    return {
        "rule_id": rule_id,
        "rule_version": RULES[rule_id]["version"],
        "label": label,
        "inputs": inputs,
        "eligible": eligible,
        "eligibility": eligibility,
    }


def business_momentum(delta, operating_decisions=0) -> dict:
    inputs = {"delta28_pct": delta, "operating_decisions": int(operating_decisions or 0)}
    if delta is None:
        return _evaluation("BUSINESS_MOMENTUM_V1", "Momentum unavailable", inputs, eligible=False, eligibility="Prior 28-day sales are unavailable")
    value = float(delta)
    decisions = inputs["operating_decisions"]
    decision_copy = f"{decisions} operating decision{' needs' if decisions == 1 else 's need'} attention." if decisions else ""
    if value >= 8:
        label = "Momentum is strong."
        copy = f"The last four weeks of shopper spend are clearly ahead of the prior four. {decision_copy}" if decisions else "The last four weeks of shopper spend are clearly ahead of the prior four, with nothing requiring immediate attention."
    elif value >= 2:
        label = "The business is growing."
        copy = f"Recent shopper spend is modestly ahead. {decision_copy}" if decisions else "Recent shopper spend is modestly ahead and there are no immediate operating exceptions."
    elif value > -2:
        label = "The business is steady."
        copy = f"Recent shopper spend is essentially flat. {decision_copy}" if decisions else "Recent shopper spend is essentially flat and operations are currently clear."
    elif value > -8:
        label = "Momentum has softened."
        copy = f"The last four weeks of shopper spend are below the prior four. {decisions} operating decision{' also needs' if decisions == 1 else 's also need'} attention." if decisions else "The last four weeks of shopper spend are below the prior four, but no immediate operating exception is flagged."
    else:
        label = "The business is cooling."
        copy = f"Recent shopper spend is meaningfully below the prior four weeks and {decision_copy}" if decisions else "Recent shopper spend is meaningfully below the prior four weeks. Operations themselves are currently clear."
    result = _evaluation("BUSINESS_MOMENTUM_V1", label, inputs)
    result["explanation"] = copy
    return result


def today_pace(is_live, orders, pace, weekday_name="day") -> dict:
    inputs = {"is_live": bool(is_live), "orders": int(orders or 0), "pace_vs_same_weekday_pct": pace}
    if is_live and inputs["orders"] < 3:
        label = "Too early to call today" if inputs["orders"] == 0 else "Today is still low-signal"
        return _evaluation("TODAY_PACE_V1", label, inputs, eligible=False, eligibility=f"{inputs['orders']} of 3 required live orders")
    if pace is None:
        return _evaluation("TODAY_PACE_V1", "Pace unavailable", inputs, eligible=False, eligibility="Comparable same-weekday pace is unavailable")
    value = float(pace)
    if value >= 15:
        label = f"Ahead of a typical {weekday_name}"
    elif value <= -15:
        label = f"Behind a typical {weekday_name}"
    else:
        label = f"Tracking near a typical {weekday_name}"
    return _evaluation("TODAY_PACE_V1", label, inputs)


def today_business_context(mtd_delta, last30_delta) -> dict:
    inputs = {"mtd_delta_pct": mtd_delta, "last30_delta_pct": last30_delta}
    values = [float(value) for value in (mtd_delta, last30_delta) if value is not None]
    if not values:
        return _evaluation("TODAY_BUSINESS_CONTEXT_V1", "Momentum unavailable", inputs, eligible=False, eligibility="No comparable periods are available")
    positive = sum(value >= 5 for value in values)
    negative = sum(value <= -5 for value in values)
    if positive == len(values):
        label = "Positive momentum"
    elif negative == len(values):
        label = "Negative momentum"
    elif positive and negative:
        label = "Mixed momentum"
    elif all(abs(value) < 5 for value in values):
        label = "Mostly flat"
    else:
        label = "Momentum"
    return _evaluation("TODAY_BUSINESS_CONTEXT_V1", label, inputs)


def sales_product_change(change) -> dict:
    inputs = {"sales_change_t28": change}
    if change is None:
        return _evaluation("SALES_PRODUCT_CHANGE_V1", "Unavailable", inputs, eligible=False, eligibility="Comparable product sales are unavailable")
    value = float(change)
    return _evaluation("SALES_PRODUCT_CHANGE_V1", "Improving" if value > 0 else "Weakening" if value < 0 else "Flat", inputs)


def sales_concentration(share) -> dict:
    inputs = {"top_three_share_pct": share}
    if share is None:
        return _evaluation("SALES_CONCENTRATION_V1", "Unavailable", inputs, eligible=False, eligibility="Included product sales are zero")
    value = float(share)
    label = "Concentrated" if value >= 75 else "Broad" if value <= 55 else "Balanced"
    return _evaluation("SALES_CONCENTRATION_V1", label, inputs)


def sales_breadth(growing, declining, stable=0) -> dict:
    inputs = {"growing": int(growing or 0), "declining": int(declining or 0), "stable": int(stable or 0)}
    total = sum(inputs.values())
    if not total:
        return _evaluation("SALES_BREADTH_V1", "Unavailable", inputs, eligible=False, eligibility="No selling products have comparable sales")
    if inputs["growing"] >= inputs["declining"] + 2:
        label = "Broad improvement"
    elif inputs["declining"] >= inputs["growing"] + 2:
        label = "Broad weakening"
    else:
        label = "Mixed movement"
    return _evaluation("SALES_BREADTH_V1", label, inputs)


def eligible_exposure_days(open_date, cutoff) -> int | None:
    def parsed(value):
        if isinstance(value, datetime):
            return value.date()
        if isinstance(value, date):
            return value
        if value:
            try:
                return date.fromisoformat(str(value)[:10])
            except ValueError:
                return None
        return None

    start, end = parsed(open_date), parsed(cutoff)
    if not start or not end:
        return None
    return max(0, (end - start).days + 1)


def catalog_offer_state(row: dict, traffic_median: float, conversion_median: float, cutoff) -> tuple[str, str, dict]:
    base_inputs = {
        "listing_status": row.get("status"),
        "eligible_exposure_days": eligible_exposure_days(row.get("open_date"), cutoff),
        "inventory_action": row.get("inventory_action"),
        "sessions_t28": row.get("sessions_t28"),
        "conversion_t28_pct": row.get("conversion_t28_pct"),
        "sales_t28": row.get("sales_t28"),
        "units_t28": row.get("units_t28"),
        "sales_delta28_pct": row.get("sales_delta28_pct"),
        "portfolio_traffic_median_t28": round(float(traffic_median or 0), 1),
        "portfolio_conversion_median_t28_pct": round(float(conversion_median or 0), 2),
    }

    def done(state, label, explanation, *, eligible=True, eligibility="Eligible"):
        return state, explanation, _evaluation("CATALOG_COMMERCIAL_STATE_V1", label, base_inputs, eligible=eligible, eligibility=eligibility)

    if row.get("catalog_membership") == "DELETED":
        return done("DELETED", "Deleted", "Absent from the latest Amazon seller-catalog snapshot")
    role = row.get("product_role")
    if role == "STRUCTURAL_PARENT":
        return done("STRUCTURAL_PARENT", "Parent container", "Variation container · family metrics come from sellable children")
    if role == "SELLER_SKU_ALIAS":
        owner = row.get("offer_owner_sku") or "canonical offer"
        return done("SKU_ALIAS", "SKU alias", f"Operational SKU alias · demand belongs to {owner}")
    active = role in {"SELLABLE_VARIATION", "SELLABLE_STANDALONE"} and str(row.get("status") or "").strip().lower() == "active" and row.get("catalog_membership") in {None, "CURRENT_OFFER"}
    if not active:
        source_status = str(row.get("status") or "").strip()
        state = {"inactive": "INACTIVE", "closed": "CLOSED", "incomplete": "INCOMPLETE"}.get(source_status.lower(), "NOT_ACTIVE")
        return done(state, state.replace("_", " ").title(), f"Amazon listing status is {source_status or 'not active'}")

    sales = float(row.get("sales_t28") or 0)
    units = float(row.get("units_t28") or 0)
    sessions = float(row.get("sessions_t28") or 0)
    cvr = float(row["conversion_t28_pct"]) if row.get("conversion_t28_pct") is not None else None
    delta = float(row["sales_delta28_pct"]) if row.get("sales_delta28_pct") is not None else None
    action = str(row.get("inventory_action") or "")
    cover = float(row["days_cover_with_inbound"]) if row.get("days_cover_with_inbound") is not None else None
    if action == "STOCKOUT" or (action == "PRODUCE" and units > 0):
        explanation = f"Demand is active · {cover:.0f} days cover" if cover is not None else "Demand is active · stock is constrained"
        return done(
            "INVENTORY_RISK",
            "Inventory risk",
            explanation,
            eligibility="Inventory facts do not require a complete demand window",
        )
    exposure = base_inputs["eligible_exposure_days"]
    if exposure is None or exposure < 28:
        observed = "unknown" if exposure is None else str(exposure)
        return done("LEARNING", "Learning", f"New offer · {observed} of 28 eligible demand days", eligible=False, eligibility=f"{observed} of 28 required calendar days")
    if sessions >= max(20.0, traffic_median * 1.15) and cvr is not None and conversion_median > 0 and cvr < conversion_median * 0.72:
        return done("TRAFFIC_NOT_CONVERTING", "Traffic not converting", "Traffic is healthy relative to the portfolio, conversion is weak")
    if sessions > 0 and sessions <= max(12.0, traffic_median * 0.65) and cvr is not None and conversion_median > 0 and cvr > conversion_median * 1.25 and units > 0:
        return done("CONVERTS_NEEDS_TRAFFIC", "Converts, needs traffic", "Conversion is strong; traffic is light relative to the portfolio")
    if sessions <= max(5.0, traffic_median * 0.25) and sales <= 0:
        return done("DORMANT", "Dormant", "Active offer with little recent traffic or demand")
    if delta is not None and delta >= 20:
        return done("ACCELERATING", "Accelerating", "28-day sales are materially above the prior 28 days")
    if delta is not None and delta <= -20:
        return done("DECLINING", "Declining", "28-day sales are materially below the prior 28 days")
    if units > 0:
        return done("HEALTHY", "Healthy", "Selling with no major funnel or availability exception")
    if sessions > 0:
        return done("WATCH", "Watch", "Receiving traffic but no recent units")
    return done("DORMANT", "Dormant", "No meaningful recent demand signal")


def catalog_dimension_conversion(conversion, portfolio_conversion) -> dict:
    inputs = {"conversion_t28_pct": conversion, "portfolio_conversion_t28_pct": portfolio_conversion}
    if conversion is None or portfolio_conversion is None or float(portfolio_conversion) <= 0:
        return _evaluation("CATALOG_DIMENSION_CONVERSION_V1", "Portfolio comparison", inputs, eligible=False, eligibility="Comparable conversion is unavailable")
    value, overall = float(conversion), float(portfolio_conversion)
    label = "Converts above portfolio" if value >= overall * 1.2 else "Converts below portfolio" if value <= overall * 0.8 else "Near portfolio conversion"
    return _evaluation("CATALOG_DIMENSION_CONVERSION_V1", label, inputs)


def catalog_family_evaluation(family: dict) -> dict:
    active = [
        member
        for member in family.get("members") or []
        if str(member.get("status") or "").strip().lower() == "active"
    ]
    eligible_count = sum(
        int(((member.get("commercial_evaluation") or {}).get("inputs") or {}).get("eligible_exposure_days") or 0) >= 28
        for member in active
    )
    state = str(family.get("primary_state") or "STRUCTURAL_PARENT")
    labels = {
        "LEARNING": "Learning",
        "INVENTORY_RISK": "Inventory risk",
        "TRAFFIC_NOT_CONVERTING": "Traffic not converting",
        "CONVERTS_NEEDS_TRAFFIC": "Converts, needs traffic",
        "HEALTHY": "Healthy",
        "WATCH": "Watch",
        "DORMANT": "Dormant",
        "INACTIVE": "Inactive",
        "STRUCTURAL_PARENT": "Parent container",
    }
    inputs = {
        "active_sellable_count": len(active),
        "eligible_child_count": eligible_count,
        "child_states": sorted({member.get("commercial_state") for member in active}),
        "sessions_t28": family.get("sessions_t28"),
        "conversion_t28_pct": family.get("conversion_t28_pct"),
        "units_t28": family.get("units_t28"),
    }
    eligible = state == "INVENTORY_RISK" or (state != "LEARNING" and eligible_count > 0)
    if state == "INVENTORY_RISK":
        eligibility = "Inventory facts do not require a complete demand window"
    else:
        eligibility = "Eligible" if eligible else f"{eligible_count} of {len(active)} active children have a complete 28-day demand window"
    return _evaluation(
        "CATALOG_FAMILY_STATE_V1",
        labels.get(state, state.replace("_", " ").title()),
        inputs,
        eligible=eligible,
        eligibility=eligibility,
    )


def trajectory_structure(horizons: list[dict]) -> dict:
    values = {str(row.get("label")): row.get("delta_pct") for row in horizons}
    inputs = {
        "delta7_pct": values.get("7D"),
        "delta28_pct": values.get("28D"),
        "delta56_pct": values.get("56D"),
        "delta90_pct": values.get("90D"),
    }
    if any(values.get(label) is None for label in ("7D", "28D", "56D", "90D")):
        result = _evaluation("TRAJECTORY_STRUCTURE_V1", "Trajectory unavailable", inputs, eligible=False, eligibility="All four comparison windows are required")
        result["explanation"] = "Not enough reconciled history is available to compare every trajectory horizon."
        return result
    short, main, persistent, long = (float(values[label]) for label in ("7D", "28D", "56D", "90D"))
    if main > 5 and persistent > 2 and long > 2:
        label = "Momentum is structurally stronger."
        copy = "The latest week softened, but 28D, 56D and 90D remain positive. Treat the dip as noise unless it persists." if short < 0 else "The main and longer horizons are positive, with the latest week reinforcing the trend."
    elif main < -5 and persistent < -2 and long < -2:
        label = "The slowdown looks structural."
        copy = "The latest week improved, but the 28D, 56D and 90D base remains weaker. The bounce is early, not yet a reversal." if short > 0 else "Main and longer horizons are weaker, and the latest week is not contradicting that signal."
    elif short > 5 and main < 2:
        label, copy = "Short-term acceleration, not yet structural.", "The latest week improved before the 28D and longer windows clearly turned. Watch for persistence."
    elif short < -5 and main > 2:
        label, copy = "Recent softness inside a stronger base.", "The latest week is down while the four-week business remains ahead. Watch whether softness reaches the longer horizons."
    elif abs(main) < 2:
        label, copy = "The structural signal is flat.", "The 28-day business has not made a meaningful step up or down. Weekly movement is mostly context until the longer windows move."
    elif main > 0:
        label, copy = "The business is strengthening, but not uniformly.", "The 28-day horizon is ahead; 56D and 90D determine whether that improvement has become durable."
    else:
        label, copy = "The business has softened, but the signal is mixed.", "The 28-day horizon is behind; longer windows determine whether this is structural or still ordinary volatility."
    result = _evaluation("TRAJECTORY_STRUCTURE_V1", label, inputs)
    result["explanation"] = copy
    return result
