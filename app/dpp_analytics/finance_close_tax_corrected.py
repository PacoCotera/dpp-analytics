from __future__ import annotations

"""Corrected Finance-close implementation for DPP Mexico tax basis.

Amazon Sales & Traffic orderedProductSales has been empirically reconciled in
production to shopper sales including IVA. The legacy close implementation
predated that evidence and treated the source as ex-IVA. Production packaging
keeps that implementation as finance_close_legacy and routes every close entry
point through this module.
"""

from . import finance_close_legacy as _legacy

VAT_RATE = _legacy.VAT_RATE
SOURCE_BASIS = "AMAZON_SALES_TRAFFIC_GROSS_INCL_IVA"
_original_month_snapshot = _legacy._month_snapshot


def _corrected_month_snapshot(cur, marketplace, month, costs):
    snap = _original_month_snapshot(cur, marketplace, month, costs)
    gross = float(snap.get("net_sales_ex_vat") or 0)
    net = gross / (1.0 + VAT_RATE) if gross else 0.0
    iva = gross - net
    order_net = float(snap.get("amazon_order_net") or 0)
    contribution = snap.get("contribution_after_product_cogs")

    snap["shopper_product_spend"] = round(gross, 2)
    snap["net_sales_ex_vat"] = round(net, 2)
    snap["iva_on_sales"] = round(iva, 2)
    snap["amazon_order_effect"] = round(order_net - net, 2)
    snap["sales_source_tax_basis"] = SOURCE_BASIS
    snap["sales_tax_transform"] = "net=gross/(1+vat); iva=gross-net"
    if contribution is not None:
        snap["contribution_margin_pct"] = round(100.0 * float(contribution) / net, 2) if net else None
    return snap


# The legacy public functions resolve _month_snapshot from their own module
# globals, so replacing it here corrects scheduled closes and explicit
# restatements without copying the close-state/COGS machinery.
_legacy._month_snapshot = _corrected_month_snapshot

close_ready_months = _legacy.close_ready_months
restate_month = _legacy.restate_month
main = _legacy.main


if __name__ == "__main__":
    main()
