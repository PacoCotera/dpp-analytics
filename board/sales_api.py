from __future__ import annotations

from ads_context import business_t28


def _one(cur, sql: str, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _all(cur, sql: str, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def sales_payload(connect, decorate_products, marketplace: str) -> dict:
    """Sales-manager view.

    Historical metrics are reconciled through the latest Data Kiosk day.
    Today remains the near-real-time Orders API view. Advertising uses the
    canonical operating mart on its own reportable cutoff, so stale/provisional
    attribution is never presented as live sales. No customer PII is selected.
    """
    with connect() as conn, conn.cursor() as cur:
        cutoff = _one(cur, "SELECT max(business_date) AS business_date FROM mart.business_daily WHERE marketplace_id=%s AND reconciled_daily_report", (marketplace,)).get("business_date")
        if cutoff is None:
            return {"today": {}, "headline": {}, "months": [], "months_full": [], "series": [], "skus": [], "orders": [], "ads": {"status": "awaiting_ads_data"}, "local_time": None}

        today = _one(cur, "SELECT * FROM mart.today_operating WHERE marketplace_id=%s", (marketplace,))
        headline = _one(cur, """
            WITH c AS (
              SELECT %s::date AS d, date_trunc('month',%s::date)::date month_start,
                     date_trunc('year',%s::date)::date year_start, extract(day from %s::date)::int dom,
                     extract(day from (date_trunc('month',%s::date)+interval '1 month - 1 day'))::int dim
            ), x AS (
              SELECT COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.month_start AND c.d),0)::numeric(14,2) sales_mtd,
                COALESCE(sum(orders) FILTER (WHERE business_date BETWEEN c.month_start AND c.d),0)::bigint orders_mtd,
                COALESCE(sum(units) FILTER (WHERE business_date BETWEEN c.month_start AND c.d),0)::bigint units_mtd,
                COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN (c.month_start-interval '1 month')::date AND ((c.month_start-interval '1 month')::date+(c.dom-1))),0)::numeric(14,2) sales_prev_month_same_days,
                COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN (c.month_start-interval '1 month')::date AND c.month_start-1),0)::numeric(14,2) sales_prev_month_full,
                COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.year_start AND c.d),0)::numeric(14,2) sales_ytd,
                COALESCE(sum(orders) FILTER (WHERE business_date BETWEEN c.year_start AND c.d),0)::bigint orders_ytd,
                COALESCE(sum(units) FILTER (WHERE business_date BETWEEN c.year_start AND c.d),0)::bigint units_ytd,
                COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-6 AND c.d),0)::numeric(14,2) sales_t7,
                COALESCE(sum(orders) FILTER (WHERE business_date BETWEEN c.d-6 AND c.d),0)::bigint orders_t7,
                COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-13 AND c.d-7),0)::numeric(14,2) sales_prior_t7,
                COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::numeric(14,2) sales_t28,
                COALESCE(sum(orders) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::bigint orders_t28,
                COALESCE(sum(units) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::bigint units_t28,
                COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-55 AND c.d-28),0)::numeric(14,2) sales_prior_t28,
                COALESCE(sum(sessions) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::bigint sessions_t28
              FROM mart.business_daily,c WHERE marketplace_id=%s
                AND business_date BETWEEN least(c.year_start,(c.month_start-interval '1 month')::date,c.d-55) AND c.d
            ) SELECT c.d business_date,c.dom month_days_elapsed,c.dim month_days_total,x.sales_mtd,x.orders_mtd,x.units_mtd,
              x.sales_prev_month_same_days,x.sales_prev_month_full,round(x.sales_mtd/greatest(c.dom,1),2) daily_avg_mtd,
              round((x.sales_mtd/greatest(c.dom,1))*c.dim,2) projected_month_sales,
              CASE WHEN x.sales_prev_month_same_days>0 THEN round(100.0*(x.sales_mtd-x.sales_prev_month_same_days)/x.sales_prev_month_same_days,1) END delta_mtd_pct,
              x.sales_ytd,x.orders_ytd,x.units_ytd,x.sales_t7,x.orders_t7,round(x.sales_t7/7.0,2) daily_avg_t7,
              CASE WHEN x.sales_prior_t7>0 THEN round(100.0*(x.sales_t7-x.sales_prior_t7)/x.sales_prior_t7,1) END delta7_pct,
              x.sales_t28,x.orders_t28,x.units_t28,x.sessions_t28,round(x.sales_t28/28.0,2) daily_avg_t28,
              CASE WHEN x.sales_prior_t28>0 THEN round(100.0*(x.sales_t28-x.sales_prior_t28)/x.sales_prior_t28,1) END delta28_pct,
              CASE WHEN x.sessions_t28>0 THEN round(100.0*x.units_t28/x.sessions_t28,1) END cvr28_pct FROM c CROSS JOIN x
        """, (cutoff,cutoff,cutoff,cutoff,cutoff,marketplace))

        months = _all(cur, """SELECT date_trunc('month',business_date)::date month,COALESCE(sum(sales),0)::numeric(14,2) sales,COALESCE(sum(orders),0)::bigint orders,COALESCE(sum(units),0)::bigint units,(date_trunc('month',business_date)=date_trunc('month',%s::date)) partial FROM mart.business_daily WHERE marketplace_id=%s AND reconciled_daily_report AND business_date BETWEEN (date_trunc('month',%s::date)-interval '11 months')::date AND %s::date GROUP BY 1,5 ORDER BY 1""", (cutoff,marketplace,cutoff,cutoff))
        months_full = _all(cur, """SELECT date_trunc('month',business_date)::date month,COALESCE(sum(sales),0)::numeric(14,2) sales,COALESCE(sum(orders),0)::bigint orders,COALESCE(sum(units),0)::bigint units,(date_trunc('month',business_date)=date_trunc('month',%s::date)) partial FROM mart.business_daily WHERE marketplace_id=%s AND reconciled_daily_report AND business_date<=%s::date GROUP BY 1,5 ORDER BY 1""", (cutoff,marketplace,cutoff))
        series = _all(cur, "SELECT business_date,sales,orders,units FROM mart.business_daily WHERE marketplace_id=%s AND business_date BETWEEN %s::date-89 AND %s::date ORDER BY business_date", (marketplace,cutoff,cutoff))
        skus = _all(cur, """SELECT m.seller_sku sku,COALESCE(m.asin,s.asin) asin,COALESCE(sl.item_name,ci.title,s.title,m.seller_sku) product,COALESCE(sl.image_url,ci.image_url) image_url,m.sales_t28,m.units_t28,m.delta28_pct,m.state FROM mart.catalog_movers_t28 m LEFT JOIN core.sku s ON s.sku=m.seller_sku LEFT JOIN core.seller_listing sl ON sl.marketplace_id=m.marketplace_id AND sl.seller_sku=m.seller_sku LEFT JOIN core.catalog_item ci ON ci.marketplace_id=m.marketplace_id AND ci.asin=COALESCE(m.asin,s.asin) WHERE m.marketplace_id=%s AND m.sales_t28>0 ORDER BY m.sales_t28 DESC LIMIT 20""", (marketplace,))
        orders = _all(cur, """WITH items AS (SELECT i.amazon_order_id,string_agg(DISTINCT COALESCE(i.seller_sku,i.title,'item'),', ' ORDER BY COALESCE(i.seller_sku,i.title,'item')) items,COALESCE(sum(i.proceeds_total_amount),sum(i.proceeds_item_amount),sum(i.unit_price_amount*i.quantity_ordered),0)::numeric(14,2) item_sales FROM core.amazon_order_item i GROUP BY i.amazon_order_id) SELECT to_char(o.created_time AT TIME ZONE mp.timezone,'MM-DD HH24:MI') local_time,extract(epoch FROM (CURRENT_TIMESTAMP-o.created_time))::bigint age_seconds,right(o.amazon_order_id,9) order_short,COALESCE(i.items,'') items,COALESCE(o.grand_total_amount,i.item_sales,0)::numeric(14,2) sales,COALESCE(o.fulfillment_status,'') status FROM core.amazon_order o JOIN core.marketplace mp USING (marketplace_id) LEFT JOIN items i USING (amazon_order_id) WHERE o.marketplace_id=%s ORDER BY o.created_time DESC LIMIT 30""", (marketplace,))

        ads = business_t28(cur, marketplace)
        # Compatibility aliases for the current Sales renderer while canonical names
        # remain available to all new consumers.
        if ads.get("status") == "ready":
            ads.update({
                "spend_t28": ads.get("spend"), "attributed_sales_t28": ads.get("attributed_sales"),
                "acos_t28": ads.get("acos"), "roas_t28": ads.get("roas"), "tacos_t28": ads.get("tacos"),
                "total_sales_aligned": ads.get("total_business_sales"), "spend_delta28_pct": ads.get("spend_delta_pct"),
                "tacos_delta_points": ads.get("tacos_delta_points"),
            })
        local_clock = _one(cur, "SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'America/Mexico_City','HH24:MI') local_time")

    return {"today":today,"headline":headline,"months":months,"months_full":months_full,"series":series,"skus":decorate_products(skus),"orders":orders,"ads":ads,"local_time":local_clock.get("local_time")}
