from __future__ import annotations

"""Finance-close compatibility layer for the verified Sales & Traffic tax basis.

The original close worker correctly owns close readiness, COGS freezing,
advertising selection, append-only versions and explicit restatement. Its one
incorrect assumption was that mart.business_daily.sales was already net of IVA.
Production reconciliation proved DPP MX orderedProductSales is shopper spend
including IVA. Patch only that snapshot interpretation and leave close mechanics
unchanged.
"""

from . import finance_close_legacy as _legacy


def _tax_policy(cur, marketplace: str) -> tuple[float, str]:
    cur.execute(
        """SELECT standard_vat_rate,sales_traffic_amount_basis
           FROM core.marketplace_tax_policy WHERE marketplace_id=%s""",
        (marketplace,),
    )
    row = cur.fetchone() or {}
    return float(row.get("standard_vat_rate") or 0), str(row.get("sales_traffic_amount_basis") or "UNKNOWN")


_original_month_snapshot = _legacy._month_snapshot


def _month_snapshot(cur, marketplace: str, month, costs: dict[str, object]) -> dict:
    snap = _original_month_snapshot(cur, marketplace, month, costs)
    rate, basis = _tax_policy(cur, marketplace)
    if basis != "SHOPPER_SPEND_INCL_TAX":
        return snap

    # Legacy net_sales_ex_vat contains raw Sales & Traffic. For this marketplace
    # that raw amount is actually the customer-facing gross amount including IVA.
    gross = round(float(snap.get("net_sales_ex_vat") or 0), 2)
    net = round(gross / (1.0 + rate), 2) if rate > 0 else gross
    iva = round(gross - net, 2)
    snap["net_sales_ex_vat"] = net
    snap["iva_on_sales"] = iva
    snap["shopper_product_spend"] = gross
    snap["amazon_order_effect"] = round(float(snap.get("amazon_order_net") or 0) - net, 2)
    if snap.get("contribution_after_product_cogs") is not None:
        contribution = float(snap.get("contribution_after_product_cogs") or 0)
        snap["contribution_margin_pct"] = round(100.0 * contribution / net, 2) if net else None
    snap["sales_source_basis"] = "SHOPPER_SPEND_INCL_TAX"
    return snap


# Functions defined in the legacy module resolve _month_snapshot from that
# module's globals. Replace it there, then expose the unchanged public API.
_legacy._month_snapshot = _month_snapshot
close_ready_months = _legacy.close_ready_months
restate_month = _legacy.restate_month
main = _legacy.main


if __name__ == "__main__":
    main()
