from __future__ import annotations


def _one(cur, sql: str, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _all(cur, sql: str, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def catalog_payload(connect, decorate_products, marketplace: str) -> dict:
    with connect() as conn, conn.cursor() as cur:
        summary = _one(
            cur,
            """
            SELECT
              count(*)::int AS listings,
              count(*) FILTER (WHERE lower(COALESCE(status,'')) <> 'inactive')::int AS active,
              count(*) FILTER (WHERE lower(COALESCE(status,'')) = 'inactive')::int AS inactive,
              count(*) FILTER (WHERE upper(COALESCE(fulfillment_channel,'')) LIKE '%AMAZON%')::int AS fba,
              count(*) FILTER (WHERE upper(COALESCE(fulfillment_channel,'')) NOT LIKE '%AMAZON%')::int AS merchant,
              max(fetched_at) AS fetched_at
            FROM core.seller_listing
            WHERE marketplace_id=%s
            """,
            (marketplace,),
        )

        rows = _all(
            cur,
            """
            SELECT
              sl.seller_sku AS sku,
              COALESCE(sl.asin,s.asin) AS asin,
              COALESCE(sl.item_name,s.title,sl.seller_sku) AS product,
              sl.image_url,
              sl.price AS listing_price,
              sl.status,
              sl.fulfillment_channel,
              COALESCE(i.available,0)::int AS available,
              COALESCE(i.inbound,0)::int AS inbound,
              COALESCE(m.sales_t28,0)::numeric(14,2) AS sales_t28,
              COALESCE(m.units_t28,0)::bigint AS units_t28,
              m.delta28_pct,
              COALESCE(m.state,'NO SALES') AS state
            FROM core.seller_listing sl
            LEFT JOIN core.sku s ON s.sku=sl.seller_sku
            LEFT JOIN mart.inventory_attention i
              ON i.marketplace_id=sl.marketplace_id AND i.seller_sku=sl.seller_sku
            LEFT JOIN mart.catalog_movers_t28 m
              ON m.marketplace_id=sl.marketplace_id AND m.seller_sku=sl.seller_sku
            WHERE sl.marketplace_id=%s
            ORDER BY COALESCE(m.sales_t28,0) DESC, sl.seller_sku
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
        "local_time": local_clock.get("local_time"),
    }
