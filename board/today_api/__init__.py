from __future__ import annotations

from datetime import date
import importlib.util
from pathlib import Path

# Keep the mature Today payload implementation in the sibling module, then apply
# one canonical monetary-basis correction at the API boundary. A package wins
# normal import resolution over today_api.py, so server.py does not need a broad
# unrelated rewrite for this correction.
_legacy_path = Path(__file__).resolve().parent.parent / "today_api.py"
_spec = importlib.util.spec_from_file_location("_dpp_today_legacy", _legacy_path)
_legacy = importlib.util.module_from_spec(_spec)
assert _spec and _spec.loader
_spec.loader.exec_module(_legacy)


def _gross_sku_sales(connect, marketplace: str, target: date) -> dict[str, dict]:
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
    """Today payload with one consistent gross-customer-spend basis for live order facts.

    Settlement/proceeds amounts can be net of Mexico IVA and are accounting facts.
    Today is an operational customer-spend surface, so its SKU contribution must
    not mix those proceeds values with gross Orders totals.
    """
    payload = _legacy.today_payload(connect, decorate_products, marketplace, selected_date)
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
