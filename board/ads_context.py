from __future__ import annotations


def business_t28(cur, marketplace: str) -> dict:
    """Return the canonical rolling Ads context for operating surfaces.

    Finance must not use this helper: Finance is accounting-period based and uses
    mart.ads_finance_month_context instead. Amazon-attributed sales are attribution,
    not incremental sales, and must never be subtracted from seller sales and
    labelled exact organic sales.
    """
    cur.execute(
        """
        SELECT
          marketplace_id,
          through_date,
          period_start,
          spend,
          attributed_sales,
          impressions,
          clicks,
          attributed_purchases,
          attributed_units,
          total_business_sales,
          ctr,
          cpc,
          roas,
          acos,
          tacos,
          attributed_sales_share,
          observed_ads_days,
          expected_ads_days,
          missing_ads_days,
          mature_ads_days,
          ads_source_generated_at,
          ads_ingested_at,
          prior_spend,
          prior_attributed_sales,
          prior_total_business_sales,
          spend_delta_pct,
          attributed_sales_delta_pct,
          tacos_delta_points
        FROM mart.ads_business_t28
        WHERE marketplace_id=%s
        """,
        (marketplace,),
    )
    row = cur.fetchone() or {}
    if not row or not row.get("through_date"):
        return {
            "status": "awaiting_ads_data",
            "interpretation": {
                "attributed_sales": "Amazon-attributed sales; not incremental sales.",
                "tacos": "Ad spend divided by independently reconciled seller sales.",
                "organic_sales": "Do not derive exact organic sales by subtraction.",
            },
        }

    observed = int(row.get("observed_ads_days") or 0)
    expected = int(row.get("expected_ads_days") or 28)
    mature = int(row.get("mature_ads_days") or 0)
    row["status"] = "ready"
    row["coverage_state"] = "COMPLETE" if observed >= expected else "PARTIAL"
    row["attribution_state"] = "MATURE" if mature >= observed and observed else "PROVISIONAL"
    row["interpretation"] = {
        "attributed_sales": "Amazon-attributed sales; not incremental sales.",
        "tacos": "Ad spend divided by independently reconciled seller sales.",
        "organic_sales": "Do not derive exact organic sales by subtraction.",
    }
    return row


def business_daily(cur, marketplace: str, days: int = 90) -> list[dict]:
    """Canonical daily Ads + independent seller-sales context for operating charts."""
    days = max(1, min(int(days), 366))
    cur.execute(
        """
        WITH cutoff AS (
          SELECT max(business_date) AS d
          FROM mart.ads_business_daily
          WHERE marketplace_id=%s
        )
        SELECT
          d.marketplace_id,
          d.business_date,
          d.advertiser_accounts,
          d.impressions,
          d.clicks,
          d.ad_spend AS spend,
          d.attributed_sales,
          d.attributed_purchases,
          d.attributed_units,
          d.total_business_sales,
          d.total_business_orders,
          d.total_business_units,
          d.ctr,
          d.cpc,
          d.roas,
          d.acos,
          d.tacos,
          d.attributed_sales_share,
          d.attribution_method,
          d.attribution_window,
          d.ads_source_generated_at,
          d.ads_ingested_at,
          d.ads_through_date,
          d.attribution_mature,
          d.attribution_state
        FROM mart.ads_business_daily d
        CROSS JOIN cutoff c
        WHERE d.marketplace_id=%s
          AND d.business_date BETWEEN c.d-(%s-1) AND c.d
        ORDER BY d.business_date
        """,
        (marketplace, marketplace, days),
    )
    return list(cur.fetchall())
