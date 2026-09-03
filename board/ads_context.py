from __future__ import annotations

import re

from ads_decisions import (
    ECONOMICS_CONTRACT,
    INTERPRETATION_RULES,
    build_action_groups,
    build_product_action,
    enrich_products,
    metric_contract,
    product_recommendation,
)
from ads_state import ads_connection_state


_INTERPRETATION = {
    "attributed_sales": "Amazon-attributed sales; not incremental sales.",
    "tacos": "Ad spend divided by independently reconciled seller sales.",
    "organic_sales": "Do not derive exact organic sales by subtraction.",
}


def _attribution_lookback_days(value) -> int:
    match = re.search(r"(\d+)", str(value or ""))
    return max(0, int(match.group(1))) if match else 7


def _lookback_for_period(cur, marketplace: str, through_date) -> int:
    if not through_date:
        return 7
    cur.execute(
        """
        SELECT max(attribution_window) AS attribution_window
        FROM mart.ads_business_daily
        WHERE marketplace_id=%s AND business_date=%s::date
        """,
        (marketplace, through_date),
    )
    return _attribution_lookback_days((cur.fetchone() or {}).get("attribution_window"))


def _quality_for_period(cur, marketplace: str, start, end) -> dict:
    """Summarize canonical Ads ingestion quality over the exact operating period."""
    if not start or not end:
        return {"state": "NO_DATA", "trusted": False, "issue_days": 0, "issues": {}}
    cur.execute(
        """
        WITH scoped AS (
          SELECT * FROM mart.ads_ingestion_quality
          WHERE marketplace_id=%s AND business_date BETWEEN %s::date AND %s::date
        ), issue_counts AS (
          SELECT quality_state, count(*)::int AS n
          FROM scoped WHERE quality_state<>'OK' GROUP BY quality_state
        )
        SELECT count(*)::int AS account_days,
          count(*) FILTER (WHERE quality_state='OK')::int AS healthy_account_days,
          count(*) FILTER (WHERE quality_state<>'OK')::int AS issue_account_days,
          count(DISTINCT account_id)::int AS accounts,
          count(DISTINCT business_date)::int AS days,
          max(latest_ingested_at) AS latest_ingested_at,
          COALESCE((SELECT jsonb_object_agg(quality_state,n) FROM issue_counts),'{}'::jsonb) AS issues
        FROM scoped
        """, (marketplace, start, end))
    row = cur.fetchone() or {}
    account_days = int(row.get("account_days") or 0)
    issue_days = int(row.get("issue_account_days") or 0)
    state = "NO_DATA" if not account_days else ("HEALTHY" if not issue_days else "ATTENTION")
    return {
        "state": state, "trusted": state == "HEALTHY", "account_days": account_days,
        "healthy_account_days": int(row.get("healthy_account_days") or 0),
        "issue_days": issue_days, "accounts": int(row.get("accounts") or 0),
        "days": int(row.get("days") or 0), "latest_ingested_at": row.get("latest_ingested_at"),
        "issues": row.get("issues") or {},
    }


def _finalize_context(row: dict, expected_days: int | None = None, quality: dict | None = None, *, require_complete: bool = True) -> dict:
    if not row or not row.get("through_date"):
        return {"status": "awaiting_ads_data", "trusted_for_operating_decisions": False,
                "quality": quality or {"state": "NO_DATA", "trusted": False},
                "interpretation": dict(_INTERPRETATION)}
    observed = int(row.get("observed_ads_days") or 0)
    mature = int(row.get("mature_ads_days") or 0)
    expected = int(row.get("expected_ads_days") or expected_days or observed or 0)
    row["coverage_state"] = "COMPLETE" if expected and observed >= expected else "PARTIAL"
    row["attribution_state"] = "MATURE" if mature >= observed and observed else "PROVISIONAL"
    row["quality"] = quality or {"state": "UNKNOWN", "trusted": False}
    coverage_ok = row["coverage_state"] == "COMPLETE" if require_complete else observed > 0
    row["trusted_for_operating_decisions"] = bool(row["quality"].get("trusted") and coverage_ok)
    row["status"] = "ready" if row["trusted_for_operating_decisions"] else "attention"
    row["interpretation"] = dict(_INTERPRETATION)
    return row


