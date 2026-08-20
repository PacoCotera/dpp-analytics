from __future__ import annotations

"""Emergency no-500 Finance payload.

This is intentionally defensive: Finance should remain available even if one
secondary mart/view is temporarily broken. It returns the strongest statement it
can build from core financial transactions and only treats detail enrichments as
optional.
"""

import json
import os
from datetime import timedelta
from pathlib import Path


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


def _empty_statement(source_note="Finance source is temporarily degraded."):
    return {
        "period": "MTD", "period_start": None, "through_date": None,
        "source": "degraded_fallback", "source_note": source_note,
        "settlement_reports_available": 0, "latest_settlement_end": None,
        "sales": 0.0, "orders": 0, "units": 0,
        "tax_collected": 0.0, "tax_withheld": 0.0, "promotions": 0.0,
        "refunds": 0.0, "selling_fees": 0.0, "fba_fees": 0.0,
        "other_amazon_fees": 0.0, "advertising": 0.0, "adjustments": 0.0,
        "amazon_operating_net": 0.0, "product_cogs": 0.0,
        "cogs_complete": False, "cogs_coverage_pct": 0.0,
        "after_product_cogs": None, "cash_transferred": 0.0,
    }


def finance_payload(connect, marketplace: str) -> dict:
    local_time = None
    errors = []
    try:
        with connect() as conn, conn.cursor() as cur:
            try:
                local_time = _one(cur, "SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'America/Mexico_City','HH24:MI') AS local_time").get("local_time")
            except Exception as exc:
                errors.append(f"clock:{type(exc).__name__}:{exc}")
                conn.rollback()

            try:
                cutoff = _one(cur, "SELECT max(posted_date) AS posted_at FROM core.financial_transaction WHERE marketplace_id=%s", (marketplace,)).get("posted_at")
            except Exception as exc:
                errors.append(f"cutoff:{type(exc).__name__}:{exc}")
                conn.rollback()
                cutoff = None

            if cutoff is None:
                st = _empty_statement("No finance postings are currently available.")
                return {"summary": {}, "statement": st, "types": [], "daily": [], "breakdowns": [], "recent": [], "cogs": [], "local_time": local_time, "diagnostic": errors}

            # The primary statement uses only the proven core finance table. Every
            # enrichment below is optional and isolated so one broken mart cannot
            # take down Finance.
            start = cutoff.astimezone().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
            try:
                base = _one(cur, """
                    SELECT
                      COALESCE(sum(total_amount) FILTER (WHERE transaction_type='Shipment'),0)::numeric(16,2) AS shipments,
                      COALESCE(sum(total_amount) FILTER (WHERE transaction_type='Refund'),0)::numeric(16,2) AS refunds,
                      COALESCE(sum(total_amount) FILTER (WHERE transaction_type='ProductAdsPayment'),0)::numeric(16,2) AS advertising,
                      COALESCE(sum(total_amount) FILTER (WHERE transaction_type='ServiceFee'),0)::numeric(16,2) AS service_fees,
                      COALESCE(sum(total_amount) FILTER (WHERE transaction_type IN ('Adjustment','MiscellaneousLedgerAdjustment','FBAInventoryReimbursement')),0)::numeric(16,2) AS adjustments,
                      COALESCE(sum(total_amount) FILTER (WHERE transaction_type='Transfer'),0)::numeric(16,2) AS transfers,
                      COALESCE(sum(total_amount) FILTER (WHERE transaction_type NOT IN ('Transfer','DebtRecovery','AdhocDisbursement')),0)::numeric(16,2) AS operating_net,
                      count(*)::int AS transactions
                    FROM core.financial_transaction
                    WHERE marketplace_id=%s AND posted_date>=%s AND posted_date<=%s
                """, (marketplace, start, cutoff))
            except Exception as exc:
                errors.append(f"base:{type(exc).__name__}:{exc}")
                conn.rollback()
                base = {}

            sales = orders = units = 0
            try:
                s = _one(cur, """
                    SELECT COALESCE(sum(sales),0)::numeric(16,2) AS sales,
                           COALESCE(sum(orders),0)::bigint AS orders,
                           COALESCE(sum(units),0)::bigint AS units
                    FROM mart.business_daily
                    WHERE marketplace_id=%s
                      AND business_date BETWEEN (%s AT TIME ZONE 'America/Mexico_City')::date
                                            AND (%s AT TIME ZONE 'America/Mexico_City')::date
                """, (marketplace, start, cutoff))
                sales = float(s.get("sales") or 0)
                orders = int(s.get("orders") or 0)
                units = int(s.get("units") or 0)
            except Exception as exc:
                errors.append(f"sales:{type(exc).__name__}:{exc}")
                conn.rollback()
                # Shipment finance amount is not identical to ordered product sales,
                # but is preferable to blanking the whole page in degraded mode.
                sales = float(base.get("shipments") or 0)

            leaf = {}
            try:
                leaf = _one(cur, """
                    SELECT
                      COALESCE(sum(amount) FILTER (WHERE lower(breakdown_path) LIKE '%tax%' AND amount>0),0)::numeric(16,2) AS tax_collected,
                      COALESCE(sum(amount) FILTER (WHERE lower(breakdown_path) LIKE '%tax%' AND amount<0),0)::numeric(16,2) AS tax_withheld,
                      COALESCE(sum(amount) FILTER (WHERE lower(breakdown_path) ~ '(promotion|discount|rebate)'),0)::numeric(16,2) AS promotions,
                      COALESCE(sum(amount) FILTER (WHERE lower(breakdown_path) ~ '(commission|referral)'),0)::numeric(16,2) AS selling_fees,
                      COALESCE(sum(amount) FILTER (WHERE lower(breakdown_path) ~ '(fba|fulfill)' AND lower(breakdown_path) LIKE '%fee%'),0)::numeric(16,2) AS fba_fees,
                      COALESCE(sum(amount) FILTER (WHERE lower(breakdown_path) LIKE '%fee%' AND lower(breakdown_path) !~ '(commission|referral|fba|fulfill)'),0)::numeric(16,2) AS other_amazon_fees
                    FROM mart.finance_leaf_breakdown
                    WHERE marketplace_id=%s AND posted_date>=%s AND posted_date<=%s
                """, (marketplace, start, cutoff))
            except Exception as exc:
                errors.append(f"leaf:{type(exc).__name__}:{exc}")
                conn.rollback()

            cogs_rows = []
            known_cogs = 0.0
            total_units = covered_units = 0
            try:
                costs = _costs()
                rows = _all(cur, """
                    WITH shipped_orders AS (
                      SELECT DISTINCT amazon_order_id
                      FROM core.financial_transaction
                      WHERE marketplace_id=%s AND posted_date>=%s AND posted_date<=%s
                        AND transaction_type='Shipment' AND amazon_order_id IS NOT NULL
                    )
                    SELECT i.seller_sku AS sku, COALESCE(sum(i.quantity_ordered),0)::bigint AS units
                    FROM shipped_orders so JOIN core.amazon_order_item i USING (amazon_order_id)
                    WHERE i.seller_sku IS NOT NULL
                    GROUP BY i.seller_sku ORDER BY units DESC, i.seller_sku
                """, (marketplace, start, cutoff))
                for r in rows:
                    sku = r.get("sku"); u = int(r.get("units") or 0); total_units += u
                    unit_cogs = costs.get(sku); configured = unit_cogs is not None
                    ext = round(u * unit_cogs, 2) if configured else None
                    if configured:
                        covered_units += u; known_cogs += ext or 0
                    cogs_rows.append({"sku": sku, "units": u, "unit_cogs": unit_cogs, "extended_cogs": ext, "configured": configured})
            except Exception as exc:
                errors.append(f"cogs:{type(exc).__name__}:{exc}")
                conn.rollback()

            cogs_complete = total_units == covered_units and total_units > 0
            operating_net = float(base.get("operating_net") or 0)
            after_cogs = round(operating_net - known_cogs, 2) if cogs_complete else None
            coverage = round(100 * covered_units / total_units, 1) if total_units else 0.0

            statement = {
                "period": "MTD",
                "period_start": start.date(),
                "through_date": cutoff.date(),
                "source": "finance_core_resilient",
                "source_note": "Provisional management statement from Amazon Finances v2024, with optional Sales & Traffic and fee-breakdown enrichments.",
                "settlement_reports_available": 0,
                "latest_settlement_end": None,
                "sales": sales, "orders": orders, "units": units,
                "tax_collected": float(leaf.get("tax_collected") or 0),
                "tax_withheld": float(leaf.get("tax_withheld") or 0),
                "promotions": float(leaf.get("promotions") or 0),
                "refunds": float(base.get("refunds") or 0),
                "selling_fees": float(leaf.get("selling_fees") or 0),
                "fba_fees": float(leaf.get("fba_fees") or 0),
                "other_amazon_fees": float(leaf.get("other_amazon_fees") or base.get("service_fees") or 0),
                "advertising": float(base.get("advertising") or 0),
                "adjustments": float(base.get("adjustments") or 0),
                "amazon_operating_net": operating_net,
                "product_cogs": round(known_cogs, 2),
                "cogs_complete": cogs_complete,
                "cogs_coverage_pct": coverage,
                "after_product_cogs": after_cogs,
                "cash_transferred": float(base.get("transfers") or 0),
            }

            summary = {
                "transactions_28": int(base.get("transactions") or 0),
                "shipment_amount_28": float(base.get("shipments") or 0),
                "refund_amount_28": float(base.get("refunds") or 0),
                "ads_amount_28": float(base.get("advertising") or 0),
                "service_fee_amount_28": float(base.get("service_fees") or 0),
                "operating_ledger_balance_28": operating_net,
                "latest_posted": cutoff,
                "product_cogs_known_28": round(known_cogs, 2),
                "product_cogs_units_total_28": total_units,
                "product_cogs_units_covered_28": covered_units,
                "product_cogs_coverage_pct_28": coverage,
                "product_cogs_complete_28": cogs_complete,
                "contribution_after_product_cogs_28": after_cogs,
                "remaining_off_amazon_room_28": max(after_cogs, 0) if after_cogs is not None else None,
            }

            types = []; daily = []; breakdowns = []; recent = []
            try:
                types = _all(cur, """SELECT transaction_type,count(*)::int AS transactions,sum(total_amount)::numeric(16,2) AS amount FROM core.financial_transaction WHERE marketplace_id=%s AND posted_date>=%s-interval '90 days' GROUP BY transaction_type ORDER BY abs(sum(total_amount)) DESC""", (marketplace, cutoff))
                daily = _all(cur, """SELECT (posted_date AT TIME ZONE 'America/Mexico_City')::date AS business_date, COALESCE(sum(total_amount) FILTER (WHERE transaction_type NOT IN ('Transfer','DebtRecovery','AdhocDisbursement')),0)::numeric(16,2) AS operating_balance FROM core.financial_transaction WHERE marketplace_id=%s AND posted_date>=%s-interval '90 days' GROUP BY 1 ORDER BY 1""", (marketplace, cutoff))
                recent = _all(cur, """SELECT transaction_type,transaction_status,description,total_amount AS amount,to_char(posted_date AT TIME ZONE 'America/Mexico_City','MM-DD HH24:MI') AS local_time,extract(epoch from (%s-posted_date))::bigint AS age_seconds FROM core.financial_transaction WHERE marketplace_id=%s ORDER BY posted_date DESC LIMIT 40""", (cutoff, marketplace))
            except Exception as exc:
                errors.append(f"detail:{type(exc).__name__}:{exc}")
                conn.rollback()
            try:
                breakdowns = _all(cur, """SELECT breakdown_type,count(*)::int AS entries,COALESCE(sum(amount),0)::numeric(16,2) AS amount FROM mart.finance_leaf_breakdown WHERE marketplace_id=%s AND posted_date>=%s-interval '28 days' GROUP BY breakdown_type ORDER BY abs(sum(amount)) DESC LIMIT 30""", (marketplace, cutoff))
            except Exception as exc:
                errors.append(f"breakdowns:{type(exc).__name__}:{exc}")
                conn.rollback()

            return {"summary": summary, "statement": statement, "types": types, "daily": daily, "breakdowns": breakdowns, "recent": recent, "cogs": cogs_rows, "local_time": local_time, "diagnostic": errors}
    except Exception as exc:
        # Last line of defense: never turn a secondary Finance query into a 500.
        errors.append(f"fatal:{type(exc).__name__}:{exc}")
        return {"summary": {}, "statement": _empty_statement("Finance is running in degraded mode while a source query is repaired."), "types": [], "daily": [], "breakdowns": [], "recent": [], "cogs": [], "local_time": local_time, "diagnostic": errors}
