from __future__ import annotations

"""Corrected Finance-close implementation for the observed Sales & Traffic basis.

Amazon Sales & Traffic orderedProductSales has been empirically reconciled in
production to shopper sales including IVA for DPP Mexico. The mature close
implementation predates that evidence and treated the source as ex-IVA.
Production packaging keeps that implementation as finance_close_legacy and
routes every close entry point through this module.
"""

from . import finance_close_legacy as _legacy

SOURCE_BASIS = "SHOPPER_SPEND_INCL_TAX"
_original_month_snapshot = _legacy._month_snapshot


def _policy(cur, marketplace: str) -> tuple[float, str]:
    cur.execute(
        """SELECT standard_vat_rate,sales_traffic_amount_basis
           FROM core.marketplace_tax_policy WHERE marketplace_id=%s""",
        (marketplace,),
    )
    row = cur.fetchone() or {}
    return float(row.get("standard_vat_rate") or 0), str(row.get("sales_traffic_amount_basis") or "UNKNOWN")


def _corrected_month_snapshot(cur, marketplace, month, costs):
    snap = _original_month_snapshot(cur, marketplace, month, costs)
    vat_rate, source_basis = _policy(cur, marketplace)

    # The legacy snapshot exposes the raw Sales & Traffic amount in the field
    # named net_sales_ex_vat. Only transform it when marketplace evidence says
    # the source itself is shopper spend including tax.
    if source_basis != SOURCE_BASIS:
        snap["sales_traffic_amount_basis"] = source_basis
        return snap

    gross = float(snap.get("net_sales_ex_vat") or 0)
    net = gross / (1.0 + vat_rate) if vat_rate > 0 else gross
    iva = gross - net
    order_net = float(snap.get("amazon_order_net") or 0)
    contribution = snap.get("contribution_after_product_cogs")

    snap["shopper_product_spend"] = round(gross, 2)
    snap["net_sales_ex_vat"] = round(net, 2)
    snap["iva_on_sales"] = round(iva, 2)
    snap["amazon_order_effect"] = round(order_net - net, 2)
    snap["vat_rate"] = vat_rate
    snap["sales_traffic_amount_basis"] = source_basis
    snap["sales_source_tax_basis"] = "AMAZON_SALES_TRAFFIC_GROSS_INCL_IVA"
    snap["sales_tax_basis"] = "SHOPPER_SPEND_INCL_VAT_SOURCE"
    snap["sales_tax_transform"] = "net=gross/(1+vat); iva=gross-net"
    if contribution is not None:
        snap["contribution_margin_pct"] = round(100.0 * float(contribution) / net, 2) if net else None
    return snap


# The legacy public functions resolve _month_snapshot from their own module
# globals, so replacing it here corrects scheduled closes and explicit
# restatements without copying the close-state/COGS machinery. Migration 038
# independently enforces the same arithmetic at the database insert boundary.
_legacy._month_snapshot = _corrected_month_snapshot

close_ready_months = _legacy.close_ready_months
restate_month = _legacy.restate_month
main = _legacy.main


if __name__ == "__main__":
    main()