def decision_availability(business: dict, connection: dict) -> dict:
    """Explain whether the completed Ads window can produce recommendations.

    This is server-owned interpretation. Cross-route browser code should render
    this contract rather than infer business meaning from quality codes.
    """
    destination = {"view": "impact"}
    if not business.get("through_date"):
        return {
            "state": "UNAVAILABLE",
            "code": "NO_REPORTING_WINDOW",
            "headline": "Advertising history is not available yet",
            "detail": "A completed reporting window is required before paid-support metrics or recommendations can appear.",
            "action_label": "Open Advertising",
            "destination": destination,
        }

    if connection.get("state") != "READY":
        return {
            "state": "BLOCKED",
            "code": "CONNECTION_NOT_READY",
            "headline": connection.get("headline") or "Advertising reporting needs attention",
            "detail": connection.get("detail") or "Product recommendations are paused until Amazon Ads reporting is ready.",
            "action_label": "Review Ads status",
            "destination": destination,
        }

    observed = int(business.get("observed_ads_days") or 0)
    expected = int(business.get("expected_ads_days") or 0)
    missing = int(business.get("missing_ads_days") or max(0, expected - observed))
    if business.get("coverage_state") != "COMPLETE":
        missing_label = f"{missing} reporting day" + ("s" if missing != 1 else "")
        verb = "is" if missing == 1 else "are"
        return {
            "state": "BLOCKED",
            "code": "REPORTING_INCOMPLETE",
            "headline": "Advertising reporting is incomplete",
            "detail": f"{missing_label.capitalize()} {verb} missing from the completed window, so product recommendations are paused.",
            "action_label": "Review Ads data",
            "destination": destination,
        }

    quality = business.get("quality") or {}
    if not quality.get("trusted"):
        issue_days = int(quality.get("issue_days") or 0)
        issue_label = f"{issue_days} data issue" + ("s" if issue_days != 1 else "") if issue_days else "Data checks"
        issue_verb = "is" if issue_days == 1 else "are"
        issues = quality.get("issues") or {}
        denominator_days = int(issues.get("SELLER_SALES_DENOMINATOR_MISSING") or 0)
        if denominator_days:
            day_label = f"{denominator_days} day" + ("s" if denominator_days != 1 else "")
            detail = (
                f"Seller-sales data is missing for {day_label}. Metrics remain visible, "
                "but product recommendations are paused until it is reconciled."
            )
        else:
            detail = "Advertising metrics remain visible, but product recommendations are paused until the data issue is reconciled."
        return {
            "state": "BLOCKED",
            "code": "DATA_QUALITY_BLOCKED",
            "headline": f"{issue_label.capitalize()} {issue_verb} blocking recommendations",
            "detail": detail,
            "action_label": "Review Ads data",
            "destination": destination,
        }

    if not business.get("trusted_for_operating_decisions"):
        return {
            "state": "BLOCKED",
            "code": "DECISION_INPUTS_NOT_READY",
            "headline": "Advertising recommendations are paused",
            "detail": "The completed window does not yet meet the reporting checks required for product recommendations.",
            "action_label": "Review Ads data",
            "destination": destination,
        }

    return {
        "state": "READY",
        "code": "READY",
        "headline": "No advertising action needs review",
        "detail": "No product crossed the current review thresholds in this completed window.",
        "action_label": "Open Advertising",
        "destination": destination,
    }


def business_t28(cur, marketplace: str) -> dict:
    """Canonical rolling Ads context. Finance must use its monthly accounting mart."""
    cur.execute(
        """SELECT marketplace_id,through_date,period_start,spend,attributed_sales,
          impressions,clicks,attributed_purchases,attributed_units,total_business_sales,
          ctr,cpc,roas,acos,tacos,attributed_sales_share,observed_ads_days,
          expected_ads_days,missing_ads_days,mature_ads_days,ads_source_generated_at,
          ads_ingested_at,prior_spend,prior_attributed_sales,prior_total_business_sales,
          spend_delta_pct,attributed_sales_delta_pct,tacos_delta_points
        FROM mart.ads_business_t28 WHERE marketplace_id=%s""", (marketplace,))
    row = cur.fetchone() or {}
    quality = _quality_for_period(cur, marketplace, row.get("period_start"), row.get("through_date"))
    return _finalize_context(row, expected_days=28, quality=quality)


def product_t28(
    cur,
    marketplace: str,
    sku: str,
    *,
    product: str | None = None,
    image_url: str | None = None,
) -> dict:
    """Canonical 28-day Ads context for one sellable SKU.

    Product advertising is legitimately sparse: a SKU need not be advertised on
    every day in the business window. Trust therefore follows account/report
    reconciliation for the period, not a false requirement for 28 product rows.
    """
    cur.execute(
        """SELECT marketplace_id,sku,asin,through_date,period_start,spend,attributed_sales,
          impressions,clicks,attributed_purchases,attributed_units,total_business_sales,
          total_business_orders,total_business_units,ctr,cpc,roas,acos,tacos,
          attributed_sales_share,observed_ads_days,mature_ads_days,
          ads_source_generated_at,ads_ingested_at
        FROM mart.ads_product_business_t28
        WHERE marketplace_id=%s AND sku=%s ORDER BY through_date DESC LIMIT 1""", (marketplace, sku))
    row = cur.fetchone() or {}
    quality = _quality_for_period(cur, marketplace, row.get("period_start"), row.get("through_date"))
    context = _finalize_context(row, expected_days=28, quality=quality, require_complete=False)
    context["connection"] = ads_connection_state(cur)
    if context.get("through_date"):
        context["product"] = product or sku
        context["image_url"] = image_url
        context["purchases"] = context.get("attributed_purchases")
        context["units"] = context.get("attributed_units")
        context = metric_contract(context)
        lookback_days = _lookback_for_period(cur, marketplace, context.get("through_date"))
        context["attribution_lookback_days"] = lookback_days
        decision_ready = bool(
            context.get("trusted_for_operating_decisions")
            and context["connection"].get("state") == "READY"
        )
        context["recommendation"] = product_recommendation(
            context,
            trusted=decision_ready,
            attribution_lookback_days=lookback_days,
        )
        context["economics"] = ECONOMICS_CONTRACT
        context["action"] = build_product_action(context)
    return context


