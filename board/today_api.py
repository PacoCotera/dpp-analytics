from __future__ import annotations


def _one(cur, sql: str, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _all(cur, sql: str, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def today_payload(connect, decorate_products, marketplace: str) -> dict:
    """Near-real-time wallboard payload.

    This deliberately favors current Orders API facts over historical analysis.
    No customer PII is selected or returned.
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
            )
            SELECT
              to_char(c.local_now,'HH24:MI') AS local_time,
              to_char(c.local_now,'FMDay, FMMonth DD') AS local_date,
              extract(hour FROM c.local_now)::int AS local_hour,
              round(avg(comparable.sales),2) AS typical_same_weekday_full_day,
              max(comparable.sales)::numeric(14,2) AS best_same_weekday_full_day
            FROM clock c LEFT JOIN comparable ON true
            GROUP BY c.local_now
            """,
            (marketplace,),
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

        hourly = _all(
            cur,
            """
            WITH clock AS (
              SELECT m.marketplace_id, m.timezone,
                     CURRENT_TIMESTAMP AT TIME ZONE m.timezone AS local_now
              FROM core.marketplace m WHERE m.marketplace_id=%s
            ), item_rollup AS (
              SELECT amazon_order_id,
                     COALESCE(sum(proceeds_total_amount),sum(proceeds_item_amount),sum(unit_price_amount*quantity_ordered),0)::numeric(14,2) item_sales,
                     COALESCE(sum(quantity_ordered),0)::bigint units
              FROM core.amazon_order_item GROUP BY amazon_order_id
            ), orders_local AS (
              SELECT extract(hour FROM (o.created_time AT TIME ZONE c.timezone))::int AS hour,
                     COALESCE(o.grand_total_amount,i.item_sales,0)::numeric(14,2) sales,
                     COALESCE(i.units,0)::bigint units
              FROM core.amazon_order o
              JOIN clock c ON c.marketplace_id=o.marketplace_id
              LEFT JOIN item_rollup i USING (amazon_order_id)
              WHERE o.marketplace_id=c.marketplace_id
                AND (o.created_time AT TIME ZONE c.timezone)::date=c.local_now::date
                AND o.fulfillment_status IS DISTINCT FROM 'CANCELLED'
            ), hours AS (
              SELECT generate_series(0,(SELECT extract(hour FROM local_now)::int FROM clock)) AS hour
            )
            SELECT h.hour,
                   COALESCE(sum(o.sales),0)::numeric(14,2) AS sales,
                   count(o.hour)::bigint AS orders,
                   COALESCE(sum(o.units),0)::bigint AS units
            FROM hours h LEFT JOIN orders_local o USING (hour)
            GROUP BY h.hour ORDER BY h.hour
            """,
            (marketplace,),
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
        "hourly": hourly,
    }
