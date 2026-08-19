from __future__ import annotations


def _one(cur, sql: str, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _all(cur, sql: str, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def inventory_payload(connect, decorate_products, marketplace: str) -> dict:
    with connect() as conn, conn.cursor() as cur:
        summary = _one(
            cur,
            """
            SELECT
              count(*) FILTER (WHERE COALESCE(s.active,true))::int sku_count,
              COALESCE(sum(a.available) FILTER (WHERE COALESCE(s.active,true)),0)::bigint available,
              COALESCE(sum(a.inbound) FILTER (WHERE COALESCE(s.active,true)),0)::bigint inbound,
              COALESCE(sum(i.reserved_quantity) FILTER (WHERE COALESCE(s.active,true)),0)::bigint reserved,
              COALESCE(sum(i.unfulfillable_quantity) FILTER (WHERE COALESCE(s.active,true)),0)::bigint unfulfillable,
              count(*) FILTER (WHERE a.action IN ('STOCKOUT','PRODUCE','PLAN') AND COALESCE(s.active,true))::int needs_action,
              count(*) FILTER (WHERE a.action='STOCKOUT' AND COALESCE(s.active,true))::int stockouts,
              count(*) FILTER (WHERE a.action='PRODUCE' AND COALESCE(s.active,true))::int produce,
              count(*) FILTER (WHERE a.action='PLAN' AND COALESCE(s.active,true))::int plan,
              CASE WHEN sum(a.units_per_day) FILTER (WHERE COALESCE(s.active,true)) > 0
                   THEN round(sum(a.available) FILTER (WHERE COALESCE(s.active,true)) /
                              sum(a.units_per_day) FILTER (WHERE COALESCE(s.active,true)),1) END AS portfolio_days_cover,
              max(a.snapshot_at) latest_snapshot
            FROM mart.inventory_attention a
            LEFT JOIN mart.inventory_current i
              ON i.marketplace_id=a.marketplace_id AND i.seller_sku=a.seller_sku
            LEFT JOIN core.sku s ON s.sku=a.seller_sku
            WHERE a.marketplace_id=%s
            """,
            (marketplace,),
        )

        rows = _all(
            cur,
            """
            SELECT
              a.seller_sku sku,
              COALESCE(a.asin,s.asin) asin,
              COALESCE(sl.item_name,ci.title,s.title,a.seller_sku) product,
              COALESCE(sl.image_url,ci.image_url) image_url,
              a.available, a.inbound,
              COALESCE(i.reserved_quantity,0) reserved,
              COALESCE(i.unfulfillable_quantity,0) unfulfillable,
              a.sales_t28, a.units_t28,
              round(a.units_per_day,2) units_per_day,
              a.days_cover_on_hand,
              a.days_cover_with_inbound,
              a.action,
              COALESCE(sl.price,s.list_price) listing_price,
              sl.status listing_status,
              sl.fulfillment_channel
            FROM mart.inventory_attention a
            LEFT JOIN mart.inventory_current i
              ON i.marketplace_id=a.marketplace_id AND i.seller_sku=a.seller_sku
            LEFT JOIN core.sku s ON s.sku=a.seller_sku
            LEFT JOIN core.seller_listing sl
              ON sl.marketplace_id=a.marketplace_id AND sl.seller_sku=a.seller_sku
            LEFT JOIN core.catalog_item ci
              ON ci.marketplace_id=a.marketplace_id AND ci.asin=COALESCE(a.asin,s.asin)
            WHERE a.marketplace_id=%s
            ORDER BY
              CASE a.action WHEN 'STOCKOUT' THEN 0 WHEN 'PRODUCE' THEN 1 WHEN 'PLAN' THEN 2 WHEN 'OK' THEN 3 ELSE 4 END,
              a.days_cover_with_inbound NULLS LAST,
              a.sales_t28 DESC
            """,
            (marketplace,),
        )

        bands = _all(
            cur,
            """
            SELECT band, count(*)::int sku_count
            FROM (
              SELECT CASE
                WHEN units_per_day=0 THEN 'No velocity'
                WHEN days_cover_with_inbound < 14 THEN '<14 days'
                WHEN days_cover_with_inbound < 28 THEN '14–27 days'
                WHEN days_cover_with_inbound < 56 THEN '28–55 days'
                ELSE '56+ days'
              END band,
              CASE
                WHEN units_per_day=0 THEN 5
                WHEN days_cover_with_inbound < 14 THEN 1
                WHEN days_cover_with_inbound < 28 THEN 2
                WHEN days_cover_with_inbound < 56 THEN 3
                ELSE 4
              END sort_key
              FROM mart.inventory_attention a
              LEFT JOIN core.sku s ON s.sku=a.seller_sku
              WHERE a.marketplace_id=%s AND COALESCE(s.active,true)
            ) x
            GROUP BY band, sort_key
            ORDER BY sort_key
            """,
            (marketplace,),
        )

        local_clock = _one(
            cur,
            "SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'America/Mexico_City','HH24:MI') local_time",
        )

    return {
        "summary": summary,
        "rows": decorate_products(rows),
        "bands": bands,
        "local_time": local_clock.get("local_time"),
    }
