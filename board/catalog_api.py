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
              count(*) FILTER (WHERE lower(COALESCE(sc.status,'')) <> 'inactive')::int AS active,
              count(*) FILTER (WHERE lower(COALESCE(sc.status,'')) = 'inactive')::int AS inactive,
              count(*) FILTER (WHERE upper(COALESCE(sc.fulfillment_channel,'')) LIKE '%AMAZON%')::int AS fba,
              count(*) FILTER (WHERE upper(COALESCE(sc.fulfillment_channel,'')) NOT LIKE '%AMAZON%')::int AS merchant,
              count(*) FILTER (WHERE sc.image_url IS NOT NULL)::int AS with_image,
              count(*) FILTER (WHERE ci.asin IS NOT NULL)::int AS catalog_enriched,
              max(sc.fetched_at) AS fetched_at
            FROM mart.seller_catalog sc
            LEFT JOIN core.catalog_item ci
              ON ci.marketplace_id=sc.marketplace_id AND ci.asin=sc.asin
            WHERE sc.marketplace_id=%s
            """,
            (marketplace,),
        )

        rows = _all(
            cur,
            """
            SELECT
              sc.seller_sku AS sku,
              sc.asin,
              sc.title AS product,
              sc.image_url,
              sc.price AS listing_price,
              sc.status,
              sc.fulfillment_channel,
              sc.open_date,
              COALESCE(i.available,0)::int AS available,
              COALESCE(i.inbound,0)::int AS inbound,
              COALESCE(m.sales_t28,0)::numeric(14,2) AS sales_t28,
              COALESCE(m.units_t28,0)::bigint AS units_t28,
              m.delta28_pct,
              COALESCE(m.state,'NO SALES') AS state,
              CASE WHEN ci.asin IS NOT NULL THEN true ELSE false END AS catalog_enriched
            FROM mart.seller_catalog sc
            LEFT JOIN mart.inventory_attention i
              ON i.marketplace_id=sc.marketplace_id AND i.seller_sku=sc.seller_sku
            LEFT JOIN mart.catalog_movers_t28 m
              ON m.marketplace_id=sc.marketplace_id AND m.seller_sku=sc.seller_sku
            LEFT JOIN core.catalog_item ci
              ON ci.marketplace_id=sc.marketplace_id AND ci.asin=sc.asin
            WHERE sc.marketplace_id=%s
            ORDER BY COALESCE(m.sales_t28,0) DESC, sc.seller_sku
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
