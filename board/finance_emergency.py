from __future__ import annotations

"""Resilient finance-manager payload.

Rules:
- Business sales are Amazon Sales & Traffic net product sales (ex IVA).
- Mexico IVA is calculated at the configured rate on that net sales base.
- Finances v2024 cash/accounting metrics use RELEASED transactions only. Amazon
  can return DEFERRED and RELEASED representations of the same economics; they
  must not be added together.
- Settlement detail enriches historical fee/tax classifications when available.
- Any optional source can fail without taking /api/finance down.
"""

import json
import os
from datetime import timedelta
from pathlib import Path

VAT_RATE = float(os.getenv("MX_VAT_RATE", "0.16"))
TZ = "America/Mexico_City"


def _one(cur, sql, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _all(cur, sql, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def _costs():
    path = Path(os.getenv("PRODUCT_COSTS_PATH", "/app/product_costs.json"))
    try:
        raw = json.loads(path.read_text())
    except Exception:
        return {}
    raw = raw.get("costs", raw) if isinstance(raw, dict) else {}
    out = {}
    for sku, value in raw.items():
        if not isinstance(sku, str) or sku.startswith("_"):
            continue
        if isinstance(value, dict):
            value = value.get("unit_cogs")
        try:
            n = float(value)
        except (TypeError, ValueError):
            continue
        if n >= 0:
            out[sku] = n
    return out


def _empty_statement(note="Finance source is temporarily degraded."):
    return {
        "period": "MTD", "period_start": None, "through_date": None,
        "source": "degraded_fallback", "source_note": note,
        "net_sales_ex_vat": 0.0, "sales": 0.0, "iva_on_sales": 0.0,
        "shopper_product_spend": 0.0, "vat_rate": VAT_RATE,
        "orders": 0, "units": 0, "advertising": 0.0,
        "released_shipment_net": 0.0, "refunds": 0.0,
        "service_fees": 0.0, "adjustments": 0.0,
        "amazon_operating_net": 0.0, "product_cogs": 0.0,
        "cogs_complete": False, "cogs_coverage_pct": 0.0,
        "after_product_cogs": None, "cash_transferred": 0.0,
        "settled_amazon_fees": None, "settled_tax_withheld": None,
        "settlement_lines": 0,
    }


def _month_cogs(cur, marketplace, first_month, through_date, costs):
    rows = _all(cur, f"""
        SELECT date_trunc('month',o.created_time AT TIME ZONE '{TZ}')::date AS month,
               i.seller_sku AS sku,
               COALESCE(sum(i.quantity_ordered),0)::bigint AS units
        FROM core.amazon_order o
        JOIN core.amazon_order_item i USING(amazon_order_id)
        WHERE o.marketplace_id=%s
          AND (o.created_time AT TIME ZONE '{TZ}')::date >= %s::date
          AND (o.created_time AT TIME ZONE '{TZ}')::date <= %s::date
          AND o.fulfillment_status IS DISTINCT FROM 'CANCELLED'
          AND i.seller_sku IS NOT NULL
        GROUP BY 1,2
        ORDER BY 1,2
    """, (marketplace, first_month, through_date))
    by_month = {}
    sku_rows = []
    for r in rows:
        month = str(r.get("month"))
        sku = r.get("sku")
        units = int(r.get("units") or 0)
        unit = costs.get(sku)
        m = by_month.setdefault(month, {"total_units": 0, "covered_units": 0, "cogs": 0.0})
        m["total_units"] += units
        configured = unit is not None
        ext = round(units * unit, 2) if configured else None
        if configured:
            m["covered_units"] += units
            m["cogs"] += ext or 0.0
        sku_rows.append({"month": month, "sku": sku, "units": units, "unit_cogs": unit, "extended_cogs": ext, "configured": configured})
    for m in by_month.values():
        m["cogs"] = round(m["cogs"], 2)
        m["complete"] = m["total_units"] == m["covered_units"]
        m["coverage_pct"] = round(100.0 * m["covered_units"] / m["total_units"], 1) if m["total_units"] else 100.0
    return by_month, sku_rows


def finance_payload(connect, marketplace: str) -> dict:
    errors = []
    local_time = None
    try:
        with connect() as conn, conn.cursor() as cur:
            try:
                local_time = _one(cur, f"SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE '{TZ}','HH24:MI') AS local_time").get("local_time")
                cutoff = _one(cur, "SELECT max(posted_date) AS posted_at FROM core.financial_transaction WHERE marketplace_id=%s", (marketplace,)).get("posted_at")
                last_sales_date = _one(cur, "SELECT max(business_date) AS d FROM mart.business_daily WHERE marketplace_id=%s AND reconciled_daily_report", (marketplace,)).get("d")
            except Exception as exc:
                conn.rollback(); errors.append(f"clock/cutoff:{type(exc).__name__}:{exc}"); cutoff = None; last_sales_date = None

            if cutoff is None:
                return {"summary": {}, "statement": _empty_statement("No finance postings are currently available."), "monthly": [], "types": [], "daily": [], "breakdowns": [], "recent": [], "cogs": [], "local_time": local_time, "diagnostic": errors}

            through_date = (cutoff.astimezone().date() if cutoff.tzinfo else cutoff.date())
            if last_sales_date and last_sales_date < through_date:
                through_date = last_sales_date
            month_start = through_date.replace(day=1)
            first_month = (month_start.replace(day=1) - timedelta(days=300)).replace(day=1)

            # Monthly net sales are the business topline. They exclude IVA.
            monthly = []
            try:
                monthly = _all(cur, f"""
                    WITH months AS (
                      SELECT generate_series(%s::date,date_trunc('month',%s::date)::date,interval '1 month')::date AS month
                    ), s AS (
                      SELECT date_trunc('month',business_date)::date AS month,
                             COALESCE(sum(sales),0)::numeric(16,2) AS net_sales,
                             COALESCE(sum(orders),0)::bigint AS orders,
                             COALESCE(sum(units),0)::bigint AS units
                      FROM mart.business_daily
                      WHERE marketplace_id=%s AND business_date BETWEEN %s::date AND %s::date
                      GROUP BY 1
                    ), f AS (
                      SELECT date_trunc('month',posted_date AT TIME ZONE '{TZ}')::date AS month,
                             COALESCE(sum(total_amount) FILTER (WHERE transaction_type='Shipment'),0)::numeric(16,2) AS released_shipment_net,
                             COALESCE(sum(total_amount) FILTER (WHERE transaction_type='ProductAdsPayment'),0)::numeric(16,2) AS advertising,
                             COALESCE(sum(total_amount) FILTER (WHERE transaction_type='Refund'),0)::numeric(16,2) AS refunds,
                             COALESCE(sum(total_amount) FILTER (WHERE transaction_type='ServiceFee'),0)::numeric(16,2) AS service_fees,
                             COALESCE(sum(total_amount) FILTER (WHERE transaction_type IN ('Adjustment','MiscellaneousLedgerAdjustment','FBAInventoryReimbursement')),0)::numeric(16,2) AS adjustments,
                             COALESCE(sum(total_amount) FILTER (WHERE transaction_type='Transfer'),0)::numeric(16,2) AS transfers,
                             COALESCE(sum(total_amount) FILTER (WHERE transaction_type NOT IN ('Transfer','DebtRecovery','AdhocDisbursement')),0)::numeric(16,2) AS operating_net
                      FROM core.financial_transaction
                      WHERE marketplace_id=%s
                        AND transaction_status='RELEASED'
                        AND posted_date >= %s::date
                        AND posted_date < (%s::date + interval '1 day')
                      GROUP BY 1
                    )
                    SELECT m.month,
                           COALESCE(s.net_sales,0)::numeric(16,2) AS net_sales,
                           COALESCE(s.orders,0)::bigint AS orders,
                           COALESCE(s.units,0)::bigint AS units,
                           COALESCE(f.released_shipment_net,0)::numeric(16,2) AS released_shipment_net,
                           COALESCE(f.advertising,0)::numeric(16,2) AS advertising,
                           COALESCE(f.refunds,0)::numeric(16,2) AS refunds,
                           COALESCE(f.service_fees,0)::numeric(16,2) AS service_fees,
                           COALESCE(f.adjustments,0)::numeric(16,2) AS adjustments,
                           COALESCE(f.transfers,0)::numeric(16,2) AS transfers,
                           COALESCE(f.operating_net,0)::numeric(16,2) AS operating_net
                    FROM months m LEFT JOIN s USING(month) LEFT JOIN f USING(month)
                    ORDER BY m.month
                """, (first_month, through_date, marketplace, first_month, through_date, marketplace, first_month, through_date))
            except Exception as exc:
                conn.rollback(); errors.append(f"monthly:{type(exc).__name__}:{exc}"); monthly = []

            # Settlement enrichment is intentionally optional. It is the best
            # source for fee/tax categories after a settlement closes.
            settlement_by_month = {}
            try:
                rows = _all(cur, f"""
                    SELECT date_trunc('month',posted_date_time AT TIME ZONE '{TZ}')::date AS month,
                           count(*)::int AS lines,
                           COALESCE(sum(amount) FILTER (WHERE finance_category='selling_fees'),0)::numeric(16,2) AS selling_fees,
                           COALESCE(sum(amount) FILTER (WHERE finance_category='fba_fees'),0)::numeric(16,2) AS fba_fees,
                           COALESCE(sum(amount) FILTER (WHERE finance_category='other_amazon_fees'),0)::numeric(16,2) AS other_fees,
                           COALESCE(sum(amount) FILTER (WHERE finance_category='tax_withheld'),0)::numeric(16,2) AS tax_withheld,
                           COALESCE(sum(amount) FILTER (WHERE finance_category='promotions'),0)::numeric(16,2) AS promotions,
                           COALESCE(sum(amount) FILTER (WHERE finance_category='refunds_other'),0)::numeric(16,2) AS settlement_refunds
                    FROM mart.settlement_finance_line
                    WHERE marketplace_id=%s AND posted_date_time >= %s::date AND posted_date_time < (%s::date + interval '1 day')
                    GROUP BY 1 ORDER BY 1
                """, (marketplace, first_month, through_date))
                settlement_by_month = {str(r["month"]): r for r in rows}
            except Exception as exc:
                conn.rollback(); errors.append(f"settlement:{type(exc).__name__}:{exc}")

            costs = _costs()
            cogs_by_month = {}; cogs_rows = []
            try:
                cogs_by_month, cogs_rows = _month_cogs(cur, marketplace, first_month, through_date, costs)
            except Exception as exc:
                conn.rollback(); errors.append(f"cogs:{type(exc).__name__}:{exc}")

            out_monthly = []
            for r in monthly:
                month = str(r.get("month"))
                net = float(r.get("net_sales") or 0)
                iva = round(net * VAT_RATE, 2)
                settle = settlement_by_month.get(month, {})
                c = cogs_by_month.get(month, {"cogs": 0.0, "complete": True, "coverage_pct": 100.0, "total_units": 0, "covered_units": 0})
                fees = round(float(settle.get("selling_fees") or 0) + float(settle.get("fba_fees") or 0) + float(settle.get("other_fees") or 0), 2) if settle else None
                operating = float(r.get("operating_net") or 0)
                after = round(operating - float(c.get("cogs") or 0), 2) if c.get("complete") else None
                out_monthly.append({
                    "month": month,
                    "net_sales_ex_vat": net,
                    "iva_on_sales": iva,
                    "shopper_product_spend": round(net + iva, 2),
                    "vat_rate": VAT_RATE,
                    "orders": int(r.get("orders") or 0),
                    "units": int(r.get("units") or 0),
                    "released_shipment_net": float(r.get("released_shipment_net") or 0),
                    "advertising": float(r.get("advertising") or 0),
                    "refunds": float(r.get("refunds") or 0),
                    "service_fees": float(r.get("service_fees") or 0),
                    "adjustments": float(r.get("adjustments") or 0),
                    "amazon_operating_net": operating,
                    "cash_transferred": float(r.get("transfers") or 0),
                    "settled_amazon_fees": fees,
                    "settled_tax_withheld": float(settle.get("tax_withheld") or 0) if settle else None,
                    "settled_promotions": float(settle.get("promotions") or 0) if settle else None,
                    "settlement_lines": int(settle.get("lines") or 0),
                    "product_cogs": float(c.get("cogs") or 0),
                    "cogs_complete": bool(c.get("complete")),
                    "cogs_coverage_pct": float(c.get("coverage_pct") or 0),
                    "after_product_cogs": after,
                    "partial": month == str(month_start),
                })

            current = next((m for m in reversed(out_monthly) if m["month"] == str(month_start)), None) or (out_monthly[-1] if out_monthly else None)
            if current:
                statement = {
                    "period": "MTD",
                    "period_start": month_start,
                    "through_date": through_date,
                    "source": "business_sales_plus_released_finance",
                    "source_note": "Sales are net of IVA. IVA is calculated at 16%. Amazon cash/accounting metrics include RELEASED transactions only; settlement categories enrich closed periods.",
                    **{k: v for k, v in current.items() if k not in ("month", "partial")},
                    "sales": current["net_sales_ex_vat"],
                    "tax_collected": current["iva_on_sales"],
                    "tax_withheld": current["settled_tax_withheld"],
                    "selling_fees": None,
                    "fba_fees": None,
                    "other_amazon_fees": current["settled_amazon_fees"],
                    "promotions": current["settled_promotions"],
                }
            else:
                statement = _empty_statement("Monthly finance sources are temporarily unavailable.")

            # 28-day released ledger summary; business sales remain separate.
            try:
                s28 = _one(cur, """
                    SELECT count(*)::int AS transactions_28,
                           COALESCE(sum(total_amount) FILTER (WHERE transaction_type='Shipment'),0)::numeric(16,2) AS shipment_amount_28,
                           COALESCE(sum(total_amount) FILTER (WHERE transaction_type='Refund'),0)::numeric(16,2) AS refund_amount_28,
                           COALESCE(sum(total_amount) FILTER (WHERE transaction_type='ProductAdsPayment'),0)::numeric(16,2) AS ads_amount_28,
                           COALESCE(sum(total_amount) FILTER (WHERE transaction_type='ServiceFee'),0)::numeric(16,2) AS service_fee_amount_28,
                           COALESCE(sum(total_amount) FILTER (WHERE transaction_type NOT IN ('Transfer','DebtRecovery','AdhocDisbursement')),0)::numeric(16,2) AS operating_ledger_balance_28
                    FROM core.financial_transaction
                    WHERE marketplace_id=%s AND transaction_status='RELEASED'
                      AND posted_date>%s-interval '28 days' AND posted_date<=%s
                """, (marketplace, cutoff, cutoff))
            except Exception as exc:
                conn.rollback(); errors.append(f"summary:{type(exc).__name__}:{exc}"); s28 = {}
            summary = {**s28, "latest_posted": cutoff, "latest_sales_date": last_sales_date, "vat_rate": VAT_RATE, "finance_status_basis": "RELEASED only"}

            try:
                types = _all(cur, """SELECT transaction_type,count(*)::int AS transactions,sum(total_amount)::numeric(16,2) AS amount FROM core.financial_transaction WHERE marketplace_id=%s AND transaction_status='RELEASED' AND posted_date>%s-interval '180 days' GROUP BY transaction_type ORDER BY abs(sum(total_amount)) DESC""", (marketplace, cutoff))
                daily = _all(cur, f"""SELECT (posted_date AT TIME ZONE '{TZ}')::date AS business_date, COALESCE(sum(total_amount) FILTER (WHERE transaction_type NOT IN ('Transfer','DebtRecovery','AdhocDisbursement')),0)::numeric(16,2) AS operating_balance FROM core.financial_transaction WHERE marketplace_id=%s AND transaction_status='RELEASED' AND posted_date>%s-interval '180 days' GROUP BY 1 ORDER BY 1""", (marketplace, cutoff))
                recent = _all(cur, f"""SELECT transaction_type,transaction_status,description,total_amount AS amount,to_char(posted_date AT TIME ZONE '{TZ}','MM-DD HH24:MI') AS local_time,extract(epoch from (%s-posted_date))::bigint AS age_seconds FROM core.financial_transaction WHERE marketplace_id=%s ORDER BY posted_date DESC LIMIT 50""", (cutoff, marketplace))
            except Exception as exc:
                conn.rollback(); errors.append(f"detail:{type(exc).__name__}:{exc}"); types=[]; daily=[]; recent=[]

            # Raw leaf sums are deliberately not returned as management metrics.
            # They are non-additive across Amazon transaction statuses and created
            # the misleading ProductCharges figure in the previous UI.
            return {
                "summary": summary,
                "statement": statement,
                "monthly": out_monthly,
                "types": types,
                "daily": daily,
                "breakdowns": [],
                "recent": recent,
                "cogs": cogs_rows,
                "local_time": local_time,
                "diagnostic": errors,
            }
    except Exception as exc:
        errors.append(f"fatal:{type(exc).__name__}:{exc}")
        return {"summary": {}, "statement": _empty_statement("Finance is running in degraded mode while a source query is repaired."), "monthly": [], "types": [], "daily": [], "breakdowns": [], "recent": [], "cogs": [], "local_time": local_time, "diagnostic": errors}
