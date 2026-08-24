from __future__ import annotations

from geo_reference import postal_dictionary


def _all(cur, sql: str, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def sales_geography_payload(connect, decorate_products, marketplace: str) -> dict:
    """Return the Sales geography workspace payload only.

    Geography is intentionally separate from the default Sales snapshot because
    postal and SKU-postal history is comparatively large and only needed when the
    user opens the Geography workspace. The privacy boundary remains state/country/
    postal dimensions already reduced during Orders ingestion; no recipient PII is
    queried or returned here.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT min(s.business_date) AS first_date,max(s.business_date) AS last_date,
                   count(DISTINCT s.amazon_order_id)::bigint AS orders_total,
                   count(DISTINCT s.amazon_order_id) FILTER (
                     WHERE nullif(btrim(o.destination_postal_code),'') IS NOT NULL
                   )::bigint AS orders_with_postal,
                   count(DISTINCT nullif(btrim(o.destination_postal_code),''))::int AS postal_codes,
                   count(DISTINCT nullif(btrim(o.destination_state_or_region),''))::int AS states
            FROM mart.order_customer_spend s
            JOIN core.amazon_order o USING (marketplace_id,amazon_order_id)
            WHERE s.marketplace_id=%s
            """,
            (marketplace,),
        )
        coverage = cur.fetchone() or {}
        total_orders = int(coverage.get("orders_total") or 0)
        geocoded_orders = int(coverage.get("orders_with_postal") or 0)
        coverage["coverage_pct"] = (
            round(100.0 * geocoded_orders / total_orders, 1) if total_orders else None
        )
        coverage["status"] = "ready" if geocoded_orders else "backfill_pending"
        coverage["source"] = "Orders v2026 RECIPIENT · state/country/postal only"
        coverage["privacy"] = (
            "No recipient name, street address, city, phone or recipient payload retained"
        )

        daily = _all(
            cur,
            """
            SELECT business_date,country_code,state_or_region,postal_code,sales,orders,units,aov
            FROM mart.order_geography_postal_daily
            WHERE marketplace_id=%s
            ORDER BY business_date,state_or_region,postal_code
            """,
            (marketplace,),
        )
        sku_daily = _all(
            cur,
            """
            SELECT business_date,country_code,state_or_region,postal_code,seller_sku,asin,sales,orders,units
            FROM mart.order_geography_postal_sku_daily
            WHERE marketplace_id=%s
            ORDER BY business_date,state_or_region,postal_code,seller_sku
            """,
            (marketplace,),
        )
        products = _all(
            cur,
            """
            SELECT DISTINCT g.seller_sku AS sku,COALESCE(g.asin,s.asin) AS asin,
                   COALESCE(sl.item_name,ci.title,s.title,g.seller_sku) AS product,
                   COALESCE(sl.image_url,ci.image_url) AS image_url
            FROM mart.order_geography_postal_sku_daily g
            LEFT JOIN core.sku s ON s.sku=g.seller_sku
            LEFT JOIN core.seller_listing sl
              ON sl.marketplace_id=g.marketplace_id AND sl.seller_sku=g.seller_sku
            LEFT JOIN core.catalog_item ci
              ON ci.marketplace_id=g.marketplace_id AND ci.asin=COALESCE(g.asin,s.asin)
            WHERE g.marketplace_id=%s
            ORDER BY g.seller_sku
            """,
            (marketplace,),
        )

    codes = {
        str(row.get("postal_code") or "").strip().zfill(5)
        for row in daily
        if row.get("postal_code")
    }
    return {
        "geography": {
            "coverage": coverage,
            "daily": daily,
            "sku_daily": sku_daily,
            "products": decorate_products(products),
            "postal_reference": postal_dictionary(codes),
            "reference_source": "SEPOMEX textual catalog · open-mexico db_postal v1.2.0",
        }
    }
