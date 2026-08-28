from __future__ import annotations

from metric_windows import INVENTORY_ORDER_VELOCITY_T28, load_metric_windows


def _one(cur, sql: str, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _all(cur, sql: str, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def _classify_inventory_rows(rows: list[dict], current_offers: list[dict], retired_skus: set[str]):
    current_by_sku = {str(row.get("sku") or ""): row for row in current_offers if row.get("sku")}
    current_by_asin = {str(row.get("asin") or ""): row for row in current_offers if row.get("asin")}
    classified = []
    for source in rows:
        row = dict(source)
        sku = str(row.get("sku") or "")
        asin = str(row.get("asin") or "")
        exact = current_by_sku.get(sku)
        canonical = exact or current_by_asin.get(asin)
        if exact:
            lifecycle = "CURRENT_OFFER"
        elif canonical:
            lifecycle = "ALIAS"
        elif sku in retired_skus:
            lifecycle = "RETIRED"
        else:
            lifecycle = "ARCHIVED"
        stock_units = sum(int(row.get(field) or 0) for field in ("available", "inbound", "reserved", "unfulfillable"))
        row.update(
            {
                "canonical_sku": canonical.get("sku") if canonical else None,
                "inventory_lifecycle": lifecycle,
                "is_current_offer": lifecycle == "CURRENT_OFFER",
                "has_stock": stock_units > 0,
                "has_velocity": int(row.get("units_t28") or 0) > 0,
                "is_default_inventory": lifecycle == "CURRENT_OFFER" and stock_units > 0,
            }
        )
        classified.append(row)
    return classified


def inventory_payload(connect, decorate_products, marketplace: str) -> dict:
    with connect() as conn, conn.cursor() as cur:
        summary = _one(
            cur,
            """
            SELECT
              count(*)::int sku_count,
              COALESCE(sum(a.available),0)::bigint available,
              COALESCE(sum(a.inbound),0)::bigint inbound,
              COALESCE(sum(i.reserved_quantity),0)::bigint reserved,
              COALESCE(sum(i.unfulfillable_quantity),0)::bigint unfulfillable,
              count(*) FILTER (WHERE a.action IN ('STOCKOUT','PRODUCE','PLAN'))::int needs_action,
              count(*) FILTER (WHERE a.action='STOCKOUT')::int stockouts,
              count(*) FILTER (WHERE a.action='PRODUCE')::int produce,
              count(*) FILTER (WHERE a.action='PLAN')::int plan,
              CASE WHEN sum(a.units_per_day) > 0
                   THEN round(sum(a.available) / sum(a.units_per_day),1) END AS portfolio_days_cover,
              max(a.snapshot_at) latest_snapshot
            FROM mart.inventory_attention a
            JOIN mart.catalog_portfolio_product p
              ON p.marketplace_id=a.marketplace_id AND p.seller_sku=a.seller_sku
             AND p.is_offer_owner
             AND p.product_role IN ('SELLABLE_VARIATION','SELLABLE_STANDALONE')
             AND p.catalog_membership='CURRENT_OFFER'
            LEFT JOIN mart.inventory_current i
              ON i.marketplace_id=a.marketplace_id AND i.seller_sku=a.seller_sku
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

        current_offers = _all(
            cur,
            """
            SELECT seller_sku sku,asin,status
            FROM mart.catalog_portfolio_product
            WHERE marketplace_id=%s AND is_offer_owner
              AND product_role IN ('SELLABLE_VARIATION','SELLABLE_STANDALONE')
              AND catalog_membership='CURRENT_OFFER'
            """,
            (marketplace,),
        )
        retired_skus = {
            str(row.get("sku") or "")
            for row in _all(
                cur,
                """
                SELECT seller_sku sku FROM mart.seller_catalog
                WHERE marketplace_id=%s AND NOT is_current_listing
                """,
                (marketplace,),
            )
        }

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
              JOIN mart.catalog_portfolio_product p
                ON p.marketplace_id=a.marketplace_id AND p.seller_sku=a.seller_sku
               AND p.is_offer_owner
               AND p.product_role IN ('SELLABLE_VARIATION','SELLABLE_STANDALONE')
               AND p.catalog_membership='CURRENT_OFFER'
              WHERE a.marketplace_id=%s
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
        metric_windows = load_metric_windows(
            cur,
            marketplace,
            (INVENTORY_ORDER_VELOCITY_T28,),
            timezone="America/Mexico_City",
        )

    rows = _classify_inventory_rows(rows, current_offers, retired_skus)
    return {
        "summary": summary,
        "rows": decorate_products(rows),
        "record_scope": {
            "default": "current stock-bearing offers",
            "current_offers": len(current_offers),
            "default_rows": sum(bool(row["is_default_inventory"]) for row in rows),
            "aliases": sum(row["inventory_lifecycle"] == "ALIAS" for row in rows),
            "retired": sum(row["inventory_lifecycle"] == "RETIRED" for row in rows),
            "archived": sum(row["inventory_lifecycle"] == "ARCHIVED" for row in rows),
            "definition": "Current Amazon catalog offers own inventory decisions; other seller SKUs remain explicit reference records.",
        },
        "bands": bands,
        "local_time": local_clock.get("local_time"),
        "metric_windows": metric_windows,
    }
