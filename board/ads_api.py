from __future__ import annotations

from datetime import timedelta


def _one(cur, sql: str, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _all(cur, sql: str, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def _empty(status: str, freshness=None) -> dict:
    return {"status": status, "freshness": freshness, "summary": {}, "daily": [], "campaigns": [], "products": [], "targets": [], "search_terms": []}


def ads_payload(connect, marketplace: str, decorate_products=None) -> dict:
    """Canonical Ads operating payload.

    Business/product rollups come from the shared Ads context marts so every app
    surface uses the same multi-account aggregation, seller-sales denominator,
    attribution maturity, and TACOS semantics. Campaign/target/search-term rows
    remain drilldown facts because they do not have a seller-sales denominator.
    """
    with connect() as conn, conn.cursor() as cur:
        ready = _one(cur, "SELECT to_regclass('mart.ads_business_t28') business_rel, to_regclass('mart.ads_product_business_t28') product_rel")
        if not ready.get("business_rel"):
            return _empty("not_initialized")

        summary = _one(cur, """
            SELECT marketplace_id, through_date, period_start,
                   spend, attributed_sales, impressions, clicks,
                   attributed_purchases AS purchases, attributed_units AS units,
                   total_business_sales, ctr, cpc, roas, acos, tacos,
                   attributed_sales_share, observed_ads_days,
                   expected_ads_days, missing_ads_days, mature_ads_days,
                   ads_source_generated_at AS source_generated_at,
                   ads_ingested_at AS ingested_at,
                   prior_spend, prior_attributed_sales, prior_total_business_sales,
                   spend_delta_pct, attributed_sales_delta_pct, tacos_delta_points
            FROM mart.ads_business_t28 WHERE marketplace_id=%s
        """, (marketplace,))
        through = summary.get("through_date")
        if not through:
            return _empty("awaiting_ads_data")

        summary.update({
            "period_end": through.isoformat(),
            "period_start": summary.get("period_start").isoformat() if summary.get("period_start") else None,
            "basis": "Latest 28 Ads dates aligned to independently reconciled seller sales. Ads-attributed conversions can revise; attributed sales are not exact incremental sales and the residual is not exact organic sales.",
            "prior": {
                "spend": summary.get("prior_spend") or 0,
                "attributed_sales": summary.get("prior_attributed_sales") or 0,
                "total_business_sales": summary.get("prior_total_business_sales") or 0,
            },
        })

        freshness = {
            "through_date": through,
            "source_generated_at": summary.get("source_generated_at"),
            "ingested_at": summary.get("ingested_at"),
            "period_expected_days": summary.get("expected_ads_days") or 28,
            "period_observed_days": summary.get("observed_ads_days") or 0,
            "period_missing_days": summary.get("missing_ads_days") or 0,
            "mature_days": summary.get("mature_ads_days") or 0,
            "mature_through_date": (through - timedelta(days=7)).isoformat(),
            "latest_days_state": "provisional_attribution",
            "freshness_note": "Latest Ads days can revise as attributed conversions arrive. Days older than the current 7-day click window are attribution-mature, not immutable.",
        }

        daily = _all(cur, """
            SELECT business_date, ad_spend AS spend, attributed_sales,
                   impressions, clicks, attributed_purchases AS purchases,
                   attributed_units AS units, total_business_sales,
                   ctr, cpc, roas, acos, tacos, attributed_sales_share,
                   attribution_method, attribution_window,
                   attribution_mature, attribution_state
            FROM mart.ads_business_daily
            WHERE marketplace_id=%s AND business_date BETWEEN %s::date-89 AND %s::date
            ORDER BY business_date
        """, (marketplace, through, through))

        campaigns = _all(cur, """
            SELECT c.campaign_id,max(c.campaign_name) campaign_name,max(c.ad_product) ad_product,
                   sum(d.spend) spend,sum(d.attributed_sales) attributed_sales,sum(d.impressions) impressions,
                   sum(d.clicks) clicks,sum(d.purchases) purchases,sum(d.units) units,
                   CASE WHEN sum(d.impressions)>0 THEN sum(d.clicks)::numeric/sum(d.impressions) END ctr,
                   CASE WHEN sum(d.clicks)>0 THEN sum(d.spend)/sum(d.clicks) END cpc,
                   CASE WHEN sum(d.spend)>0 THEN sum(d.attributed_sales)/sum(d.spend) END roas,
                   CASE WHEN sum(d.attributed_sales)>0 THEN sum(d.spend)/sum(d.attributed_sales) END acos
            FROM ads.daily_campaign d
            JOIN ads.campaign c ON c.account_id=d.account_id AND c.campaign_id=d.campaign_id
            JOIN ads.account a ON a.account_id=d.account_id
            WHERE a.marketplace_id=%s AND d.business_date BETWEEN %s::date-27 AND %s::date
            GROUP BY c.campaign_id ORDER BY spend DESC LIMIT 40
        """, (marketplace, through, through))

        products = []
        if ready.get("product_rel"):
            products = _all(cur, """
                SELECT p.sku,p.asin,
                       coalesce(sl.item_name,ci.title,s.title,p.sku,p.asin) product,
                       coalesce(sl.image_url,ci.image_url) image_url,
                       p.spend,p.attributed_sales,p.impressions,p.clicks,
                       p.attributed_purchases AS purchases,p.attributed_units AS units,
                       p.total_business_sales,p.ctr,p.cpc,p.roas,p.acos,p.tacos,
                       p.attributed_sales_share,p.observed_ads_days,p.mature_ads_days,
                       p.through_date,p.period_start
                FROM mart.ads_product_business_t28 p
                LEFT JOIN core.sku s ON s.sku=p.sku
                LEFT JOIN core.seller_listing sl ON sl.marketplace_id=p.marketplace_id AND sl.seller_sku=p.sku
                LEFT JOIN core.catalog_item ci ON ci.marketplace_id=p.marketplace_id AND ci.asin=coalesce(p.asin,s.asin)
                WHERE p.marketplace_id=%s
                ORDER BY p.spend DESC LIMIT 60
            """, (marketplace,))

        targets=[]
        if _one(cur,"SELECT to_regclass('mart.ads_target_daily') rel").get("rel"):
            targets=_all(cur,"""SELECT d.account_id,d.target_id,d.campaign_id,max(c.campaign_name) campaign_name,max(d.target_type) target_type,max(d.target_expression) target_expression,max(d.match_type) match_type,sum(d.spend) spend,sum(d.attributed_sales) attributed_sales,sum(d.impressions) impressions,sum(d.clicks) clicks,sum(d.purchases) purchases,CASE WHEN sum(d.impressions)>0 THEN sum(d.clicks)::numeric/sum(d.impressions) END ctr,CASE WHEN sum(d.clicks)>0 THEN sum(d.spend)/sum(d.clicks) END cpc,CASE WHEN sum(d.spend)>0 THEN sum(d.attributed_sales)/sum(d.spend) END roas,CASE WHEN sum(d.attributed_sales)>0 THEN sum(d.spend)/sum(d.attributed_sales) END acos FROM mart.ads_target_daily d LEFT JOIN ads.campaign c ON c.account_id=d.account_id AND c.campaign_id=d.campaign_id WHERE d.marketplace_id=%s AND d.business_date BETWEEN %s::date-27 AND %s::date GROUP BY d.account_id,d.target_id,d.campaign_id ORDER BY spend DESC LIMIT 100""",(marketplace,through,through))

        search_terms=[]
        if _one(cur,"SELECT to_regclass('mart.ads_search_term_daily') rel").get("rel"):
            search_terms=_all(cur,"""SELECT d.account_id,d.search_term,d.campaign_id,max(c.campaign_name) campaign_name,d.ad_group_id,d.target_id,max(d.match_type) match_type,sum(d.spend) spend,sum(d.attributed_sales) attributed_sales,sum(d.impressions) impressions,sum(d.clicks) clicks,sum(d.purchases) purchases,CASE WHEN sum(d.impressions)>0 THEN sum(d.clicks)::numeric/sum(d.impressions) END ctr,CASE WHEN sum(d.clicks)>0 THEN sum(d.spend)/sum(d.clicks) END cpc,CASE WHEN sum(d.spend)>0 THEN sum(d.attributed_sales)/sum(d.spend) END roas,CASE WHEN sum(d.attributed_sales)>0 THEN sum(d.spend)/sum(d.attributed_sales) END acos FROM mart.ads_search_term_daily d LEFT JOIN ads.campaign c ON c.account_id=d.account_id AND c.campaign_id=d.campaign_id WHERE d.marketplace_id=%s AND d.business_date BETWEEN %s::date-27 AND %s::date GROUP BY d.account_id,d.search_term,d.campaign_id,d.ad_group_id,d.target_id ORDER BY spend DESC LIMIT 150""",(marketplace,through,through))

    if decorate_products:
        products=decorate_products(products)
    return {"status":"ready","freshness":freshness,"summary":summary,"daily":daily,"campaigns":campaigns,"products":products,"targets":targets,"search_terms":search_terms}
