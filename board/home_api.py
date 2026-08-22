from __future__ import annotations

from datetime import datetime


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
        cutoff = _one(cur, """
            SELECT max(business_date) AS d
            FROM mart.business_daily
            WHERE marketplace_id=%s AND reconciled_daily_report
        """, (marketplace,)).get("d")

        rolling = {}
        series = []
        if cutoff:
            rolling = _one(cur, """
                WITH c AS (SELECT %s::date AS d), x AS (
                  SELECT
                    COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::numeric(14,2) AS sales_t28,
                    COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-55 AND c.d),0)::numeric(14,2) AS sales_t56,
                    COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-55 AND c.d-28),0)::numeric(14,2) AS prior_t28,
                    COALESCE(sum(orders) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::bigint AS orders_t28,
                    COALESCE(sum(units) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::bigint AS units_t28
                  FROM mart.business_daily,c
                  WHERE marketplace_id=%s AND reconciled_daily_report
                    AND business_date BETWEEN c.d-55 AND c.d
                )
                SELECT c.d AS business_date,x.sales_t28,x.sales_t56,x.orders_t28,x.units_t28,
                       CASE WHEN x.prior_t28>0 THEN round(100.0*(x.sales_t28-x.prior_t28)/x.prior_t28,1) END AS delta28_pct
                FROM c CROSS JOIN x
            """, (cutoff, marketplace))
            series = _all(cur, """
                SELECT business_date,sales,orders,units,aov
                FROM mart.business_daily
                WHERE marketplace_id=%s AND reconciled_daily_report
                  AND business_date BETWEEN %s::date-89 AND %s::date
                ORDER BY business_date
            """, (marketplace, cutoff, cutoff))

        inventory_summary = _one(cur, """
            SELECT count(*) FILTER (WHERE a.action IN ('STOCKOUT','PRODUCE','PLAN'))::int AS needs_action,
                   count(*) FILTER (WHERE a.action='STOCKOUT')::int AS stockouts,
                   count(*) FILTER (WHERE a.action='PRODUCE')::int AS produce,
                   count(*) FILTER (WHERE a.action='PLAN')::int AS plan
            FROM mart.inventory_attention a
            LEFT JOIN core.sku s ON s.sku=a.seller_sku
            WHERE a.marketplace_id=%s AND COALESCE(s.active,true)
        """, (marketplace,))
        inventory = _all(cur, """
            SELECT a.seller_sku AS sku,COALESCE(a.asin,s.asin) AS asin,
                   COALESCE(sl.item_name,ci.title,s.title,'') AS product,
                   COALESCE(sl.image_url,ci.image_url) AS image_url,
                   a.available,a.inbound,a.units_t28,a.days_cover_with_inbound AS days_cover,a.action
            FROM mart.inventory_attention a
            LEFT JOIN core.sku s ON s.sku=a.seller_sku
            LEFT JOIN core.seller_listing sl ON sl.marketplace_id=a.marketplace_id AND sl.seller_sku=a.seller_sku
            LEFT JOIN core.catalog_item ci ON ci.marketplace_id=a.marketplace_id AND ci.asin=COALESCE(a.asin,s.asin)
            WHERE a.marketplace_id=%s AND COALESCE(s.active,true)
              AND a.action IN ('STOCKOUT','PRODUCE','PLAN')
            ORDER BY CASE a.action WHEN 'STOCKOUT' THEN 0 WHEN 'PRODUCE' THEN 1 ELSE 2 END,
                     a.days_cover_with_inbound NULLS FIRST
            LIMIT 8
        """, (marketplace,))
        movers = _all(cur, """
            SELECT p.seller_sku AS sku,p.asin,COALESCE(p.title,p.seller_sku) AS product,
                   p.image_url,p.sales_t28,p.units_t28,p.sales_delta28_pct AS delta28_pct,
                   COALESCE(m.state,CASE WHEN p.sales_t28>0 THEN 'STABLE' ELSE 'DORMANT' END) AS state
            FROM mart.catalog_portfolio_product p
            LEFT JOIN mart.catalog_movers_t28 m
              ON m.marketplace_id=p.marketplace_id AND m.seller_sku=p.seller_sku
            WHERE p.marketplace_id=%s AND p.is_offer_owner
              AND p.product_role IN ('SELLABLE_VARIATION','SELLABLE_STANDALONE')
              AND p.sales_t28>0
            ORDER BY p.sales_t28 DESC,p.seller_sku
            LIMIT 8
        """, (marketplace,))
        weekly_products = _all(cur, """
            WITH product_week AS (
                SELECT date_trunc('week',a.business_date)::date AS week_start,
                       a.asin,COALESCE(sum(a.ordered_product_sales),0)::numeric(14,2) AS sales,
                       max(a.business_date) AS through_date
                FROM core.asin_sales_traffic_daily a
                WHERE a.marketplace_id=%s AND a.business_date>=%s::date-89
                GROUP BY 1,2
            ), ranked AS (
                SELECT p.*,row_number() OVER (PARTITION BY p.week_start ORDER BY p.sales DESC,p.asin) AS rank
                FROM product_week p WHERE p.sales>0
            )
            SELECT r.week_start,r.asin,r.sales,r.through_date,
                   COALESCE(po.seller_sku,'') AS sku,
                   COALESCE(po.title,ci.title,r.asin) AS product,
                   COALESCE(po.image_url,ci.image_url) AS image_url
            FROM ranked r
            LEFT JOIN core.catalog_item ci ON ci.marketplace_id=%s AND ci.asin=r.asin
            LEFT JOIN LATERAL (
                SELECT p.seller_sku,p.title,p.image_url
                FROM mart.catalog_portfolio_product p
                WHERE p.marketplace_id=%s AND p.asin=r.asin AND p.is_offer_owner
                ORDER BY p.seller_sku LIMIT 1
            ) po ON true
            WHERE r.rank<=3
            ORDER BY r.week_start,r.rank
        """, (marketplace, cutoff or datetime.utcnow().date(), marketplace, marketplace))
        freshness = _all(cur, """
            SELECT job_name,latest_status,extract(epoch from age)::bigint AS age_seconds
            FROM ops.data_health
            WHERE job_name IN ('orders_v2026','sales_traffic_2024_04_24','finances_v2024','fba_inventory_v1','merchant_listings_all_data','catalog_items_2022_04_01')
        """)
        local_clock = _one(cur, "SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE %s,'HH24:MI') AS local_time", (timezone,))

    return {
        "generated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "local_time": local_clock.get("local_time"),
        "today": today,
        "rolling": rolling,
        "inventory_summary": inventory_summary,
        "inventory": decorate_products(inventory),
        "movers": decorate_products(movers),
        "series": series,
        "weekly_products": decorate_products(weekly_products),
        "freshness": freshness,
        "metric_basis": {
            "currency": market.get("currency") or "MXN",
            "timezone": timezone,
            "historical_sales": {
                "id": "AMAZON_ORDERED_PRODUCT_SALES",
                "source": "Sales & Traffic / Data Kiosk",
                "reconciled_only": True,
            },
            "today": {
                "id": "GROSS_CUSTOMER_SPEND",
                "source": "Amazon Orders",
                "label": "Shopper spend incl. IVA",
            },
        },
    }
