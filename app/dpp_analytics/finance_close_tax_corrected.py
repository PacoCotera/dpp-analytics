from __future__ import annotations

"""Corrected Finance-close entry point for DPP Mexico tax basis.

Amazon Sales & Traffic orderedProductSales has been empirically reconciled in
production to shopper sales including IVA. The original close implementation
predated that evidence and treated the source as ex-IVA. We reuse its immutable
close/state machinery but normalize the snapshot before any new CLOSED or
RESTATED version is written.
"""

from . import finance_close as _legacy

VAT_RATE = _legacy.VAT_RATE
SOURCE_BASIS = "AMAZON_SALES_TRAFFIC_GROSS_INCL_IVA"
_original_month_snapshot = _legacy._month_snapshot
_original_write_close = _legacy._write_close


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


def _write_close(cur, marketplace, snap, version, *, restatement_reason=None):
    # Preserve the original writer and then enrich the immutable audit basis in
    # the same transaction. The update is allowed only before COMMIT; once the
    # close becomes durable, DB immutability guards prevent further mutation.
    _original_write_close(
        cur,
        marketplace,
        snap,
        version,
        restatement_reason=restatement_reason,
    )
    cur.execute(
        """
        UPDATE core.finance_month_close
        SET close_basis = close_basis || %s::jsonb
        WHERE marketplace_id=%s AND month=%s AND version=%s
        """,
        (
            __import__("json").dumps({
                "sales_source": "Amazon Sales & Traffic orderedProductSales",
                "sales_source_tax_basis": SOURCE_BASIS,
                "sales_tax_transform": snap.get("sales_tax_transform"),
                "vat_rate": VAT_RATE,
            }),
            marketplace,
            snap["month"],
            version,
        ),
    )


# Patch only inside this explicit corrected entry point. Existing historical
# versions are untouched; new versions receive the corrected basis.
_legacy._month_snapshot = _corrected_month_snapshot
_legacy._write_close = _write_close

close_ready_months = _legacy.close_ready_months
restate_month = _legacy.restate_month
main = _legacy.main


if __name__ == "__main__":
    main()
