from __future__ import annotations

from datetime import timedelta


def _one(cur, sql: str, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _all(cur, sql: str, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def _pct_delta(current, prior):
    if current is None or prior in (None, 0):
        return None
    return 100 * (current - prior) / prior


def ads_payload(connect, marketplace: str) -> dict:
    """Read-only Ads operating payload.

    Ads attributed sales remain explicitly separate from seller total sales. TACOS
    uses the independent seller sales mart aligned to the latest reportable Ads date;
    we never infer exact organic sales by subtraction because attribution can lag,
    overlap, and revise after the order date.
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
        through = freshness.get("through_date")
        if not through:
            return {
                "status": "awaiting_ads_data",
                "freshness": freshness,
                "summary": {},
                "daily": [],
                "campaigns": [],
                "products": [],
            }

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
              AND d.business_date BETWEEN %s::date - 27 AND %s::date
        """, (marketplace, through, through))
        prior = _one(cur, """
            SELECT coalesce(sum(d.spend),0) AS spend,
                   coalesce(sum(d.attributed_sales),0) AS attributed_sales,
                   coalesce(sum(d.impressions),0) AS impressions,
                   coalesce(sum(d.clicks),0) AS clicks,
                   CASE WHEN sum(d.spend)>0 THEN sum(d.attributed_sales)/sum(d.spend) END AS roas,
                   CASE WHEN sum(d.attributed_sales)>0 THEN sum(d.spend)/sum(d.attributed_sales) END AS acos
            FROM ads.daily_account d
            JOIN ads.account a USING (account_id)
            WHERE a.marketplace_id=%s
              AND d.business_date BETWEEN %s::date - 55 AND %s::date - 28
        """, (marketplace, through, through))

        seller_sales = _one(cur, """
            SELECT
              coalesce(sum(sales) FILTER (WHERE business_date BETWEEN %s::date - 27 AND %s::date),0) AS current_sales,
              coalesce(sum(sales) FILTER (WHERE business_date BETWEEN %s::date - 55 AND %s::date - 28),0) AS prior_sales
            FROM mart.business_daily
            WHERE marketplace_id=%s
              AND reconciled_daily_report
              AND business_date BETWEEN %s::date - 55 AND %s::date
        """, (through, through, through, through, marketplace, through, through))

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
            WHERE a.marketplace_id=%s AND d.business_date BETWEEN %s::date - 89 AND %s::date
            GROUP BY d.business_date ORDER BY d.business_date
        """, (marketplace, through, through))
        campaigns = _all(cur, """
            SELECT c.campaign_id, max(c.campaign_name) AS campaign_name, max(c.ad_product) AS ad_product,
                   sum(d.spend) AS spend, sum(d.attributed_sales) AS attributed_sales,
                   sum(d.impressions) AS impressions, sum(d.clicks) AS clicks, sum(d.purchases) AS purchases,
                   CASE WHEN sum(d.spend)>0 THEN sum(d.attributed_sales)/sum(d.spend) END AS roas,
                   CASE WHEN sum(d.attributed_sales)>0 THEN sum(d.spend)/sum(d.attributed_sales) END AS acos
            FROM ads.daily_campaign d
            JOIN ads.campaign c ON c.account_id=d.account_id AND c.campaign_id=d.campaign_id
            JOIN ads.account a ON a.account_id=d.account_id
            WHERE a.marketplace_id=%s AND d.business_date BETWEEN %s::date - 27 AND %s::date
            GROUP BY c.campaign_id ORDER BY spend DESC LIMIT 40
        """, (marketplace, through, through))
        products = _all(cur, """
            SELECT nullif(d.advertised_sku,'') AS sku, nullif(d.advertised_asin,'') AS asin,
                   coalesce(sl.item_name, ci.title, s.title, nullif(d.advertised_sku,''), nullif(d.advertised_asin,'')) AS product,
                   coalesce(sl.image_url, ci.image_url) AS image_url,
                   sum(d.spend) AS spend, sum(d.attributed_sales) AS attributed_sales,
                   sum(d.impressions) AS impressions, sum(d.clicks) AS clicks, sum(d.purchases) AS purchases,
                   CASE WHEN sum(d.spend)>0 THEN sum(d.attributed_sales)/sum(d.spend) END AS roas,
                   CASE WHEN sum(d.attributed_sales)>0 THEN sum(d.spend)/sum(d.attributed_sales) END AS acos
            FROM ads.daily_advertised_product d
            JOIN ads.account a USING(account_id)
            LEFT JOIN core.sku s ON s.sku=nullif(d.advertised_sku,'')
            LEFT JOIN core.seller_listing sl ON sl.marketplace_id=a.marketplace_id AND sl.seller_sku=nullif(d.advertised_sku,'')
            LEFT JOIN core.catalog_item ci ON ci.marketplace_id=a.marketplace_id AND ci.asin=coalesce(nullif(d.advertised_asin,''),s.asin)
            WHERE a.marketplace_id=%s AND d.business_date BETWEEN %s::date - 27 AND %s::date
            GROUP BY nullif(d.advertised_sku,''), nullif(d.advertised_asin,''), sl.item_name, ci.title, s.title, sl.image_url, ci.image_url
            ORDER BY spend DESC LIMIT 60
        """, (marketplace, through, through))

        spend = summary.get("spend") or 0
        prior_spend = prior.get("spend") or 0
        total_sales = seller_sales.get("current_sales") or 0
        prior_total_sales = seller_sales.get("prior_sales") or 0
        tacos = (spend / total_sales) if total_sales > 0 else None
        prior_tacos = (prior_spend / prior_total_sales) if prior_total_sales > 0 else None

        summary.update({
            "total_business_sales": total_sales,
            "tacos": tacos,
            "attributed_sales_share": (summary.get("attributed_sales") / total_sales) if total_sales > 0 else None,
            "spend_delta_pct": _pct_delta(spend, prior_spend),
            "attributed_sales_delta_pct": _pct_delta(summary.get("attributed_sales") or 0, prior.get("attributed_sales") or 0),
            "acos_delta_points": ((summary.get("acos") - prior.get("acos")) * 100) if summary.get("acos") is not None and prior.get("acos") is not None else None,
            "tacos_delta_points": ((tacos - prior_tacos) * 100) if tacos is not None and prior_tacos is not None else None,
            "prior": {
                "spend": prior_spend,
                "attributed_sales": prior.get("attributed_sales") or 0,
                "impressions": prior.get("impressions") or 0,
                "clicks": prior.get("clicks") or 0,
                "roas": prior.get("roas"),
                "acos": prior.get("acos"),
                "total_business_sales": prior_total_sales,
                "tacos": prior_tacos,
            },
            "period_start": (through - timedelta(days=27)).isoformat(),
            "period_end": through.isoformat(),
            "basis": "Latest 28 reportable Ads days aligned to reconciled seller sales. Attributed conversions can revise after the sale date.",
        })

        return {
            "status": "ready",
            "freshness": freshness,
            "summary": summary,
            "daily": daily,
            "campaigns": campaigns,
            "products": products,
        }