def cross_route_t28(cur, marketplace: str, decorate_products=None, *, limit: int = 8) -> dict:
    """Return one bounded Ads business/product/action projection for other routes."""
    connection = ads_connection_state(cur)
    business = business_t28(cur, marketplace)
    if not business.get("through_date"):
        return {
            "status": business.get("status") or "awaiting_ads_data",
            "connection": connection,
            "business": business,
            "products": [],
            "actions": [],
            "primary_action": None,
            "decision_availability": decision_availability(business, connection),
            "economics": ECONOMICS_CONTRACT,
            "interpretation_rules": INTERPRETATION_RULES,
        }

    cur.execute(
        """
        SELECT p.sku,p.asin,coalesce(sl.item_name,ci.title,s.title,p.sku,p.asin) product,
          coalesce(sl.image_url,ci.image_url) image_url,p.spend,p.attributed_sales,p.impressions,
          p.clicks,p.attributed_purchases AS purchases,p.attributed_units AS units,
          p.total_business_sales,p.total_business_orders,p.total_business_units,p.ctr,p.cpc,p.roas,
          p.acos,p.tacos,p.attributed_sales_share,p.observed_ads_days,p.mature_ads_days,
          p.through_date,p.period_start
        FROM mart.ads_product_business_t28 p
        LEFT JOIN core.sku s ON s.sku=p.sku
        LEFT JOIN core.seller_listing sl ON sl.marketplace_id=p.marketplace_id AND sl.seller_sku=p.sku
        LEFT JOIN core.catalog_item ci
          ON ci.marketplace_id=p.marketplace_id AND ci.asin=coalesce(p.asin,s.asin)
        WHERE p.marketplace_id=%s
        ORDER BY p.spend DESC
        LIMIT 60
        """,
        (marketplace,),
    )
    products = list(cur.fetchall())
    if decorate_products:
        products = decorate_products(products)
    lookback_days = _lookback_for_period(cur, marketplace, business.get("through_date"))
    decision_ready = bool(
        business.get("trusted_for_operating_decisions")
        and connection.get("state") == "READY"
    )
    products = enrich_products(
        products,
        trusted=decision_ready,
        attribution_lookback_days=lookback_days,
    )
    actions, groups = (
        build_action_groups(products, [])
        if decision_ready
        else ([], [])
    )
    return {
        "status": business.get("status"),
        "connection": connection,
        "business": business,
        "products": products[: max(1, min(int(limit), 60))],
        "actions": actions,
        "action_groups": groups,
        "primary_action": actions[0] if actions else None,
        "decision_availability": decision_availability(business, connection),
        "attribution_lookback_days": lookback_days,
        "economics": ECONOMICS_CONTRACT,
        "interpretation_rules": INTERPRETATION_RULES,
    }


def business_daily(cur, marketplace: str, days: int = 90) -> list[dict]:
    """Canonical daily Ads context with per-day trust metadata for charts."""
    days = max(1, min(int(days), 366))
    cur.execute(
        """
        WITH cutoff AS (
          SELECT max(business_date) AS d FROM mart.ads_business_daily WHERE marketplace_id=%s
        ), quality AS (
          SELECT marketplace_id,business_date,bool_and(quality_state='OK') AS trusted,
                 count(*) FILTER (WHERE quality_state<>'OK')::int AS issue_accounts
          FROM mart.ads_ingestion_quality WHERE marketplace_id=%s
          GROUP BY marketplace_id,business_date
        )
        SELECT d.marketplace_id,d.business_date,d.advertiser_accounts,d.impressions,d.clicks,
          d.ad_spend AS spend,d.attributed_sales,d.attributed_purchases,d.attributed_units,
          d.total_business_sales,d.total_business_orders,d.total_business_units,d.ctr,d.cpc,
          d.roas,d.acos,d.tacos,d.attributed_sales_share,d.attribution_method,
          d.attribution_window,d.ads_source_generated_at,d.ads_ingested_at,d.ads_through_date,
          d.attribution_mature,d.attribution_state,COALESCE(q.trusted,false) AS quality_trusted,
          COALESCE(q.issue_accounts,0) AS quality_issue_accounts
        FROM mart.ads_business_daily d CROSS JOIN cutoff c
        LEFT JOIN quality q USING (marketplace_id,business_date)
        WHERE d.marketplace_id=%s AND d.business_date BETWEEN c.d-(%s-1) AND c.d
        ORDER BY d.business_date
        """, (marketplace, marketplace, marketplace, days))
    return list(cur.fetchall())
