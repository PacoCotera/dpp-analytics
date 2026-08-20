from __future__ import annotations

import json
import os
from datetime import timedelta
from pathlib import Path


def _one(cur, sql: str, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _all(cur, sql: str, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def _load_product_costs() -> dict[str, float]:
    path = Path(os.getenv("PRODUCT_COSTS_PATH", "/app/product_costs.json"))
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    raw = raw.get("costs", raw) if isinstance(raw, dict) else {}
    out: dict[str, float] = {}
    for sku, value in raw.items():
        if not isinstance(sku, str) or sku.startswith("_"):
            continue
        if isinstance(value, dict):
            value = value.get("unit_cogs")
        try:
            amount = float(value)
        except (TypeError, ValueError):
            continue
        if amount >= 0:
            out[sku] = amount
    return out


def _cogs_for_window(cur, marketplace: str, start_ts, end_ts, costs: dict[str, float]) -> dict:
    rows = _all(cur, """
        WITH shipped_orders AS (
          SELECT DISTINCT amazon_order_id
          FROM core.financial_transaction
          WHERE marketplace_id=%s
            AND posted_date>=%s::timestamptz
            AND posted_date<=%s::timestamptz
            AND transaction_type='Shipment'
            AND amazon_order_id IS NOT NULL
        )
        SELECT i.seller_sku AS sku, COALESCE(sum(i.quantity_ordered),0)::bigint AS units
        FROM shipped_orders so
        JOIN core.amazon_order_item i USING (amazon_order_id)
        WHERE i.seller_sku IS NOT NULL
        GROUP BY i.seller_sku
        ORDER BY units DESC, i.seller_sku
    """, (marketplace, start_ts, end_ts))
    total_units = covered_units = 0
    known_cogs = 0.0
    out = []
    for row in rows:
        sku = row.get("sku")
        units = int(row.get("units") or 0)
        total_units += units
        unit_cogs = costs.get(sku)
        configured = unit_cogs is not None
        extended = round(units * unit_cogs, 2) if configured else None
        if configured:
            covered_units += units
            known_cogs += extended or 0.0
        out.append({
            "sku": sku,
            "units": units,
            "unit_cogs": round(unit_cogs, 2) if configured else None,
            "extended_cogs": extended,
            "configured": configured,
        })
    return {
        "rows": out,
        "total_units": total_units,
        "covered_units": covered_units,
        "known_cogs": round(known_cogs, 2),
        "coverage_pct": round(100.0 * covered_units / total_units, 1) if total_units else 100.0,
        "complete": total_units == covered_units,
    }


def finance_payload(connect, marketplace: str) -> dict:
    """Resilient finance statement based on proven Finances + Sales marts.

    Settlement ingestion continues independently, but Finance must never become
    unavailable while settlement normalization is being hardened.
    """
    with connect() as conn, conn.cursor() as cur:
        cutoff = _one(cur,
            "SELECT max(posted_date) AS posted_at FROM core.financial_transaction WHERE marketplace_id=%s",
            (marketplace,),
        ).get("posted_at")
        local_time = _one(cur,
            "SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'America/Mexico_City','HH24:MI') AS local_time"
        ).get("local_time")
        if cutoff is None:
            return {"summary": {}, "statement": {}, "types": [], "daily": [], "breakdowns": [], "recent": [], "cogs": [], "local_time": local_time}

        window = _one(cur, """
            SELECT date_trunc('month', %s::timestamptz AT TIME ZONE 'America/Mexico_City') AT TIME ZONE 'America/Mexico_City' AS mtd_start,
                   (date_trunc('month', %s::timestamptz AT TIME ZONE 'America/Mexico_City'))::date AS start_date,
                   (%s::timestamptz AT TIME ZONE 'America/Mexico_City')::date AS through_date
        """, (cutoff, cutoff, cutoff))
        mtd_start = window["mtd_start"]

        summary = _one(cur, """
            SELECT
              count(*) FILTER (WHERE posted_date>=%s::timestamptz-interval '28 days')::int AS transactions_28,
              COALESCE(sum(total_amount) FILTER (WHERE posted_date>=%s::timestamptz-interval '28 days' AND transaction_type='Shipment'),0)::numeric(16,2) AS shipment_amount_28,
              COALESCE(sum(total_amount) FILTER (WHERE posted_date>=%s::timestamptz-interval '28 days' AND transaction_type='Refund'),0)::numeric(16,2) AS refund_amount_28,
              COALESCE(sum(total_amount) FILTER (WHERE posted_date>=%s::timestamptz-interval '28 days' AND transaction_type='ProductAdsPayment'),0)::numeric(16,2) AS ads_amount_28,
              COALESCE(sum(total_amount) FILTER (WHERE posted_date>=%s::timestamptz-interval '28 days' AND transaction_type='ServiceFee'),0)::numeric(16,2) AS service_fee_amount_28,
              COALESCE(sum(total_amount) FILTER (WHERE posted_date>=%s::timestamptz-interval '28 days' AND transaction_type NOT IN ('Transfer','DebtRecovery','AdhocDisbursement')),0)::numeric(16,2) AS operating_ledger_balance_28,
              max(posted_date) AS latest_posted
            FROM core.financial_transaction
            WHERE marketplace_id=%s AND posted_date>=%s::timestamptz-interval '56 days'
        """, (cutoff, cutoff, cutoff, cutoff, cutoff, cutoff, marketplace, cutoff))

        sales_mtd = _one(cur, """
            SELECT COALESCE(sum(sales),0)::numeric(16,2) AS sales,
                   COALESCE(sum(orders),0)::bigint AS orders,
                   COALESCE(sum(units),0)::bigint AS units
            FROM mart.business_daily
            WHERE marketplace_id=%s
              AND business_date BETWEEN %s::date AND %s::date
        """, (marketplace, window["start_date"], window["through_date"]))

        finance_mtd = _one(cur, """
            SELECT
              COALESCE(sum(total_amount) FILTER (WHERE transaction_type='ProductAdsPayment'),0)::numeric(16,2) AS advertising,
              COALESCE(sum(total_amount) FILTER (WHERE transaction_type='Refund'),0)::numeric(16,2) AS refunds,
              COALESCE(sum(total_amount) FILTER (WHERE transaction_type IN ('Adjustment','MiscellaneousLedgerAdjustment','FBAInventoryReimbursement')),0)::numeric(16,2) AS adjustments,
              COALESCE(sum(total_amount) FILTER (WHERE transaction_type='Transfer'),0)::numeric(16,2) AS transfers,
              COALESCE(sum(total_amount) FILTER (WHERE transaction_type NOT IN ('Transfer','DebtRecovery','AdhocDisbursement')),0)::numeric(16,2) AS operating_net
            FROM core.financial_transaction
            WHERE marketplace_id=%s AND posted_date>=%s::timestamptz AND posted_date<=%s::timestamptz
        """, (marketplace, mtd_start, cutoff))

        leaf = _one(cur, """
            SELECT
              COALESCE(sum(amount) FILTER (WHERE lower(breakdown_path) LIKE '%tax%' AND amount>0),0)::numeric(16,2) AS tax_collected,
              COALESCE(sum(amount) FILTER (WHERE lower(breakdown_path) LIKE '%tax%' AND amount<0),0)::numeric(16,2) AS tax_withheld,
              COALESCE(sum(amount) FILTER (WHERE lower(breakdown_path) ~ '(promotion|discount|rebate)'),0)::numeric(16,2) AS promotions,
              COALESCE(sum(amount) FILTER (WHERE lower(breakdown_path) ~ '(commission|referral)'),0)::numeric(16,2) AS selling_fees,
              COALESCE(sum(amount) FILTER (WHERE lower(breakdown_path) ~ '(fba|fulfill)' AND lower(breakdown_path) LIKE '%fee%'),0)::numeric(16,2) AS fba_fees,
              COALESCE(sum(amount) FILTER (WHERE lower(breakdown_path) LIKE '%fee%' AND lower(breakdown_path) !~ '(commission|referral|fba|fulfill)'),0)::numeric(16,2) AS other_amazon_fees
            FROM mart.finance_leaf_breakdown
            WHERE marketplace_id=%s AND posted_date>=%s::timestamptz AND posted_date<=%s::timestamptz
        """, (marketplace, mtd_start, cutoff))

        costs = _load_product_costs()
        cogs_mtd = _cogs_for_window(cur, marketplace, mtd_start, cutoff, costs)
        cogs28 = _cogs_for_window(cur, marketplace, cutoff - timedelta(days=28), cutoff, costs)
        operating_net = float(finance_mtd.get("operating_net") or 0)
        after_mtd = round(operating_net - cogs_mtd["known_cogs"], 2) if cogs_mtd["complete"] else None
        after28 = round(float(summary.get("operating_ledger_balance_28") or 0) - cogs28["known_cogs"], 2) if cogs28["complete"] else None
        summary.update({
            "product_cogs_known_28": cogs28["known_cogs"],
            "product_cogs_units_total_28": cogs28["total_units"],
            "product_cogs_units_covered_28": cogs28["covered_units"],
            "product_cogs_coverage_pct_28": cogs28["coverage_pct"],
            "product_cogs_complete_28": cogs28["complete"],
            "contribution_after_product_cogs_28": after28,
            "remaining_off_amazon_room_28": max(after28, 0) if after28 is not None else None,
        })

        statement = {
            "period": "MTD",
            "period_start": window["start_date"],
            "through_date": window["through_date"],
            "source": "finance_breakdown_fallback",
            "source_note": "Provisional management statement from Sales & Traffic plus Finances v2024 while settlement normalization is validated.",
            "settlement_reports_available": 0,
            "latest_settlement_end": None,
            "sales": float(sales_mtd.get("sales") or 0),
            "orders": int(sales_mtd.get("orders") or 0),
            "units": int(sales_mtd.get("units") or 0),
            "tax_collected": float(leaf.get("tax_collected") or 0),
            "tax_withheld": float(leaf.get("tax_withheld") or 0),
            "promotions": float(leaf.get("promotions") or 0),
            "refunds": float(finance_mtd.get("refunds") or 0),
            "selling_fees": float(leaf.get("selling_fees") or 0),
            "fba_fees": float(leaf.get("fba_fees") or 0),
            "other_amazon_fees": float(leaf.get("other_amazon_fees") or 0),
            "advertising": float(finance_mtd.get("advertising") or 0),
            "adjustments": float(finance_mtd.get("adjustments") or 0),
            "amazon_operating_net": operating_net,
            "product_cogs": cogs_mtd["known_cogs"],
            "cogs_complete": cogs_mtd["complete"],
            "cogs_coverage_pct": cogs_mtd["coverage_pct"],
            "after_product_cogs": after_mtd,
            "cash_transferred": float(finance_mtd.get("transfers") or 0),
        }

        types = _all(cur, """
            SELECT transaction_type,count(*)::int AS transactions,sum(total_amount)::numeric(16,2) AS amount
            FROM core.financial_transaction
            WHERE marketplace_id=%s AND posted_date>=%s::timestamptz-interval '90 days'
            GROUP BY transaction_type ORDER BY abs(sum(total_amount)) DESC
        """, (marketplace, cutoff))

        daily = _all(cur, """
            SELECT (posted_date AT TIME ZONE 'America/Mexico_City')::date AS business_date,
                   COALESCE(sum(total_amount) FILTER (WHERE transaction_type NOT IN ('Transfer','DebtRecovery','AdhocDisbursement')),0)::numeric(16,2) AS operating_balance
            FROM core.financial_transaction
            WHERE marketplace_id=%s AND posted_date>=%s::timestamptz-interval '90 days'
            GROUP BY 1 ORDER BY 1
        """, (marketplace, cutoff))

        breakdowns = _all(cur, """
            SELECT breakdown_type,count(*)::int AS entries,COALESCE(sum(amount),0)::numeric(16,2) AS amount
            FROM mart.finance_leaf_breakdown
            WHERE marketplace_id=%s AND posted_date>=%s::timestamptz-interval '28 days'
            GROUP BY breakdown_type ORDER BY abs(sum(amount)) DESC LIMIT 30
        """, (marketplace, cutoff))

        recent = _all(cur, """
            SELECT transaction_type,transaction_status,description,total_amount AS amount,
                   to_char(posted_date AT TIME ZONE 'America/Mexico_City','MM-DD HH24:MI') AS local_time,
                   extract(epoch from (%s::timestamptz-posted_date))::bigint AS age_seconds
            FROM core.financial_transaction
            WHERE marketplace_id=%s ORDER BY posted_date DESC LIMIT 40
        """, (cutoff, marketplace))

        return {
            "summary": summary,
            "statement": statement,
            "types": types,
            "daily": daily,
            "breakdowns": breakdowns,
            "recent": recent,
            "cogs": cogs28["rows"],
            "local_time": local_time,
        }
