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


def _empty(status: str, freshness=None) -> dict:
    return {"status": status, "freshness": freshness, "summary": {}, "daily": [], "campaigns": [], "products": [], "targets": [], "search_terms": []}


def ads_payload(connect, marketplace: str, decorate_products=None) -> dict:
    """Read-only Ads operating payload.

    Attributed sales are deliberately separate from seller total sales. TACOS uses
    independent seller sales; exact organic sales are never inferred by subtraction.
    Freshness reports both data coverage and attribution maturity because the latest
    seven days can still revise under the Sponsored Products 7-day click window.
    """
    with connect() as conn, conn.cursor() as cur:
        exists = _one(cur, "SELECT to_regclass('ads.daily_account') AS rel")
        if not exists.get("rel"):
            return _empty("not_initialized")

        freshness = _one(cur, """
            SELECT max(d.business_date) AS through_date,
                   min(d.business_date) AS first_date,
                   max(d.source_generated_at) AS source_generated_at,
                   max(d.ingested_at) AS ingested_at,
                   count(DISTINCT d.account_id) AS accounts,
                   count(DISTINCT d.business_date) AS observed_days
            FROM ads.daily_account d JOIN ads.account a USING (account_id)
            WHERE a.marketplace_id=%s
        """, (marketplace,))
        through = freshness.get("through_date")
        if not through:
            return _empty("awaiting_ads_data", freshness)

        coverage = _one(cur, """
            WITH expected AS (
              SELECT generate_series(%s::date-27,%s::date,'1 day')::date d
            ), observed AS (
              SELECT DISTINCT d.business_date d
              FROM ads.daily_account d JOIN ads.account a USING(account_id)
              WHERE a.marketplace_id=%s AND d.business_date BETWEEN %s::date-27 AND %s::date
            )
            SELECT 28::int expected_days,count(o.d)::int observed_days,
                   (28-count(o.d))::int missing_days
            FROM expected e LEFT JOIN observed o USING(d)
        """, (through, through, marketplace, through, through))
        freshness.update({
            "period_expected_days": coverage.get("expected_days") or 28,
            "period_observed_days": coverage.get("observed_days") or 0,
            "period_missing_days": coverage.get("missing_days") or 0,
            "attribution_window": "7d_seller_click",
            "mature_through_date": (through - timedelta(days=7)).isoformat(),
            "latest_days_state": "provisional_attribution",
            "freshness_note": "Latest Ads days can revise as attributed conversions arrive. Days older than the 7-day click window are treated as attribution-mature, not immutable.",
        })

        summary = _one(cur, """
            SELECT coalesce(sum(d.spend),0) spend,coalesce(sum(d.attributed_sales),0) attributed_sales,
                   coalesce(sum(d.impressions),0) impressions,coalesce(sum(d.clicks),0) clicks,
                   coalesce(sum(d.purchases),0) purchases,coalesce(sum(d.units),0) units,
                   CASE WHEN sum(d.impressions)>0 THEN sum(d.clicks)::numeric/sum(d.impressions) END ctr,
                   CASE WHEN sum(d.clicks)>0 THEN sum(d.spend)/sum(d.clicks) END cpc,
                   CASE WHEN sum(d.spend)>0 THEN sum(d.attributed_sales)/sum(d.spend) END roas,
                   CASE WHEN sum(d.attributed_sales)>0 THEN sum(d.spend)/sum(d.attributed_sales) END acos
            FROM ads.daily_account d JOIN ads.account a USING(account_id)
            WHERE a.marketplace_id=%s AND d.business_date BETWEEN %s::date-27 AND %s::date
        """, (marketplace, through, through))
        prior = _one(cur, """
            SELECT coalesce(sum(d.spend),0) spend,coalesce(sum(d.attributed_sales),0) attributed_sales,
                   coalesce(sum(d.impressions),0) impressions,coalesce(sum(d.clicks),0) clicks,
                   CASE WHEN sum(d.spend)>0 THEN sum(d.attributed_sales)/sum(d.spend) END roas,
                   CASE WHEN sum(d.attributed_sales)>0 THEN sum(d.spend)/sum(d.attributed_sales) END acos
            FROM ads.daily_account d JOIN ads.account a USING(account_id)
            WHERE a.marketplace_id=%s AND d.business_date BETWEEN %s::date-55 AND %s::date-28
        """, (marketplace, through, through))
        seller_sales = _one(cur, """
            SELECT coalesce(sum(sales) FILTER (WHERE business_date BETWEEN %s::date-27 AND %s::date),0) current_sales,
                   coalesce(sum(sales) FILTER (WHERE business_date BETWEEN %s::date-55 AND %s::date-28),0) prior_sales
            FROM mart.business_daily
            WHERE marketplace_id=%s AND reconciled_daily_report AND business_date BETWEEN %s::date-55 AND %s::date
        """, (through, through, through, through, marketplace, through, through))
        daily = _all(cur, """
            SELECT d.business_date,sum(d.spend) spend,sum(d.attributed_sales) attributed_sales,
                   sum(d.impressions) impressions,sum(d.clicks) clicks,sum(d.purchases) purchases,
                   CASE WHEN sum(d.spend)>0 THEN sum(d.attributed_sales)/sum(d.spend) END roas,
                   CASE WHEN sum(d.attributed_sales)>0 THEN sum(d.spend)/sum(d.attributed_sales) END acos
            FROM ads.daily_account d JOIN ads.account a USING(account_id)
            WHERE a.marketplace_id=%s AND d.business_date BETWEEN %s::date-89 AND %s::date
            GROUP BY d.business_date ORDER BY d.business_date
        """, (marketplace, through, through))
        campaigns = _all(cur, """
            SELECT c.campaign_id,max(c.campaign_name) campaign_name,max(c.ad_product) ad_product,
                   sum(d.spend) spend,sum(d.attributed_sales) attributed_sales,sum(d.impressions) impressions,
                   sum(d.clicks) clicks,sum(d.purchases) purchases,
                   CASE WHEN sum(d.spend)>0 THEN sum(d.attributed_sales)/sum(d.spend) END roas,
                   CASE WHEN sum(d.attributed_sales)>0 THEN sum(d.spend)/sum(d.attributed_sales) END acos
            FROM ads.daily_campaign d JOIN ads.campaign c ON c.account_id=d.account_id AND c.campaign_id=d.campaign_id
            JOIN ads.account a ON a.account_id=d.account_id
            WHERE a.marketplace_id=%s AND d.business_date BETWEEN %s::date-27 AND %s::date
            GROUP BY c.campaign_id ORDER BY spend DESC LIMIT 40
        """, (marketplace, through, through))
        products = _all(cur, """
            SELECT nullif(d.advertised_sku,'') sku,nullif(d.advertised_asin,'') asin,
                   coalesce(sl.item_name,ci.title,s.title,nullif(d.advertised_sku,''),nullif(d.advertised_asin,'')) product,
                   coalesce(sl.image_url,ci.image_url) image_url,sum(d.spend) spend,sum(d.attributed_sales) attributed_sales,
                   sum(d.impressions) impressions,sum(d.clicks) clicks,sum(d.purchases) purchases,
                   CASE WHEN sum(d.spend)>0 THEN sum(d.attributed_sales)/sum(d.spend) END roas,
                   CASE WHEN sum(d.attributed_sales)>0 THEN sum(d.spend)/sum(d.attributed_sales) END acos
            FROM ads.daily_advertised_product d JOIN ads.account a USING(account_id)
            LEFT JOIN core.sku s ON s.sku=nullif(d.advertised_sku,'')
            LEFT JOIN core.seller_listing sl ON sl.marketplace_id=a.marketplace_id AND sl.seller_sku=nullif(d.advertised_sku,'')
            LEFT JOIN core.catalog_item ci ON ci.marketplace_id=a.marketplace_id AND ci.asin=coalesce(nullif(d.advertised_asin,''),s.asin)
            WHERE a.marketplace_id=%s AND d.business_date BETWEEN %s::date-27 AND %s::date
            GROUP BY nullif(d.advertised_sku,''),nullif(d.advertised_asin,''),sl.item_name,ci.title,s.title,sl.image_url,ci.image_url
            ORDER BY spend DESC LIMIT 60
        """, (marketplace, through, through))

        targets=[]; target_view=_one(cur,"SELECT to_regclass('mart.ads_target_daily') rel")
        if target_view.get("rel"):
            targets=_all(cur,"""SELECT d.account_id,d.target_id,d.campaign_id,max(c.campaign_name) campaign_name,max(d.target_type) target_type,max(d.target_expression) target_expression,max(d.match_type) match_type,sum(d.spend) spend,sum(d.attributed_sales) attributed_sales,sum(d.impressions) impressions,sum(d.clicks) clicks,sum(d.purchases) purchases,CASE WHEN sum(d.impressions)>0 THEN sum(d.clicks)::numeric/sum(d.impressions) END ctr,CASE WHEN sum(d.clicks)>0 THEN sum(d.spend)/sum(d.clicks) END cpc,CASE WHEN sum(d.spend)>0 THEN sum(d.attributed_sales)/sum(d.spend) END roas,CASE WHEN sum(d.attributed_sales)>0 THEN sum(d.spend)/sum(d.attributed_sales) END acos FROM mart.ads_target_daily d LEFT JOIN ads.campaign c ON c.account_id=d.account_id AND c.campaign_id=d.campaign_id WHERE d.marketplace_id=%s AND d.business_date BETWEEN %s::date-27 AND %s::date GROUP BY d.account_id,d.target_id,d.campaign_id ORDER BY spend DESC LIMIT 100""",(marketplace,through,through))
        search_terms=[]; search_view=_one(cur,"SELECT to_regclass('mart.ads_search_term_daily') rel")
        if search_view.get("rel"):
            search_terms=_all(cur,"""SELECT d.account_id,d.search_term,d.campaign_id,max(c.campaign_name) campaign_name,d.ad_group_id,d.target_id,max(d.match_type) match_type,sum(d.spend) spend,sum(d.attributed_sales) attributed_sales,sum(d.impressions) impressions,sum(d.clicks) clicks,sum(d.purchases) purchases,CASE WHEN sum(d.impressions)>0 THEN sum(d.clicks)::numeric/sum(d.impressions) END ctr,CASE WHEN sum(d.clicks)>0 THEN sum(d.spend)/sum(d.clicks) END cpc,CASE WHEN sum(d.spend)>0 THEN sum(d.attributed_sales)/sum(d.spend) END roas,CASE WHEN sum(d.attributed_sales)>0 THEN sum(d.spend)/sum(d.attributed_sales) END acos FROM mart.ads_search_term_daily d LEFT JOIN ads.campaign c ON c.account_id=d.account_id AND c.campaign_id=d.campaign_id WHERE d.marketplace_id=%s AND d.business_date BETWEEN %s::date-27 AND %s::date GROUP BY d.account_id,d.search_term,d.campaign_id,d.ad_group_id,d.target_id ORDER BY spend DESC LIMIT 150""",(marketplace,through,through))

        spend=summary.get("spend") or 0; prior_spend=prior.get("spend") or 0
        total_sales=seller_sales.get("current_sales") or 0; prior_total_sales=seller_sales.get("prior_sales") or 0
        tacos=(spend/total_sales) if total_sales>0 else None; prior_tacos=(prior_spend/prior_total_sales) if prior_total_sales>0 else None
        summary.update({
            "total_business_sales":total_sales,"tacos":tacos,
            "attributed_sales_share": (summary.get("attributed_sales")/total_sales) if total_sales>0 else None,
            "spend_delta_pct":_pct_delta(spend,prior_spend),
            "attributed_sales_delta_pct":_pct_delta(summary.get("attributed_sales") or 0,prior.get("attributed_sales") or 0),
            "acos_delta_points":((summary.get("acos")-prior.get("acos"))*100) if summary.get("acos") is not None and prior.get("acos") is not None else None,
            "tacos_delta_points":((tacos-prior_tacos)*100) if tacos is not None and prior_tacos is not None else None,
            "prior":{"spend":prior_spend,"attributed_sales":prior.get("attributed_sales") or 0,"impressions":prior.get("impressions") or 0,"clicks":prior.get("clicks") or 0,"roas":prior.get("roas"),"acos":prior.get("acos"),"total_business_sales":prior_total_sales,"tacos":prior_tacos},
            "period_start":(through-timedelta(days=27)).isoformat(),"period_end":through.isoformat(),
            "basis":"Latest 28 Ads dates aligned to reconciled seller sales. Ads-attributed conversions can revise; attributed sales are not exact incremental or organic sales.",
        })
        if decorate_products: products=decorate_products(products)
        return {"status":"ready","freshness":freshness,"summary":summary,"daily":daily,"campaigns":campaigns,"products":products,"targets":targets,"search_terms":search_terms}
