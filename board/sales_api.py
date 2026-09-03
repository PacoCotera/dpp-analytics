from __future__ import annotations

from ads_context import cross_route_t28


def _query_label(sql: str) -> str:
    return " ".join(sql.split())[:180]


def _one(cur, sql: str, params=()):
    try:
        cur.execute(sql, params)
        return cur.fetchone() or {}
    except Exception as exc:
        print(f"sales query failed [one] {_query_label(sql)}: {exc}", flush=True)
        raise


def _all(cur, sql: str, params=()):
    try:
        cur.execute(sql, params)
        return list(cur.fetchall())
    except Exception as exc:
        print(f"sales query failed [all] {_query_label(sql)}: {exc}", flush=True)
        raise


def sales_payload(connect, decorate_products, marketplace: str, *, include_geography: bool = True) -> dict:
    """Sales-manager view.

    Historical metrics are reconciled through the latest Data Kiosk day.
    Today remains the near-real-time Orders API view. Advertising uses the
    canonical operating mart on its own reportable cutoff, so stale/provisional
    attribution is never presented as live sales. Customer identity/street
    address PII is never selected.

    Geography remains available for legacy callers when ``include_geography`` is
    true. The production canonical Sales snapshot passes false and serves
    geography from its own lazy endpoint so the default Sales request does not
    query or serialize postal history.

    Advertising is optional context. A failure in its mart contract must not take
    down the core Sales workspace, so the Ads read is isolated behind a database
    savepoint and degrades explicitly while the reconciled Sales facts remain live.
    """
    with connect() as conn, conn.cursor() as cur:
        cutoff = _one(
            cur,
            "SELECT max(business_date) AS business_date FROM mart.business_daily WHERE marketplace_id=%s AND reconciled_daily_report",
            (marketplace,),
        ).get("business_date")
        if cutoff is None:
            payload = {
                "today": {},
                "headline": {},
                "months": [],
                "months_full": [],
                "series": [],
                "skus": [],
                "orders": [],
                "ads": {"status": "awaiting_ads_data"},
                "local_time": None,
            }
            if include_geography:
                payload["geography"] = {"coverage": {}, "daily": [], "sku_daily": [], "products": []}
            return payload

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

        months = _all(cur, """SELECT date_trunc('month',business_date)::date AS "month",COALESCE(sum(sales),0)::numeric(14,2) sales,COALESCE(sum(orders),0)::bigint orders,COALESCE(sum(units),0)::bigint units,(date_trunc('month',business_date)=date_trunc('month',%s::date)) partial FROM mart.business_daily WHERE marketplace_id=%s AND reconciled_daily_report AND business_date BETWEEN (date_trunc('month',%s::date)-interval '11 months')::date AND %s::date GROUP BY 1,5 ORDER BY 1""", (cutoff,marketplace,cutoff,cutoff))
        months_full = _all(cur, """SELECT date_trunc('month',business_date)::date AS "month",COALESCE(sum(sales),0)::numeric(14,2) sales,COALESCE(sum(orders),0)::bigint orders,COALESCE(sum(units),0)::bigint units,(date_trunc('month',business_date)=date_trunc('month',%s::date)) partial FROM mart.business_daily WHERE marketplace_id=%s AND reconciled_daily_report AND business_date<=%s::date GROUP BY 1,5 ORDER BY 1""", (cutoff,marketplace,cutoff))
        series = _all(cur, "SELECT business_date,sales,orders,units FROM mart.business_daily WHERE marketplace_id=%s AND business_date BETWEEN %s::date-89 AND %s::date ORDER BY business_date", (marketplace,cutoff,cutoff))
        skus = _all(cur, """SELECT m.seller_sku sku,COALESCE(m.asin,s.asin) asin,COALESCE(sl.item_name,ci.title,s.title,m.seller_sku) product,COALESCE(sl.image_url,ci.image_url) image_url,m.sales_t28,m.units_t28,m.delta28_pct,m.state FROM mart.catalog_movers_t28 m LEFT JOIN core.sku s ON s.sku=m.seller_sku LEFT JOIN core.seller_listing sl ON sl.marketplace_id=m.marketplace_id AND sl.seller_sku=m.seller_sku LEFT JOIN core.catalog_item ci ON ci.marketplace_id=m.marketplace_id AND ci.asin=COALESCE(m.asin,s.asin) WHERE m.marketplace_id=%s AND m.sales_t28>0 ORDER BY m.sales_t28 DESC LIMIT 20""", (marketplace,))
        orders = _all(cur, """
            WITH recent_orders AS (
                SELECT o.amazon_order_id,o.marketplace_id,o.created_time,
                       o.grand_total_amount,o.fulfillment_status
                FROM core.amazon_order o
                WHERE o.marketplace_id=%s
                ORDER BY o.created_time DESC
                LIMIT 30
            ), items AS (
                SELECT i.amazon_order_id,
                       jsonb_agg(
                           jsonb_build_object(
                               'sku',COALESCE(i.seller_sku,''),
                               'asin',COALESCE(i.asin,''),
                               'product',COALESCE(sl.item_name,ci.title,i.title,i.seller_sku,i.asin,'Item'),
                               'image_url',COALESCE(sl.image_url,ci.image_url),
                               'quantity',COALESCE(i.quantity_ordered,0)
                           )
                           ORDER BY COALESCE(i.seller_sku,i.title,i.asin,'item')
                       ) item_details,
                       COALESCE(
                           sum(i.proceeds_total_amount),
                           sum(i.proceeds_item_amount),
                           sum(i.unit_price_amount*i.quantity_ordered),
                           0
                       )::numeric(14,2) item_sales
                FROM core.amazon_order_item i
                JOIN recent_orders r USING (amazon_order_id)
                LEFT JOIN core.seller_listing sl
                  ON sl.marketplace_id=r.marketplace_id AND sl.seller_sku=i.seller_sku
                LEFT JOIN core.catalog_item ci
                  ON ci.marketplace_id=r.marketplace_id AND ci.asin=COALESCE(i.asin,sl.asin)
                GROUP BY i.amazon_order_id
            )
            SELECT to_char(o.created_time AT TIME ZONE mp.timezone,'MM-DD HH24:MI') local_time,
                   extract(epoch FROM (CURRENT_TIMESTAMP-o.created_time))::bigint age_seconds,
                   right(o.amazon_order_id,9) order_short,
                   COALESCE(i.item_details,'[]'::jsonb) item_details,
                   COALESCE(o.grand_total_amount,i.item_sales,0)::numeric(14,2) sales,
                   COALESCE(o.fulfillment_status,'') status
            FROM recent_orders o
            JOIN core.marketplace mp USING (marketplace_id)
            LEFT JOIN items i USING (amazon_order_id)
            ORDER BY o.created_time DESC
        """, (marketplace,))
        for order in orders:
            item_details = decorate_products(order.get("item_details") or [])
            order["item_details"] = item_details
            item_labels = []
            for item in item_details:
                quantity = int(item.get("quantity") or 0)
                label = str(item.get("product") or item.get("sku") or "Item")
                item_labels.append(f"{label} ×{quantity}" if quantity > 1 else label)
            order["items"] = ", ".join(item_labels)

        geography = None
        if include_geography:
            geo_coverage = _one(cur, """
                SELECT min(s.business_date) first_date,max(s.business_date) last_date,
                       count(DISTINCT s.amazon_order_id)::bigint orders_total,
                       count(DISTINCT s.amazon_order_id) FILTER (WHERE nullif(btrim(o.destination_postal_code),'') IS NOT NULL)::bigint orders_with_postal,
                       count(DISTINCT nullif(btrim(o.destination_postal_code),''))::int postal_codes,
                       count(DISTINCT nullif(btrim(o.destination_state_or_region),''))::int states
                FROM mart.order_customer_spend s
                JOIN core.amazon_order o USING (marketplace_id,amazon_order_id)
                WHERE s.marketplace_id=%s
            """, (marketplace,))
            total_geo_orders = int(geo_coverage.get("orders_total") or 0)
            geo_orders = int(geo_coverage.get("orders_with_postal") or 0)
            geo_coverage["coverage_pct"] = round(100.0 * geo_orders / total_geo_orders, 1) if total_geo_orders else None
            geo_coverage["status"] = "ready" if geo_orders else "backfill_pending"
            geo_coverage["source"] = "Orders v2026 RECIPIENT · state/country/postal only"
            geo_coverage["privacy"] = "No recipient name, street address, city, phone or recipient payload retained"

            geo_daily = _all(cur, """
                SELECT business_date,country_code,state_or_region,postal_code,sales,orders,units,aov
                FROM mart.order_geography_postal_daily
                WHERE marketplace_id=%s
                ORDER BY business_date,state_or_region,postal_code
            """, (marketplace,))
            geo_sku_daily = _all(cur, """
                SELECT business_date,country_code,state_or_region,postal_code,seller_sku,asin,sales,orders,units
                FROM mart.order_geography_postal_sku_daily
                WHERE marketplace_id=%s
                ORDER BY business_date,state_or_region,postal_code,seller_sku
            """, (marketplace,))
            geo_products = _all(cur, """
                SELECT DISTINCT g.seller_sku sku,COALESCE(g.asin,s.asin) asin,
                       COALESCE(sl.item_name,ci.title,s.title,g.seller_sku) product,
                       COALESCE(sl.image_url,ci.image_url) image_url
                FROM mart.order_geography_postal_sku_daily g
                LEFT JOIN core.sku s ON s.sku=g.seller_sku
                LEFT JOIN core.seller_listing sl ON sl.marketplace_id=g.marketplace_id AND sl.seller_sku=g.seller_sku
                LEFT JOIN core.catalog_item ci ON ci.marketplace_id=g.marketplace_id AND ci.asin=COALESCE(g.asin,s.asin)
                WHERE g.marketplace_id=%s
                ORDER BY g.seller_sku
            """, (marketplace,))
            geography = {
                "coverage": geo_coverage,
                "daily": geo_daily,
                "sku_daily": geo_sku_daily,
                "products": decorate_products(geo_products),
            }

        local_clock = _one(cur, "SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'America/Mexico_City','HH24:MI') local_time")

        try:
            # Isolate optional Ads context from the core Sales transaction. A bad
            # Ads mart/permission/data contract rolls back only this savepoint.
            with conn.transaction():
                ads = cross_route_t28(cur, marketplace, decorate_products, limit=20)
        except Exception as exc:
            print(f"sales ads context degraded: {exc}", flush=True)
            ads = {
                "status": "unavailable",
                "reason": "ads_context_error",
                "detail": str(exc)[:240],
            }

        # Compatibility aliases for the current Sales renderer while canonical names
        # remain available to all new consumers.
        if ads.get("business", {}).get("through_date"):
            business = ads["business"]
            ads.update({
                "spend_t28": business.get("spend"),
                "attributed_sales_t28": business.get("attributed_sales"),
                "acos_t28": business.get("acos"),
                "roas_t28": business.get("roas"),
                "tacos_t28": business.get("tacos"),
                "total_sales_aligned": business.get("total_business_sales"),
                "spend_delta28_pct": business.get("spend_delta_pct"),
                "tacos_delta_points": business.get("tacos_delta_points"),
            })

    payload = {
        "today": today,
        "headline": headline,
        "months": months,
        "months_full": months_full,
        "series": series,
        "skus": decorate_products(skus),
        "orders": orders,
        "ads": ads,
        "local_time": local_clock.get("local_time"),
    }
    if geography is not None:
        payload["geography"] = geography
    return payload
