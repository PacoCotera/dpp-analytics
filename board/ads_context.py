from __future__ import annotations


_INTERPRETATION = {
    "attributed_sales": "Amazon-attributed sales; not incremental sales.",
    "tacos": "Ad spend divided by independently reconciled seller sales.",
    "organic_sales": "Do not derive exact organic sales by subtraction.",
}


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
        SELECT
          count(*)::int AS account_days,
          count(*) FILTER (WHERE quality_state='OK')::int AS healthy_account_days,
          count(*) FILTER (WHERE quality_state<>'OK')::int AS issue_account_days,
          count(DISTINCT account_id)::int AS accounts,
          count(DISTINCT business_date)::int AS days,
          max(latest_ingested_at) AS latest_ingested_at,
          COALESCE((SELECT jsonb_object_agg(quality_state,n) FROM issue_counts),'{}'::jsonb) AS issues
        FROM scoped
        """,
        (marketplace, start, end),
    )
    row = cur.fetchone() or {}
    account_days = int(row.get("account_days") or 0)
    issue_days = int(row.get("issue_account_days") or 0)
    state = "NO_DATA" if not account_days else ("HEALTHY" if not issue_days else "ATTENTION")
    return {
        "state": state,
        "trusted": state == "HEALTHY",
        "account_days": account_days,
        "healthy_account_days": int(row.get("healthy_account_days") or 0),
        "issue_days": issue_days,
        "accounts": int(row.get("accounts") or 0),
        "days": int(row.get("days") or 0),
        "latest_ingested_at": row.get("latest_ingested_at"),
        "issues": row.get("issues") or {},
    }


def _finalize_context(row: dict, expected_days: int | None = None, quality: dict | None = None) -> dict:
    if not row or not row.get("through_date"):
        return {
            "status": "awaiting_ads_data",
            "trusted_for_operating_decisions": False,
            "quality": quality or {"state": "NO_DATA", "trusted": False},
            "interpretation": dict(_INTERPRETATION),
        }
    observed = int(row.get("observed_ads_days") or 0)
    mature = int(row.get("mature_ads_days") or 0)
    expected = int(row.get("expected_ads_days") or expected_days or observed or 0)
    row["coverage_state"] = "COMPLETE" if expected and observed >= expected else "PARTIAL"
    row["attribution_state"] = "MATURE" if mature >= observed and observed else "PROVISIONAL"
    row["quality"] = quality or {"state": "UNKNOWN", "trusted": False}
    row["trusted_for_operating_decisions"] = bool(row["quality"].get("trusted") and row["coverage_state"] == "COMPLETE")
    row["status"] = "ready" if row["trusted_for_operating_decisions"] else "attention"
    row["interpretation"] = dict(_INTERPRETATION)
    return row


def business_t28(cur, marketplace: str) -> dict:
    """Canonical rolling Ads context. Finance must use its monthly accounting mart."""
    cur.execute(
        """
        SELECT marketplace_id,through_date,period_start,spend,attributed_sales,
          impressions,clicks,attributed_purchases,attributed_units,total_business_sales,
          ctr,cpc,roas,acos,tacos,attributed_sales_share,observed_ads_days,
          expected_ads_days,missing_ads_days,mature_ads_days,ads_source_generated_at,
          ads_ingested_at,prior_spend,prior_attributed_sales,prior_total_business_sales,
          spend_delta_pct,attributed_sales_delta_pct,tacos_delta_points
        FROM mart.ads_business_t28 WHERE marketplace_id=%s
        """, (marketplace,))
    row = cur.fetchone() or {}
    quality = _quality_for_period(cur, marketplace, row.get("period_start"), row.get("through_date"))
    return _finalize_context(row, expected_days=28, quality=quality)


def product_t28(cur, marketplace: str, sku: str) -> dict:
    """Canonical 28-day Ads context for one sellable SKU."""
    cur.execute(
        """
        SELECT marketplace_id,sku,asin,through_date,period_start,spend,attributed_sales,
          impressions,clicks,attributed_purchases,attributed_units,total_business_sales,
          total_business_orders,total_business_units,ctr,cpc,roas,acos,tacos,
          attributed_sales_share,observed_ads_days,mature_ads_days,
          ads_source_generated_at,ads_ingested_at
        FROM mart.ads_product_business_t28
        WHERE marketplace_id=%s AND sku=%s ORDER BY through_date DESC LIMIT 1
        """, (marketplace, sku))
    row = cur.fetchone() or {}
    quality = _quality_for_period(cur, marketplace, row.get("period_start"), row.get("through_date"))
    return _finalize_context(row, expected_days=28, quality=quality)


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
