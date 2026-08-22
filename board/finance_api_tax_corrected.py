from __future__ import annotations

"""Tax-basis adapter for the immutable-close Finance API.

Production evidence shows Amazon Sales & Traffic orderedProductSales for DPP MX
tracks shopper-facing sales including IVA. The legacy Finance implementation
historically treated that source as ex-IVA. This adapter corrects OPEN and
not-yet-closed periods while leaving immutable CLOSED/RESTATED snapshots
untouched. Legacy closed snapshots are explicitly flagged for restatement rather
than silently rewritten.
"""

from finance_emergency_legacy import finance_payload as _legacy_finance_payload

VAT_RATE = 0.16
SOURCE_BASIS = "AMAZON_SALES_TRAFFIC_GROSS_INCL_IVA"


def _correct_live_period(row: dict) -> None:
    if not row:
        return
    # In the legacy payload this field contains the untransformed Sales & Traffic
    # amount. Production reconciliation proves that amount is gross incl. IVA.
    gross = float(row.get("net_sales_ex_vat") or 0)
    net = gross / (1.0 + VAT_RATE) if gross else 0.0
    iva = gross - net
    order_net = float(row.get("amazon_order_net") or 0)
    row["shopper_product_spend"] = round(gross, 2)
    row["net_sales_ex_vat"] = round(net, 2)
    row["iva_on_sales"] = round(iva, 2)
    row["amazon_order_effect"] = round(order_net - net, 2)
    row["vat_rate"] = VAT_RATE
    row["sales_source_tax_basis"] = SOURCE_BASIS
    row["sales_tax_transform"] = "net=gross/(1+vat); iva=gross-net"


def _closed_basis_valid(row: dict) -> bool:
    basis = row.get("close_basis") if isinstance(row.get("close_basis"), dict) else {}
    return basis.get("sales_source_tax_basis") == SOURCE_BASIS


def finance_payload(connect, marketplace: str) -> dict:
    payload = _legacy_finance_payload(connect, marketplace)
    _correct_live_period(payload.get("current_month") or {})
    for row in payload.get("finalizing_months") or []:
        _correct_live_period(row)

    invalid_closed = []
    for row in payload.get("closed_months") or []:
        valid = _closed_basis_valid(row)
        row["sales_tax_basis_status"] = "VALID" if valid else "LEGACY_RESTATEMENT_REQUIRED"
        if not valid:
            invalid_closed.append(str(row.get("month") or "")[:7])

    summary = payload.setdefault("summary", {})
    summary["sales_source_tax_basis"] = SOURCE_BASIS
    summary["sales_tax_basis_evidence"] = "production Sales & Traffic vs normalized Orders"
    summary["closed_tax_basis_restatement_required"] = len(invalid_closed)
    summary["closed_tax_basis_restatement_months"] = invalid_closed

    payload["metric_basis"] = {
        "sales_and_traffic": {
            "basis": "GROSS_CUSTOMER_SPEND",
            "tax": "INCLUDES_IVA",
            "source": "Amazon Sales & Traffic orderedProductSales",
            "definition": "Production reconciliation shows orderedProductSales tracks shopper-facing sales including IVA.",
        },
        "finance_net_sales": {
            "basis": "NET_SALES_EX_IVA",
            "definition": "Derived from Sales & Traffic gross sales as gross / 1.16 for DPP Mexico.",
        },
        "iva_withheld": {
            "basis": "IVA_WITHHELD",
            "definition": "Gross shopper sales minus net sales ex IVA; Amazon withholds/remits this tax and it is not payout cash.",
        },
        "closed_history": {
            "immutable": True,
            "legacy_restatement_required_months": invalid_closed,
            "definition": "A legacy close is never silently corrected. It requires an explicit RESTATED version with an audit reason.",
        },
    }
    return payload
