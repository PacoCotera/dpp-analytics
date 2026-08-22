from __future__ import annotations

from sales_api_legacy import sales_payload as _legacy_sales_payload


def sales_payload(connect, decorate_products, marketplace: str) -> dict:
    payload = _legacy_sales_payload(connect, decorate_products, marketplace)
    cutoff = (payload.get("headline") or {}).get("business_date")

    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT currency,timezone,country_code FROM core.marketplace WHERE marketplace_id=%s",
            (marketplace,),
        )
        market = cur.fetchone() or {}

        if cutoff:
            cur.execute(
                """
                SELECT business_date,sales,orders,units
                FROM mart.business_daily
                WHERE marketplace_id=%s
                  AND reconciled_daily_report
                  AND business_date BETWEEN %s::date-89 AND %s::date
                ORDER BY business_date
                """,
                (marketplace, cutoff, cutoff),
            )
            payload["series"] = list(cur.fetchall())

            # Production Data Kiosk demand is CHILD-ASIN grain. Catalog already
            # owns the canonical offer mapping, so use that instead of pretending
            # a seller-SKU Sales & Traffic fact is populated.
            cur.execute(
                """
                SELECT p.seller_sku AS sku,p.asin,p.title AS product,p.image_url,
                       p.sales_t28,p.units_t28,p.sales_delta28_pct AS delta28_pct,
                       COALESCE(m.state,CASE WHEN p.sales_t28>0 THEN 'STABLE' ELSE 'DORMANT' END) AS state,
                       'AMAZON_ORDERED_PRODUCT_SALES'::text AS sales_basis
                FROM mart.catalog_portfolio_product p
                LEFT JOIN mart.catalog_movers_t28 m
                  ON m.marketplace_id=p.marketplace_id AND m.seller_sku=p.seller_sku
                WHERE p.marketplace_id=%s
                  AND p.is_offer_owner
                  AND p.product_role IN ('SELLABLE_VARIATION','SELLABLE_STANDALONE')
                  AND p.sales_t28>0
                ORDER BY p.sales_t28 DESC,p.seller_sku
                LIMIT 20
                """,
                (marketplace,),
            )
            payload["skus"] = decorate_products(list(cur.fetchall()))

        cur.execute(
            """
            WITH items AS (
              SELECT amazon_order_id,
                     string_agg(DISTINCT COALESCE(seller_sku,title,'item'),', ' ORDER BY COALESCE(seller_sku,title,'item')) AS items
              FROM core.amazon_order_item GROUP BY amazon_order_id
            )
            SELECT to_char(o.created_time AT TIME ZONE mp.timezone,'MM-DD HH24:MI') AS local_time,
                   extract(epoch FROM (CURRENT_TIMESTAMP-o.created_time))::bigint AS age_seconds,
                   right(o.amazon_order_id,9) AS order_short,
                   COALESCE(i.items,'') AS items,
                   o.customer_spend AS sales,
                   'GROSS_CUSTOMER_SPEND'::text AS sales_basis,
                   COALESCE(o.fulfillment_status,'') AS status
            FROM mart.order_customer_spend o
            JOIN core.marketplace mp USING (marketplace_id)
            LEFT JOIN items i USING (amazon_order_id)
            WHERE o.marketplace_id=%s
            ORDER BY o.created_time DESC LIMIT 30
            """,
            (marketplace,),
        )
        payload["orders"] = list(cur.fetchall())

    payload["metric_basis"] = {
        "currency": market.get("currency") or "MXN",
        "timezone": market.get("timezone"),
        "historical_sales": {
            "id": "AMAZON_ORDERED_PRODUCT_SALES",
            "label": "Amazon ordered-product sales",
            "source": "Sales & Traffic / Data Kiosk",
            "definition": "Reconciled operating sales. Settlement/proceeds amounts are excluded.",
        },
        "product_sales": {
            "id": "AMAZON_ORDERED_PRODUCT_SALES",
            "label": "Amazon ordered-product sales",
            "source": "CHILD-ASIN Sales & Traffic mapped to canonical offer owner",
            "definition": "ASIN demand is attached exactly once to the canonical sellable offer; aliases and structural parents do not duplicate revenue.",
        },
        "today_and_orders": {
            "id": "GROSS_CUSTOMER_SPEND",
            "label": "Shopper spend incl. IVA",
            "source": "Amazon Orders",
            "definition": "Order grand total with gross item price × quantity fallback.",
        },
        "finance_boundary": "Finance separately reports net sales ex IVA, IVA, and gross customer spend.",
    }
    if payload.get("today"):
        payload["today"]["sales_basis"] = "GROSS_CUSTOMER_SPEND"
    return payload
