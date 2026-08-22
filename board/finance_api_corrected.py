from __future__ import annotations

"""Canonical Finance adapter for Sales & Traffic tax basis.

Amazon Sales & Traffic orderedProductSales is empirically shopper spend including
IVA for DPP Mexico. Operating surfaces keep that amount gross. Finance removes
IVA explicitly so net revenue, withheld IVA and gross customer spend are three
separate values. Immutable closed history is read as stored; migration 037
appends corrected RESTATED versions rather than rewriting prior closes.
"""

from finance_api_legacy import finance_payload as _legacy_finance_payload


def _policy(connect, marketplace: str) -> dict:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT standard_vat_rate,sales_traffic_amount_basis
               FROM core.marketplace_tax_policy WHERE marketplace_id=%s""",
            (marketplace,),
        )
        return cur.fetchone() or {}


def _derive_finance_sales(row: dict, rate: float) -> None:
    """Convert the legacy OPEN/finalizing raw report amount from gross to Finance basis."""
    if not row:
        return
    gross = round(float(row.get("net_sales_ex_vat") or 0), 2)
    net = round(gross / (1.0 + rate), 2) if rate > 0 else gross
    iva = round(gross - net, 2)
    row["net_sales_ex_vat"] = net
    row["iva_on_sales"] = iva
    row["shopper_product_spend"] = gross
    if row.get("amazon_order_net") is not None:
        row["amazon_order_effect"] = round(float(row.get("amazon_order_net") or 0) - net, 2)
    if row.get("contribution_after_product_cogs") is not None:
        contribution = float(row.get("contribution_after_product_cogs") or 0)
        row["contribution_margin_pct"] = round(100.0 * contribution / net, 1) if net else None
    row["sales_source_basis"] = "SHOPPER_SPEND_INCL_TAX"
    row["finance_revenue_basis"] = "NET_SALES_EX_TAX"


def finance_payload(connect, marketplace: str) -> dict:
    payload = _legacy_finance_payload(connect, marketplace)
    policy = _policy(connect, marketplace)
    rate = float(policy.get("standard_vat_rate") or 0)
    source_basis = policy.get("sales_traffic_amount_basis") or "UNKNOWN"

    if source_basis == "SHOPPER_SPEND_INCL_TAX":
        _derive_finance_sales(payload.get("current_month") or {}, rate)
        for row in payload.get("finalizing_months") or []:
            _derive_finance_sales(row, rate)

    payload["metric_basis"] = {
        "sales_traffic_source": "Amazon Sales & Traffic orderedProductSales",
        "sales_traffic_amount_basis": source_basis,
        "standard_vat_rate": rate,
        "finance_net_sales": "Gross Sales & Traffic shopper spend / (1 + VAT rate)",
        "iva_withheld": "Gross shopper spend - net sales ex IVA",
        "gross_customer_spend": "Amazon Sales & Traffic shopper spend including IVA",
        "payout": "Separate settlement cash timing after tax withholding and Amazon deductions",
    }
    return payload
