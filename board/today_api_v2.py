from __future__ import annotations

from datetime import date

from today_api import today_payload as _legacy_today_payload


def _gross_sku_sales(connect, marketplace: str, target: date) -> dict[str, dict]:
    """Return Today product contribution on one gross-customer-spend basis.

    Order-item proceeds fields are settlement/accounting amounts and may be net of
    Mexico IVA. They must never be mixed with Orders grand totals in the Today
    operating view. For product contribution we therefore use the order item's
    customer-facing unit price * quantity. Net sales/IVA belong in Finance and
    reconciled business reporting, not as an accidental per-SKU basis switch.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                i.seller_sku AS sku,
                COALESCE(sum(i.unit_price_amount * i.quantity_ordered), 0)::numeric(14,2) AS gross_sales,
                COALESCE(sum(i.quantity_ordered), 0)::bigint AS units,
                count(DISTINCT i.amazon_order_id)::bigint AS orders
            FROM core.amazon_order_item i
            JOIN core.amazon_order o USING (amazon_order_id)
            JOIN core.marketplace mp USING (marketplace_id)
            WHERE o.marketplace_id=%s
              AND i.seller_sku IS NOT NULL
              AND (o.created_time AT TIME ZONE mp.timezone)::date=%s::date
              AND o.fulfillment_status IS DISTINCT FROM 'CANCELLED'
            GROUP BY i.seller_sku
            """,
            (marketplace, target),
        )
        return {row["sku"]: row for row in cur.fetchall()}


def today_payload(connect, decorate_products, marketplace: str, selected_date: str | None = None) -> dict:
    payload = _legacy_today_payload(connect, decorate_products, marketplace, selected_date)
    target = payload.get("selected_date")
    if isinstance(target, str):
        target = date.fromisoformat(target)
    if not isinstance(target, date):
        return payload

    gross_by_sku = _gross_sku_sales(connect, marketplace, target)
    for product in payload.get("sku_today") or []:
        gross = gross_by_sku.get(product.get("sku"))
        if not gross:
            continue
        product["sales"] = gross["gross_sales"]
        product["units"] = gross["units"]
        product["orders"] = gross["orders"]
        product["sales_basis"] = "GROSS_CUSTOMER_SPEND"

    payload["product_contribution_sales_basis"] = "GROSS_CUSTOMER_SPEND"
    return payload
