from __future__ import annotations

from datetime import datetime

from health_api import _decorate_job


def _one(cur, sql, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _all(cur, sql, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def home_payload(connect, decorate_products, marketplace: str) -> dict:
    with connect() as conn, conn.cursor() as cur:
        market = _one(cur, "SELECT currency,timezone FROM core.marketplace WHERE marketplace_id=%s", (marketplace,))
        timezone = market.get("timezone") or "America/Mexico_City"
        today = _one(cur, "SELECT * FROM mart.today_operating WHERE marketplace_id=%s", (marketplace,))
        cutoff = _one(cur, "SELECT max(business_date) AS d FROM mart.business_daily WHERE marketplace_id=%s AND reconciled_daily_report", (marketplace,)).get("d")
        rolling = {}; series = []
        if cutoff:
            rolling = _one(cur, """WITH c AS (SELECT %s::date AS d), x AS (SELECT COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::numeric(14,2) sales_t28,COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-55 AND c.d),0)::numeric(14,2) sales_t56,COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-55 AND c.d-28),0)::numeric(14,2) prior_t28,COALESCE(sum(orders) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::bigint orders_t28,COALESCE(sum(units) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::bigint units_t28 FROM mart.business_daily,c WHERE marketplace_id=%s AND reconciled_daily_report AND business_date BETWEEN c.d-55 AND c.d) SELECT c.d business_date,x.sales_t28,x.sales_t56,x.orders_t28,x.units_t28,CASE WHEN x.prior_t28>0 THEN round(100.0*(x.sales_t28-x.prior_t28)/x.prior_t28,1) END delta28_pct FROM c CROSS JOIN x""", (cutoff, marketplace))
            series = _all(cur, "SELECT business_date,sales,orders,units,aov FROM mart.business_daily WHERE marketplace_id=%s AND reconciled_daily_report AND business_date BETWEEN %s::date-89 AND %s::date ORDER BY business_date", (marketplace, cutoff, cutoff))
        inventory_summary = _one(cur, """SELECT count(*) FILTER (WHERE a.action IN ('STOCKOUT','PRODUCE','PLAN'))::int needs_action,count(*) FILTER (WHERE a.action='STOCKOUT')::int stockouts,count(*) FILTER (WHERE a.action='PRODUCE')::int produce,count(*) FILTER (WHERE a.action='PLAN')::int plan FROM mart.inventory_attention a LEFT JOIN core.sku s ON s.sku=a.seller_sku WHERE a.marketplace_id=%s AND COALESCE(s.active,true)""", (marketplace,))
        inventory = _all(cur, """SELECT a.seller_sku sku,COALESCE(a.asin,s.asin) asin,COALESCE(sl.item_name,ci.title,s.title,'') product,COALESCE(sl.image_url,ci.image_url) image_url,a.available,a.inbound,a.units_t28,a.days_cover_with_inbound days_cover,a.action FROM mart.inventory_attention a LEFT JOIN core.sku s ON s.sku=a.seller_sku LEFT JOIN core.seller_listing sl ON sl.marketplace_id=a.marketplace_id AND sl.seller_sku=a.seller_sku LEFT JOIN core.catalog_item ci ON ci.marketplace_id=a.marketplace_id AND ci.asin=COALESCE(a.asin,s.asin) WHERE a.marketplace_id=%s AND COALESCE(s.active,true) AND a.action IN ('STOCKOUT','PRODUCE','PLAN') ORDER BY CASE a.action WHEN 'STOCKOUT' THEN 0 WHEN 'PRODUCE' THEN 1 ELSE 2 END,a.days_cover_with_inbound NULLS FIRST LIMIT 8""", (marketplace,))
        movers = _all(cur, """SELECT p.seller_sku sku,p.asin,COALESCE(p.title,p.seller_sku) product,p.image_url,p.sales_t28,p.units_t28,p.sales_delta28_pct delta28_pct,COALESCE(m.state,CASE WHEN p.sales_t28>0 THEN 'STABLE' ELSE 'DORMANT' END) state FROM mart.catalog_portfolio_product p LEFT JOIN mart.catalog_movers_t28 m ON m.marketplace_id=p.marketplace_id AND m.seller_sku=p.seller_sku WHERE p.marketplace_id=%s AND p.is_offer_owner AND p.product_role IN ('SELLABLE_VARIATION','SELLABLE_STANDALONE') AND p.sales_t28>0 ORDER BY p.sales_t28 DESC,p.seller_sku LIMIT 8""", (marketplace,))
        weekly_products = _all(cur, """WITH product_week AS (SELECT date_trunc('week',a.business_date)::date week_start,a.asin,COALESCE(sum(a.ordered_product_sales),0)::numeric(14,2) sales,max(a.business_date) through_date FROM core.asin_sales_traffic_daily a WHERE a.marketplace_id=%s AND a.business_date>=%s::date-89 GROUP BY 1,2),ranked AS (SELECT p.*,row_number() OVER (PARTITION BY p.week_start ORDER BY p.sales DESC,p.asin) rank FROM product_week p WHERE p.sales>0) SELECT r.week_start,r.asin,r.sales,r.through_date,COALESCE(po.seller_sku,'') sku,COALESCE(po.title,ci.title,r.asin) product,COALESCE(po.image_url,ci.image_url) image_url FROM ranked r LEFT JOIN core.catalog_item ci ON ci.marketplace_id=%s AND ci.asin=r.asin LEFT JOIN LATERAL (SELECT p.seller_sku,p.title,p.image_url FROM mart.catalog_portfolio_product p WHERE p.marketplace_id=%s AND p.asin=r.asin AND p.is_offer_owner ORDER BY p.seller_sku LIMIT 1) po ON true WHERE r.rank<=3 ORDER BY r.week_start,r.rank""", (marketplace, cutoff or datetime.utcnow().date(), marketplace, marketplace))
        freshness = [
            _decorate_job(row)
            for row in _all(
                cur,
                "SELECT source,job_name,latest_status,extract(epoch from age)::bigint age_seconds FROM ops.data_health WHERE job_name IN ('orders_v2026','sales_traffic_2024_04_24','finances_v2024','fba_inventory_v1','merchant_listings_all_data','catalog_items_2022_04_01','amazon_ads_reporting')",
            )
        ]
        finance = _one(
            cur,
            """SELECT month,state,net_sales_ex_vat,contribution_after_product_cogs,contribution_margin_pct,closed_at
               FROM mart.finance_month_close_latest
               WHERE marketplace_id=%s
               ORDER BY month DESC
               LIMIT 1""",
            (marketplace,),
        )
        local_clock = _one(cur, "SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE %s,'HH24:MI') local_time", (timezone,))
        ads = {"status":"pending_access","trusted":False,"note":"Amazon Ads access pending. Business performance is shown without paid-media interpretation."}
        if _one(cur,"SELECT to_regclass('mart.ads_business_t28') rel").get('rel'):
            a = _one(cur,"SELECT through_date,spend,attributed_sales,total_business_sales,roas,acos,tacos,observed_ads_days,expected_ads_days,missing_ads_days,mature_ads_days FROM mart.ads_business_t28 WHERE marketplace_id=%s",(marketplace,))
            if a.get('through_date'):
                q = _one(cur,"SELECT count(*) FILTER(WHERE quality_state<>'OK')::int issues,count(*)::int account_days FROM mart.ads_ingestion_quality WHERE marketplace_id=%s AND business_date BETWEEN %s::date-27 AND %s::date",(marketplace,a['through_date'],a['through_date'])) if _one(cur,"SELECT to_regclass('mart.ads_ingestion_quality') rel").get('rel') else {}
                complete = int(a.get('missing_ads_days') or 0)==0 and int(a.get('observed_ads_days') or 0)>=int(a.get('expected_ads_days') or 28)
                trusted = complete and int(q.get('issues') or 0)==0 and int(q.get('account_days') or 0)>0
                ads={"status":"ready","trusted":trusted,"through_date":a['through_date'],"spend":a.get('spend'),"attributed_sales":a.get('attributed_sales'),"total_business_sales":a.get('total_business_sales'),"roas":a.get('roas'),"acos":a.get('acos'),"tacos":a.get('tacos'),"mature_days":a.get('mature_ads_days'),"observed_days":a.get('observed_ads_days'),"expected_days":a.get('expected_ads_days'),"note":"Attributed sales can revise and are not exact incremental sales. Total sales minus attributed sales is not exact organic sales."}
    return {"generated_at":datetime.utcnow().isoformat(timespec="seconds")+"Z","local_time":local_clock.get("local_time"),"today":today,"rolling":rolling,"inventory_summary":inventory_summary,"inventory":decorate_products(inventory),"movers":decorate_products(movers),"series":series,"weekly_products":decorate_products(weekly_products),"freshness":freshness,"finance":finance,"ads":ads,"metric_basis":{"currency":market.get("currency") or "MXN","timezone":timezone,"historical_sales":{"id":"AMAZON_ORDERED_PRODUCT_SALES","source":"Sales & Traffic / Data Kiosk","reconciled_only":True},"today":{"id":"GROSS_CUSTOMER_SPEND","source":"Amazon Orders","label":"Shopper spend incl. IVA"},"advertising":{"source":"Amazon Ads","attribution":"Amazon attributed conversions; recent days provisional","organic_warning":"Residual sales are not exact organic sales"}}}
