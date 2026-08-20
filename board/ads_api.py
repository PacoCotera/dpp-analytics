from __future__ import annotations


def _one(cur, sql: str, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _all(cur, sql: str, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def ads_payload(connect, marketplace: str) -> dict:
    """Read-only Ads operating payload.

    Ads attributed sales remain explicitly separate from seller total sales. TACOS
    uses the independent seller sales mart when available; we never infer exact
    organic sales by subtraction because Ads attribution can lag and overlap the
    selected business period.
    """
    with connect() as conn, conn.cursor() as cur:
        exists = _one(cur, "SELECT to_regclass('ads.daily_account') AS rel")
        if not exists.get("rel"):
            return {"status": "not_initialized", "freshness": None, "summary": {}, "daily": [], "campaigns": [], "products": []}

        freshness = _one(cur, """
            SELECT max(d.business_date) AS through_date,
                   max(d.source_generated_at) AS source_generated_at,
                   max(d.ingested_at) AS ingested_at,
                   count(DISTINCT d.account_id) AS accounts
            FROM ads.daily_account d
            JOIN ads.account a USING (account_id)
            WHERE a.marketplace_id=%s
        """, (marketplace,))
        summary = _one(cur, """
            SELECT coalesce(sum(d.spend),0) AS spend,
                   coalesce(sum(d.attributed_sales),0) AS attributed_sales,
                   coalesce(sum(d.impressions),0) AS impressions,
                   coalesce(sum(d.clicks),0) AS clicks,
                   coalesce(sum(d.purchases),0) AS purchases,
                   coalesce(sum(d.units),0) AS units,
                   CASE WHEN sum(d.impressions)>0 THEN sum(d.clicks)::numeric/sum(d.impressions) END AS ctr,
                   CASE WHEN sum(d.clicks)>0 THEN sum(d.spend)/sum(d.clicks) END AS cpc,
                   CASE WHEN sum(d.spend)>0 THEN sum(d.attributed_sales)/sum(d.spend) END AS roas,
                   CASE WHEN sum(d.attributed_sales)>0 THEN sum(d.spend)/sum(d.attributed_sales) END AS acos
            FROM ads.daily_account d
            JOIN ads.account a USING (account_id)
            WHERE a.marketplace_id=%s
              AND d.business_date >= current_date - 27
        """, (marketplace,))
        daily = _all(cur, """
            SELECT d.business_date,
                   sum(d.spend) AS spend,
                   sum(d.attributed_sales) AS attributed_sales,
                   sum(d.impressions) AS impressions,
                   sum(d.clicks) AS clicks,
                   sum(d.purchases) AS purchases,
                   CASE WHEN sum(d.spend)>0 THEN sum(d.attributed_sales)/sum(d.spend) END AS roas,
                   CASE WHEN sum(d.attributed_sales)>0 THEN sum(d.spend)/sum(d.attributed_sales) END AS acos
            FROM ads.daily_account d JOIN ads.account a USING(account_id)
            WHERE a.marketplace_id=%s AND d.business_date >= current_date - 89
            GROUP BY d.business_date ORDER BY d.business_date
        """, (marketplace,))
        campaigns = _all(cur, """
            SELECT c.campaign_id, max(c.campaign_name) AS campaign_name, max(c.ad_product) AS ad_product,
                   sum(d.spend) AS spend, sum(d.attributed_sales) AS attributed_sales,
                   sum(d.impressions) AS impressions, sum(d.clicks) AS clicks, sum(d.purchases) AS purchases,
                   CASE WHEN sum(d.spend)>0 THEN sum(d.attributed_sales)/sum(d.spend) END AS roas,
                   CASE WHEN sum(d.attributed_sales)>0 THEN sum(d.spend)/sum(d.attributed_sales) END AS acos
            FROM ads.daily_campaign d
            JOIN ads.campaign c ON c.account_id=d.account_id AND c.campaign_id=d.campaign_id
            JOIN ads.account a ON a.account_id=d.account_id
            WHERE a.marketplace_id=%s AND d.business_date >= current_date - 27
            GROUP BY c.campaign_id ORDER BY spend DESC LIMIT 30
        """, (marketplace,))
        products = _all(cur, """
            SELECT nullif(d.advertised_sku,'') AS sku, nullif(d.advertised_asin,'') AS asin,
                   sum(d.spend) AS spend, sum(d.attributed_sales) AS attributed_sales,
                   sum(d.impressions) AS impressions, sum(d.clicks) AS clicks, sum(d.purchases) AS purchases,
                   CASE WHEN sum(d.spend)>0 THEN sum(d.attributed_sales)/sum(d.spend) END AS roas,
                   CASE WHEN sum(d.attributed_sales)>0 THEN sum(d.spend)/sum(d.attributed_sales) END AS acos
            FROM ads.daily_advertised_product d JOIN ads.account a USING(account_id)
            WHERE a.marketplace_id=%s AND d.business_date >= current_date - 27
            GROUP BY nullif(d.advertised_sku,''), nullif(d.advertised_asin,'')
            ORDER BY spend DESC LIMIT 50
        """, (marketplace,))

        # Total business sales intentionally comes from the seller-side sales mart.
        # Schema variants are tolerated so Ads can deploy before credentials/data arrive.
        total_sales = None
        for sql in (
            "SELECT sum(ordered_product_sales) AS sales FROM mart.daily_sales WHERE business_date >= current_date-27 AND marketplace_id=%s",
            "SELECT sum(sales) AS sales FROM mart.daily_sales WHERE business_date >= current_date-27 AND marketplace_id=%s",
        ):
            try:
                total_sales = _one(cur, sql, (marketplace,)).get("sales")
                break
            except Exception:
                conn.rollback()
        spend = summary.get("spend") or 0
        summary["total_business_sales"] = total_sales
        summary["tacos"] = (spend / total_sales) if total_sales and total_sales > 0 else None
        summary["basis"] = "Latest 28 complete/reportable Ads days; attributed conversions can revise after the sale date."

        return {
            "status": "ready" if freshness.get("through_date") else "awaiting_ads_data",
            "freshness": freshness,
            "summary": summary,
            "daily": daily,
            "campaigns": campaigns,
            "products": products,
        }
