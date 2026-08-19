from __future__ import annotations


def _one(cur, sql: str, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _all(cur, sql: str, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def today_payload(connect, decorate_products, marketplace: str) -> dict:
    """Near-real-time Today wallboard payload.

    Current-day facts come from Orders. Recent rhythm uses reconciled business-day
    history with the current day replaced by the live Orders total. No customer PII
    is selected or returned.
    """
    with connect() as conn, conn.cursor() as cur:
        today = _one(
            cur,
            "SELECT * FROM mart.today_operating WHERE marketplace_id=%s",
            (marketplace,),
        )

        context = _one(
            cur,
            """
            WITH clock AS (
              SELECT m.marketplace_id, m.timezone,
                     CURRENT_TIMESTAMP AT TIME ZONE m.timezone AS local_now
              FROM core.marketplace m WHERE m.marketplace_id=%s
            ), comparable AS (
              SELECT b.business_date, b.sales
              FROM mart.business_daily b, clock c
              WHERE b.marketplace_id=c.marketplace_id
                AND b.business_date BETWEEN c.local_now::date-56 AND c.local_now::date-1
                AND extract(isodow FROM b.business_date)=extract(isodow FROM c.local_now)
            ), hist AS (
              SELECT
                COALESCE(sum(b.sales) FILTER (
                  WHERE b.business_date BETWEEN date_trunc('week',c.local_now)::date AND c.local_now::date-1
                ),0)::numeric(14,2) AS week_before_today,
                COALESCE(sum(b.sales) FILTER (
                  WHERE b.business_date BETWEEN date_trunc('month',c.local_now)::date AND c.local_now::date-1
                ),0)::numeric(14,2) AS month_before_today,
                COALESCE(sum(b.sales) FILTER (
                  WHERE b.business_date BETWEEN c.local_now::date-29 AND c.local_now::date-1
                ),0)::numeric(14,2) AS last30_before_today
              FROM clock c
              LEFT JOIN mart.business_daily b
                ON b.marketplace_id=c.marketplace_id
               AND b.business_date BETWEEN c.local_now::date-29 AND c.local_now::date-1
              GROUP BY c.local_now
            ), live AS (
              SELECT COALESCE(sales_today,0)::numeric(14,2) AS sales_today
              FROM mart.today_operating WHERE marketplace_id=%s
            )
            SELECT
              to_char(c.local_now,'HH24:MI') AS local_time,
              to_char(c.local_now,'FMDay, FMMonth DD') AS local_date,
              extract(hour FROM c.local_now)::int AS local_hour,
              round(avg(comparable.sales),2) AS typical_same_weekday_full_day,
              max(comparable.sales)::numeric(14,2) AS best_same_weekday_full_day,
              (h.week_before_today+l.sales_today)::numeric(14,2) AS sales_week,
              (h.month_before_today+l.sales_today)::numeric(14,2) AS sales_mtd,
              (h.last30_before_today+l.sales_today)::numeric(14,2) AS sales_last30
            FROM clock c
            CROSS JOIN hist h
            CROSS JOIN live l
            LEFT JOIN comparable ON true
            GROUP BY c.local_now,h.week_before_today,h.month_before_today,h.last30_before_today,l.sales_today
            """,
            (marketplace, marketplace),
        )

        recent_orders = _all(
            cur,
            """
            WITH item_rollup AS (
              SELECT
                i.amazon_order_id,
                min(i.seller_sku) FILTER (WHERE i.seller_sku IS NOT NULL) AS sku,
                min(i.asin) FILTER (WHERE i.asin IS NOT NULL) AS asin,
                string_agg(DISTINCT COALESCE(i.seller_sku,i.title,'item'), ', ' ORDER BY COALESCE(i.seller_sku,i.title,'item')) AS items,
                COALESCE(sum(i.quantity_ordered),0)::bigint AS units,
                COALESCE(sum(i.proceeds_total_amount),sum(i.proceeds_item_amount),sum(i.unit_price_amount*i.quantity_ordered),0)::numeric(14,2) AS item_sales
              FROM core.amazon_order_item i
              GROUP BY i.amazon_order_id
            )
            SELECT
              o.amazon_order_id AS order_id,
              right(o.amazon_order_id,9) AS order_short,
              i.sku,
              i.asin,
              COALESCE(sl.item_name,s.title,i.items,i.sku,'Order') AS product,
              COALESCE(sl.image_url,ci.image_url) AS image_url,
              COALESCE(o.grand_total_amount,i.item_sales,0)::numeric(14,2) AS sales,
              COALESCE(i.units,0)::bigint AS units,
              to_char(o.created_time AT TIME ZONE mp.timezone,'HH24:MI') AS local_time,
              extract(epoch FROM (CURRENT_TIMESTAMP-o.created_time))::bigint AS age_seconds,
              COALESCE(o.fulfillment_status,'') AS status
            FROM core.amazon_order o
            JOIN core.marketplace mp USING (marketplace_id)
            LEFT JOIN item_rollup i USING (amazon_order_id)
            LEFT JOIN core.sku s ON s.sku=i.sku
            LEFT JOIN core.seller_listing sl
              ON sl.marketplace_id=o.marketplace_id AND sl.seller_sku=i.sku
            LEFT JOIN core.catalog_item ci
              ON ci.marketplace_id=o.marketplace_id AND ci.asin=COALESCE(i.asin,s.asin)
            WHERE o.marketplace_id=%s
              AND (o.created_time AT TIME ZONE mp.timezone)::date=(CURRENT_TIMESTAMP AT TIME ZONE mp.timezone)::date
              AND o.fulfillment_status IS DISTINCT FROM 'CANCELLED'
            ORDER BY o.created_time DESC
            LIMIT 16
            """,
            (marketplace,),
        )

        sku_today = _all(
            cur,
            """
            SELECT
              i.seller_sku AS sku,
              max(i.asin) AS asin,
              COALESCE(sl.item_name,s.title,max(i.title),i.seller_sku) AS product,
              COALESCE(sl.image_url,ci.image_url) AS image_url,
              COALESCE(sum(i.proceeds_total_amount),sum(i.proceeds_item_amount),sum(i.unit_price_amount*i.quantity_ordered),0)::numeric(14,2) AS sales,
              COALESCE(sum(i.quantity_ordered),0)::bigint AS units,
              count(DISTINCT i.amazon_order_id)::bigint AS orders
            FROM core.amazon_order_item i
            JOIN core.amazon_order o USING (amazon_order_id)
            JOIN core.marketplace mp USING (marketplace_id)
            LEFT JOIN core.sku s ON s.sku=i.seller_sku
            LEFT JOIN core.seller_listing sl
              ON sl.marketplace_id=o.marketplace_id AND sl.seller_sku=i.seller_sku
            LEFT JOIN core.catalog_item ci
              ON ci.marketplace_id=o.marketplace_id AND ci.asin=COALESCE(i.asin,s.asin)
            WHERE o.marketplace_id=%s
              AND i.seller_sku IS NOT NULL
              AND (o.created_time AT TIME ZONE mp.timezone)::date=(CURRENT_TIMESTAMP AT TIME ZONE mp.timezone)::date
              AND o.fulfillment_status IS DISTINCT FROM 'CANCELLED'
            GROUP BY i.seller_sku, sl.item_name, sl.image_url, ci.image_url, s.title
            ORDER BY sales DESC, units DESC
            LIMIT 8
            """,
            (marketplace,),
        )

        recent_daily = _all(
            cur,
            """
            WITH clock AS (
              SELECT m.marketplace_id, m.timezone,
                     CURRENT_TIMESTAMP AT TIME ZONE m.timezone AS local_now
              FROM core.marketplace m WHERE m.marketplace_id=%s
            ), days AS (
              SELECT generate_series(c.local_now::date-29,c.local_now::date,interval '1 day')::date AS business_date
              FROM clock c
            ), live AS (
              SELECT COALESCE(sales_today,0)::numeric(14,2) AS sales,
                     COALESCE(orders_today,0)::bigint AS orders,
                     COALESCE(units_today,0)::bigint AS units
              FROM mart.today_operating WHERE marketplace_id=%s
            )
            SELECT
              d.business_date,
              CASE WHEN d.business_date=c.local_now::date THEN l.sales ELSE COALESCE(b.sales,0) END::numeric(14,2) AS sales,
              CASE WHEN d.business_date=c.local_now::date THEN l.orders ELSE COALESCE(b.orders,0) END::bigint AS orders,
              CASE WHEN d.business_date=c.local_now::date THEN l.units ELSE COALESCE(b.units,0) END::bigint AS units,
              d.business_date=c.local_now::date AS live
            FROM days d
            CROSS JOIN clock c
            CROSS JOIN live l
            LEFT JOIN mart.business_daily b
              ON b.marketplace_id=c.marketplace_id AND b.business_date=d.business_date
            ORDER BY d.business_date
            """,
            (marketplace, marketplace),
        )

    recent_orders = decorate_products(recent_orders)
    sku_today = decorate_products(sku_today)
    latest = recent_orders[0] if recent_orders else None
    return {
        "today": today,
        "context": context,
        "latest_order": latest,
        "recent_orders": recent_orders,
        "sku_today": sku_today,
        "recent_daily": recent_daily,
    }
