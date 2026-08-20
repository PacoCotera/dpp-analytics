from __future__ import annotations

"""Finance payload with immutable historical closes.

OPEN month uses the editable standard-cost file for a provisional estimate.
Historical CLOSED months come only from core.finance_month_close snapshots, so a
later standard-cost edit cannot silently rewrite history. Amazon-side closure is
tracked separately from seller COGS completeness; a month may therefore be
AMAZON_CLOSED while waiting for a missing seller cost before its first
management-close snapshot is written by the worker.

Cost config is backward compatible. Scalar costs apply to all dates. A SKU may
also carry effective-dated history so an unclosed historical month uses the cost
that actually applied then rather than today's standard cost.
"""

import calendar
import json
import os
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

VAT_RATE = float(os.getenv("MX_VAT_RATE", "0.16"))
TZ = "America/Mexico_City"
CLOSE_GRACE_DAYS = int(os.getenv("FINANCE_ADS_CLOSE_GRACE_DAYS", "10"))


def _one(cur, sql, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _all(cur, sql, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def _next_month(d: date) -> date:
    return date(d.year + (1 if d.month == 12 else 0), 1 if d.month == 12 else d.month + 1, 1)


def _month_end(d: date) -> date:
    return date(d.year, d.month, calendar.monthrange(d.year, d.month)[1])


def _parse_dateish(value) -> date | None:
    if not value:
        return None
    text = str(value).strip()
    try:
        if len(text) == 7:
            text += "-01"
        return date.fromisoformat(text[:10])
    except ValueError:
        return None


def _numeric(value) -> float | None:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None


def _costs() -> dict[str, object]:
    path = Path(os.getenv("PRODUCT_COSTS_PATH", "/config/product_costs.json"))
    try:
        raw = json.loads(path.read_text())
    except Exception:
        return {}
    raw = raw.get("costs", raw) if isinstance(raw, dict) else {}
    return {
        str(sku): value
        for sku, value in raw.items()
        if isinstance(sku, str) and not sku.startswith("_")
    }


def _unit_cost(costs: dict[str, object], sku: str, when: date) -> float | None:
    value = costs.get(sku)
    direct = _numeric(value)
    if direct is not None:
        return direct
    if not isinstance(value, dict):
        return None

    matches: list[tuple[date, float]] = []
    history = value.get("history")
    if isinstance(history, list):
        for entry in history:
            if not isinstance(entry, dict):
                continue
            amount = _numeric(entry.get("unit_cogs"))
            if amount is None:
                continue
            start = _parse_dateish(entry.get("effective_from") or entry.get("from")) or date.min
            end = _parse_dateish(entry.get("effective_to") or entry.get("to"))
            if start <= when and (end is None or when <= end):
                matches.append((start, amount))
    if matches:
        return max(matches, key=lambda x: x[0])[1]

    amount = _numeric(value.get("unit_cogs"))
    if amount is None:
        amount = _numeric(value.get("current"))
    if amount is None:
        return None
    effective_from = _parse_dateish(value.get("effective_from"))
    if effective_from and when < effective_from:
        return None
    return amount


def _cogs_for_month(cur, marketplace: str, month: date, costs: dict[str, object]) -> dict:
    nxt = _next_month(month)
    rows = _all(cur, f"""
        SELECT i.seller_sku AS sku, COALESCE(sum(i.quantity_ordered),0)::bigint AS units
        FROM core.amazon_order o
        JOIN core.amazon_order_item i USING (amazon_order_id)
        WHERE o.marketplace_id=%s
          AND (o.created_time AT TIME ZONE '{TZ}')::date >= %s::date
          AND (o.created_time AT TIME ZONE '{TZ}')::date < %s::date
          AND o.fulfillment_status IS DISTINCT FROM 'CANCELLED'
          AND i.seller_sku IS NOT NULL
        GROUP BY i.seller_sku ORDER BY units DESC, i.seller_sku
    """, (marketplace, month, nxt))
    out = []
    total = covered = 0
    known = 0.0
    for row in rows:
        sku = row.get("sku")
        units = int(row.get("units") or 0)
        total += units
        unit = _unit_cost(costs, sku, month)
        configured = unit is not None
        extended = round(units * unit, 2) if configured else None
        if configured:
            covered += units
            known += extended or 0
        out.append({"sku": sku, "units": units, "unit_cogs": unit, "extended_cogs": extended, "configured": configured})
    missing = [{"sku": r["sku"], "units": r["units"]} for r in out if not r["configured"]]
    return {
        "rows": out,
        "missing_skus": missing,
        "product_cogs": round(known, 2),
        "complete": total == covered,
        "coverage_pct": round(100.0 * covered / total, 1) if total else 100.0,
        "total_units": total,
        "covered_units": covered,
    }


def _sales_month(cur, marketplace: str, month: date) -> dict:
    return _one(cur, """
        SELECT COALESCE(sum(sales),0)::numeric(16,2) AS net_sales,
               COALESCE(sum(orders),0)::bigint AS orders,
               COALESCE(sum(units),0)::bigint AS units,
               max(business_date) AS through_date
        FROM mart.business_daily
        WHERE marketplace_id=%s AND reconciled_daily_report
          AND business_date >= %s::date AND business_date < %s::date
    """, (marketplace, month, _next_month(month)))


def _order_finance_month(cur, marketplace: str, month: date) -> dict:
    return _one(cur, f"""
        WITH om AS (
          SELECT amazon_order_id
          FROM core.amazon_order
          WHERE marketplace_id=%s
            AND (created_time AT TIME ZONE '{TZ}')::date >= %s::date
            AND (created_time AT TIME ZONE '{TZ}')::date < %s::date
            AND fulfillment_status IS DISTINCT FROM 'CANCELLED'
        )
        SELECT count(DISTINCT om.amazon_order_id)::int AS core_orders,
               count(DISTINCT ft.amazon_order_id) FILTER (WHERE ft.transaction_status='RELEASED' AND ft.transaction_type='Shipment')::int AS released_orders,
               count(*) FILTER (WHERE ft.transaction_status='DEFERRED')::int AS deferred_events,
               COALESCE(sum(ft.total_amount) FILTER (WHERE ft.transaction_status='RELEASED' AND ft.transaction_type='Shipment'),0)::numeric(16,2) AS shipment_net,
               COALESCE(sum(ft.total_amount) FILTER (WHERE ft.transaction_status='RELEASED' AND ft.transaction_type='Refund'),0)::numeric(16,2) AS refunds,
               COALESCE(sum(ft.total_amount) FILTER (WHERE ft.transaction_status='RELEASED' AND ft.transaction_type IN ('Shipment','Refund')),0)::numeric(16,2) AS order_net
        FROM om
        LEFT JOIN core.financial_transaction ft
          ON ft.marketplace_id=%s AND ft.amazon_order_id=om.amazon_order_id
    """, (marketplace, month, _next_month(month), marketplace))


def _posting_month(cur, marketplace: str, month: date) -> dict:
    return _one(cur, f"""
        SELECT COALESCE(sum(total_amount) FILTER (WHERE transaction_type='Transfer'),0)::numeric(16,2) AS cash,
               COALESCE(sum(total_amount) FILTER (WHERE transaction_type='ProductAdsPayment'),0)::numeric(16,2) AS ads_posted,
               COALESCE(sum(total_amount) FILTER (WHERE transaction_type IN ('ServiceFee','Adjustment','MiscellaneousLedgerAdjustment','FBAInventoryReimbursement')),0)::numeric(16,2) AS other_postings
        FROM core.financial_transaction
        WHERE marketplace_id=%s AND transaction_status='RELEASED'
          AND (posted_date AT TIME ZONE 'America/Mexico_City')::date >= %s::date
          AND (posted_date AT TIME ZONE 'America/Mexico_City')::date < %s::date
    """, (marketplace, month, _next_month(month)))


def _ads_close_for_month(cur, marketplace: str, month: date) -> dict:
    nxt = _next_month(month)
    return _one(cur, f"""
        SELECT COALESCE(sum(total_amount),0)::numeric(16,2) AS advertising,
               count(*)::int AS events
        FROM core.financial_transaction
        WHERE marketplace_id=%s AND transaction_status='RELEASED'
          AND transaction_type='ProductAdsPayment'
          AND (posted_date AT TIME ZONE '{TZ}')::date >= %s::date
          AND (posted_date AT TIME ZONE '{TZ}')::date < %s::date
    """, (marketplace, nxt, _next_month(nxt)))


def _probe_historical_month(cur, marketplace: str, month: date, costs: dict[str, object], now_local: date) -> dict:
    sales = _sales_month(cur, marketplace, month)
    fin = _order_finance_month(cur, marketplace, month)
    ads = _ads_close_for_month(cur, marketplace, month)
    cogs = _cogs_for_month(cur, marketplace, month, costs)
    net_sales = float(sales.get("net_sales") or 0)
    order_net = float(fin.get("order_net") or 0)
    deferred = int(fin.get("deferred_events") or 0)
    released_orders = int(fin.get("released_orders") or 0)
    core_orders = int(fin.get("core_orders") or 0)
    finance_released = deferred == 0 and (released_orders > 0 or net_sales == 0)
    old_enough = now_local >= _month_end(month) + timedelta(days=CLOSE_GRACE_DAYS)
    ads_final = int(ads.get("events") or 0) > 0
    amazon_closed = finance_released and old_enough and ads_final
    state = "AMAZON_CLOSED" if amazon_closed else "FINALIZING"
    waits = []
    if not finance_released:
        waits.append("Amazon order releases")
    if not ads_final:
        waits.append("monthly advertising close")
    if not old_enough:
        waits.append("close grace period")
    if amazon_closed and not cogs["complete"]:
        waits.append("seller product cost")
    if amazon_closed and cogs["complete"]:
        state = "READY_TO_CLOSE"
    return {
        "month": str(month),
        "state": state,
        "amazon_state": "CLOSED" if amazon_closed else "FINALIZING",
        "net_sales_ex_vat": round(net_sales, 2),
        "iva_on_sales": round(net_sales * VAT_RATE, 2),
        "shopper_product_spend": round(net_sales * (1 + VAT_RATE), 2),
        "orders": int(sales.get("orders") or 0),
        "units": int(sales.get("units") or 0),
        "amazon_order_net": round(order_net, 2),
        "amazon_order_effect": round(order_net - net_sales, 2),
        "advertising": float(ads.get("advertising") or 0) if ads_final else None,
        "advertising_final": ads_final,
        "product_cogs": cogs["product_cogs"],
        "cogs_complete": cogs["complete"],
        "cogs_coverage_pct": cogs["coverage_pct"],
        "missing_skus": cogs["missing_skus"],
        "release_coverage_pct": round(100.0 * released_orders / core_orders, 1) if core_orders else 100.0,
        "deferred_events": deferred,
        "close_waits_for": waits,
    }


def finance_payload(connect, marketplace: str) -> dict:
    errors: list[str] = []
    local_time = None
    try:
        with connect() as conn, conn.cursor() as cur:
            local_time = _one(cur, f"SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE '{TZ}','HH24:MI') AS local_time").get("local_time")
            cutoff = _one(cur, "SELECT max(posted_date) AS posted_at FROM core.financial_transaction WHERE marketplace_id=%s", (marketplace,)).get("posted_at")
            last_sales_date = _one(cur, "SELECT max(business_date) AS d FROM mart.business_daily WHERE marketplace_id=%s AND reconciled_daily_report", (marketplace,)).get("d")
            first_sales_date = _one(cur, "SELECT min(business_date) AS d FROM mart.business_daily WHERE marketplace_id=%s AND reconciled_daily_report", (marketplace,)).get("d")
            if cutoff is None or last_sales_date is None:
                return {"summary": {}, "current_month": {}, "closed_months": [], "finalizing_months": [], "closed_aggregate": {}, "types": [], "recent": [], "cogs": [], "local_time": local_time, "diagnostic": errors}

            current_month = last_sales_date.replace(day=1)
            costs = _costs()
            sales = _sales_month(cur, marketplace, current_month)
            fin = _order_finance_month(cur, marketplace, current_month)
            postings = _posting_month(cur, marketplace, current_month)
            cogs = _cogs_for_month(cur, marketplace, current_month, costs)
            net_sales = float(sales.get("net_sales") or 0)
            order_net = float(fin.get("order_net") or 0)
            other_postings = float(postings.get("other_postings") or 0)
            current_estimate = round(order_net + other_postings - cogs["product_cogs"], 2) if cogs["complete"] else None
            current = {
                "month": str(current_month), "state": "OPEN", "partial": True,
                "through_date": sales.get("through_date") or last_sales_date,
                "net_sales_ex_vat": round(net_sales, 2),
                "iva_on_sales": round(net_sales * VAT_RATE, 2),
                "shopper_product_spend": round(net_sales * (1 + VAT_RATE), 2),
                "vat_rate": VAT_RATE,
                "orders": int(sales.get("orders") or 0), "units": int(sales.get("units") or 0),
                "amazon_order_net": round(order_net, 2),
                "amazon_order_effect": round(order_net - net_sales, 2),
                "refunds": float(fin.get("refunds") or 0),
                "deferred_events": int(fin.get("deferred_events") or 0),
                "released_orders": int(fin.get("released_orders") or 0),
                "core_orders": int(fin.get("core_orders") or 0),
                "product_cogs": cogs["product_cogs"], "cogs_complete": cogs["complete"],
                "cogs_coverage_pct": cogs["coverage_pct"],
                "missing_skus": cogs["missing_skus"],
                "current_month_advertising": None,
                "current_month_advertising_status": "Pending Ads API / month close",
                "estimated_contribution_before_current_ads": current_estimate,
                "cash_transferred": float(postings.get("cash") or 0),
                "ads_posted_this_calendar_month": float(postings.get("ads_posted") or 0),
                "standard_costs_are_provisional": True,
            }

            # Historical management truth comes from immutable snapshots only.
            closed = []
            closed_month_keys: set[str] = set()
            try:
                closed = _all(cur, """
                    SELECT marketplace_id,month,version,state,supersedes_version,restatement_reason,
                           net_sales_ex_vat,iva_on_sales,shopper_product_spend,
                           amazon_order_net,amazon_order_effect,advertising,other_amazon_postings,
                           product_cogs,contribution_after_product_cogs,contribution_margin_pct,
                           cash_transferred,closed_at,close_basis
                    FROM mart.finance_month_close_latest
                    WHERE marketplace_id=%s
                    ORDER BY month DESC
                """, (marketplace,))
                closed_month_keys = {str(r.get("month")) for r in closed}
                for row in closed:
                    row["month"] = str(row.get("month"))
                    row["state"] = row.get("state") or "CLOSED"
                    row["cogs_source"] = "frozen_close_snapshot"
                    basis = row.get("close_basis") if isinstance(row.get("close_basis"), dict) else {}
                    row["cogs_coverage_pct"] = float(basis.get("cogs_coverage_pct") or 100.0)
            except Exception as exc:
                conn.rollback()
                errors.append(f"close_ledger:{type(exc).__name__}:{exc}")
                closed = []

            now_local = datetime.now(ZoneInfo(TZ)).date()
            finalizing = []
            cursor = (first_sales_date or current_month).replace(day=1)
            while cursor < current_month:
                if str(cursor) not in closed_month_keys:
                    try:
                        finalizing.append(_probe_historical_month(cur, marketplace, cursor, costs, now_local))
                    except Exception as exc:
                        conn.rollback()
                        errors.append(f"probe_{cursor}:{type(exc).__name__}:{exc}")
                cursor = _next_month(cursor)

            agg_sales = round(sum(float(m.get("net_sales_ex_vat") or 0) for m in closed), 2)
            agg_contribution = round(sum(float(m.get("contribution_after_product_cogs") or 0) for m in closed), 2)
            aggregate = {
                "months": len(closed),
                "net_sales_ex_vat": agg_sales,
                "shopper_product_spend": round(sum(float(m.get("shopper_product_spend") or 0) for m in closed), 2),
                "amazon_order_effect": round(sum(float(m.get("amazon_order_effect") or 0) for m in closed), 2),
                "advertising": round(sum(float(m.get("advertising") or 0) for m in closed), 2),
                "product_cogs": round(sum(float(m.get("product_cogs") or 0) for m in closed), 2),
                "contribution_after_product_cogs": agg_contribution,
                "contribution_margin_pct": round(100.0 * agg_contribution / agg_sales, 1) if agg_sales else None,
                "cash_transferred": round(sum(float(m.get("cash_transferred") or 0) for m in closed), 2),
            }

            types = _all(cur, """
                SELECT transaction_type,count(*)::int AS transactions,
                       COALESCE(sum(total_amount),0)::numeric(16,2) AS amount
                FROM core.financial_transaction
                WHERE marketplace_id=%s AND transaction_status='RELEASED'
                  AND posted_date>%s::timestamptz-interval '90 days'
                GROUP BY transaction_type ORDER BY abs(sum(total_amount)) DESC
            """, (marketplace, cutoff))
            recent = _all(cur, f"""
                SELECT transaction_type,transaction_status,description,total_amount AS amount,
                       to_char(posted_date AT TIME ZONE '{TZ}','MM-DD HH24:MI') AS local_time
                FROM core.financial_transaction
                WHERE marketplace_id=%s ORDER BY posted_date DESC LIMIT 40
            """, (marketplace,))
            summary = {
                "latest_posted": cutoff,
                "closed_months": len(closed),
                "historical_months_pending": len(finalizing),
                "cogs_policy": "OPEN months use editable standard/effective-dated costs; CLOSED months use immutable snapshots; restatement is explicit only.",
            }
            return {
                "summary": summary,
                "current_month": current,
                "closed_months": closed,
                "finalizing_months": finalizing,
                "closed_aggregate": aggregate,
                "types": types,
                "recent": recent,
                "cogs": cogs["rows"],
                "local_time": local_time,
                "diagnostic": errors,
            }
    except Exception as exc:
        errors.append(f"fatal:{type(exc).__name__}:{exc}")
        return {"summary": {}, "current_month": {}, "closed_months": [], "finalizing_months": [], "closed_aggregate": {}, "types": [], "recent": [], "cogs": [], "local_time": local_time, "diagnostic": errors}
