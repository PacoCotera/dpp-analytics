from __future__ import annotations

"""Finance-manager payload built around accounting-period states.

The product has two deliberately different views:
- current_month: an OPEN operational estimate. Sales and COGS are current, but
  Amazon fees / refunds can still release later and the month's advertising is
  not considered final until its monthly Amazon charge is observed.
- closed_months: historical calendar months only after no DEFERRED order finance
  remains, seller COGS is complete, the following monthly advertising charge has
  posted, and the close grace period has elapsed.

Business sales are ex Mexico IVA. IVA is shown separately at the configured
rate. Finances v2024 totals use RELEASED transactions only so DEFERRED and
RELEASED representations are never added together.
"""

import calendar
import json
import os
from datetime import date, timedelta
from pathlib import Path

VAT_RATE = float(os.getenv("MX_VAT_RATE", "0.16"))
TZ = "America/Mexico_City"
ADS_CLOSE_GRACE_DAYS = int(os.getenv("FINANCE_ADS_CLOSE_GRACE_DAYS", "10"))


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


def _previous_month(d: date) -> date:
    return date(d.year - (1 if d.month == 1 else 0), 12 if d.month == 1 else d.month - 1, 1)


def _costs() -> dict[str, float]:
    path = Path(os.getenv("PRODUCT_COSTS_PATH", "/app/product_costs.json"))
    try:
        raw = json.loads(path.read_text())
    except Exception:
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


def _month_cogs(cur, marketplace: str, first_month: date, through_date: date, costs: dict[str, float]):
    rows = _all(cur, f"""
        SELECT date_trunc('month',o.created_time AT TIME ZONE '{TZ}')::date AS month,
               i.seller_sku AS sku,
               COALESCE(sum(i.quantity_ordered),0)::bigint AS units
        FROM core.amazon_order o
        JOIN core.amazon_order_item i USING (amazon_order_id)
        WHERE o.marketplace_id=%s
          AND (o.created_time AT TIME ZONE '{TZ}')::date BETWEEN %s::date AND %s::date
          AND o.fulfillment_status IS DISTINCT FROM 'CANCELLED'
          AND i.seller_sku IS NOT NULL
        GROUP BY 1,2 ORDER BY 1,2
    """, (marketplace, first_month, through_date))
    by_month: dict[str, dict] = {}
    sku_rows = []
    for row in rows:
        month = str(row["month"])
        sku = row.get("sku")
        units = int(row.get("units") or 0)
        unit = costs.get(sku)
        slot = by_month.setdefault(month, {"total_units": 0, "covered_units": 0, "cogs": 0.0})
        slot["total_units"] += units
        configured = unit is not None
        extended = round(units * unit, 2) if configured else None
        if configured:
            slot["covered_units"] += units
            slot["cogs"] += extended or 0.0
        sku_rows.append({"month": month, "sku": sku, "units": units, "unit_cogs": unit, "extended_cogs": extended, "configured": configured})
    for slot in by_month.values():
        slot["cogs"] = round(slot["cogs"], 2)
        slot["complete"] = slot["total_units"] == slot["covered_units"]
        slot["coverage_pct"] = round(100.0 * slot["covered_units"] / slot["total_units"], 1) if slot["total_units"] else 100.0
    return by_month, sku_rows


def finance_payload(connect, marketplace: str) -> dict:
    errors: list[str] = []
    local_time = None
    try:
        with connect() as conn, conn.cursor() as cur:
            try:
                local_time = _one(cur, f"SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE '{TZ}','HH24:MI') AS local_time").get("local_time")
                cutoff = _one(cur, "SELECT max(posted_date) AS posted_at FROM core.financial_transaction WHERE marketplace_id=%s", (marketplace,)).get("posted_at")
                last_sales_date = _one(cur, "SELECT max(business_date) AS d FROM mart.business_daily WHERE marketplace_id=%s AND reconciled_daily_report", (marketplace,)).get("d")
                first_sales_date = _one(cur, "SELECT min(business_date) AS d FROM mart.business_daily WHERE marketplace_id=%s AND reconciled_daily_report", (marketplace,)).get("d")
            except Exception as exc:
                conn.rollback()
                errors.append(f"clock:{type(exc).__name__}:{exc}")
                cutoff = last_sales_date = first_sales_date = None

            if cutoff is None or last_sales_date is None:
                return {"summary": {}, "current_month": {}, "closed_months": [], "finalizing_months": [], "closed_aggregate": {}, "types": [], "recent": [], "cogs": [], "local_time": local_time, "diagnostic": errors}

            current_month_start = last_sales_date.replace(day=1)
            first_month = (first_sales_date or current_month_start).replace(day=1)
            finance_cutoff_date = cutoff.date()

            sales_rows = _all(cur, """
                SELECT date_trunc('month',business_date)::date AS month,
                       COALESCE(sum(sales),0)::numeric(16,2) AS net_sales,
                       COALESCE(sum(orders),0)::bigint AS orders,
                       COALESCE(sum(units),0)::bigint AS units
                FROM mart.business_daily
                WHERE marketplace_id=%s AND reconciled_daily_report
                  AND business_date BETWEEN %s::date AND %s::date
                GROUP BY 1 ORDER BY 1
            """, (marketplace, first_month, last_sales_date))

            order_finance_rows = _all(cur, f"""
                WITH om AS (
                  SELECT amazon_order_id,
                         date_trunc('month',created_time AT TIME ZONE '{TZ}')::date AS month
                  FROM core.amazon_order
                  WHERE marketplace_id=%s
                    AND (created_time AT TIME ZONE '{TZ}')::date BETWEEN %s::date AND %s::date
                    AND fulfillment_status IS DISTINCT FROM 'CANCELLED'
                )
                SELECT om.month,
                       count(DISTINCT om.amazon_order_id)::int AS core_orders,
                       count(DISTINCT ft.amazon_order_id) FILTER (WHERE ft.transaction_status='RELEASED' AND ft.transaction_type='Shipment')::int AS released_orders,
                       count(*) FILTER (WHERE ft.transaction_status='DEFERRED')::int AS deferred_events,
                       COALESCE(sum(ft.total_amount) FILTER (WHERE ft.transaction_status='RELEASED' AND ft.transaction_type='Shipment'),0)::numeric(16,2) AS shipment_net,
                       COALESCE(sum(ft.total_amount) FILTER (WHERE ft.transaction_status='RELEASED' AND ft.transaction_type='Refund'),0)::numeric(16,2) AS refunds,
                       COALESCE(sum(ft.total_amount) FILTER (WHERE ft.transaction_status='RELEASED' AND ft.transaction_type IN ('Shipment','Refund')),0)::numeric(16,2) AS order_finance_net
                FROM om
                LEFT JOIN core.financial_transaction ft
                  ON ft.marketplace_id=%s AND ft.amazon_order_id=om.amazon_order_id
                GROUP BY om.month ORDER BY om.month
            """, (marketplace, first_month, last_sales_date, marketplace))
            order_finance = {str(r["month"]): r for r in order_finance_rows}

            posting_rows = _all(cur, f"""
                SELECT posted_date AT TIME ZONE '{TZ}' AS local_posted, transaction_type,total_amount
                FROM core.financial_transaction
                WHERE marketplace_id=%s AND transaction_status='RELEASED'
                  AND posted_date >= %s::date
                  AND posted_date < (%s::date + interval '45 days')
                  AND transaction_type IN ('ProductAdsPayment','Transfer','ServiceFee','Adjustment','MiscellaneousLedgerAdjustment','FBAInventoryReimbursement')
                ORDER BY posted_date
            """, (marketplace, first_month, last_sales_date))
            posted: dict[str, dict] = {}
            ads_for_month: dict[str, float] = {}
            for row in posting_rows:
                dt = row.get("local_posted")
                if dt is None:
                    continue
                posting_month = date(dt.year, dt.month, 1)
                key = str(posting_month)
                slot = posted.setdefault(key, {"cash": 0.0, "service": 0.0, "adjustments": 0.0, "ads_posted": 0.0})
                amount = float(row.get("total_amount") or 0)
                typ = row.get("transaction_type")
                if typ == "Transfer":
                    slot["cash"] += amount
                elif typ == "ProductAdsPayment":
                    slot["ads_posted"] += amount
                    target = _previous_month(posting_month) if dt.day <= ADS_CLOSE_GRACE_DAYS else posting_month
                    ads_for_month[str(target)] = round(ads_for_month.get(str(target), 0.0) + amount, 2)
                elif typ == "ServiceFee":
                    slot["service"] += amount
                else:
                    slot["adjustments"] += amount

            costs = _costs()
            cogs_by_month, cogs_rows = _month_cogs(cur, marketplace, first_month, last_sales_date, costs)
            sales_by_month = {str(r["month"]): r for r in sales_rows}
            months = []
            cursor = first_month
            while cursor <= current_month_start:
                key = str(cursor)
                s = sales_by_month.get(key, {})
                net_sales = float(s.get("net_sales") or 0)
                iva = round(net_sales * VAT_RATE, 2)
                of = order_finance.get(key, {})
                core_orders = int(of.get("core_orders") or 0)
                released_orders = int(of.get("released_orders") or 0)
                deferred_events = int(of.get("deferred_events") or 0)
                release_coverage = (released_orders / core_orders) if core_orders else 1.0
                order_net = float(of.get("order_finance_net") or 0)
                order_effect = round(order_net - net_sales, 2)
                ads = ads_for_month.get(key)
                p = posted.get(key, {})
                other_postings = round(float(p.get("service") or 0) + float(p.get("adjustments") or 0), 2)
                c = cogs_by_month.get(key, {"cogs": 0.0, "complete": True, "coverage_pct": 100.0})
                cogs = float(c.get("cogs") or 0)
                cogs_complete = bool(c.get("complete"))
                month_end = _month_end(cursor)
                historical = cursor < current_month_start
                old_enough = finance_cutoff_date >= month_end + timedelta(days=ADS_CLOSE_GRACE_DAYS)
                ads_final = ads is not None
                finance_released = deferred_events == 0 and (released_orders > 0 or net_sales == 0)
                if not historical:
                    state = "OPEN"
                elif old_enough and ads_final and finance_released and cogs_complete:
                    state = "CLOSED"
                else:
                    state = "FINALIZING"

                contribution = margin = None
                if state == "CLOSED":
                    contribution = round(order_net + float(ads or 0) + other_postings - cogs, 2)
                    margin = round(100.0 * contribution / net_sales, 1) if net_sales else None

                months.append({
                    "month": key, "state": state, "partial": state == "OPEN",
                    "net_sales_ex_vat": net_sales, "iva_on_sales": iva,
                    "shopper_product_spend": round(net_sales + iva, 2), "vat_rate": VAT_RATE,
                    "orders": int(s.get("orders") or 0), "units": int(s.get("units") or 0),
                    "amazon_order_net": round(order_net, 2), "amazon_order_effect": order_effect,
                    "refunds": float(of.get("refunds") or 0),
                    "advertising": ads, "advertising_final": ads_final,
                    "ads_posted_this_calendar_month": round(float(p.get("ads_posted") or 0), 2),
                    "other_amazon_postings": other_postings,
                    "product_cogs": round(cogs, 2), "cogs_complete": cogs_complete,
                    "cogs_coverage_pct": float(c.get("coverage_pct") or 0),
                    "release_coverage_pct": round(100.0 * release_coverage, 1),
                    "released_orders": released_orders, "core_orders": core_orders,
                    "deferred_events": deferred_events,
                    "contribution_after_product_cogs": contribution,
                    "contribution_margin_pct": margin,
                    "cash_transferred": round(float(p.get("cash") or 0), 2),
                    "close_waits_for": [name for name, ready in (
                        ("Amazon order releases", finance_released),
                        ("monthly advertising charge", ads_final),
                        ("product COGS", cogs_complete),
                        ("close grace period", old_enough),
                    ) if historical and not ready],
                })
                cursor = _next_month(cursor)

            current = months[-1] if months else {}
            closed = [m for m in months if m["state"] == "CLOSED"]
            finalizing = [m for m in months if m["state"] == "FINALIZING"]
            agg_sales = round(sum(m["net_sales_ex_vat"] for m in closed), 2)
            agg_contribution = round(sum(float(m["contribution_after_product_cogs"] or 0) for m in closed), 2)
            aggregate = {
                "months": len(closed), "net_sales_ex_vat": agg_sales,
                "shopper_product_spend": round(sum(m["shopper_product_spend"] for m in closed), 2),
                "amazon_order_effect": round(sum(m["amazon_order_effect"] for m in closed), 2),
                "advertising": round(sum(float(m["advertising"] or 0) for m in closed), 2),
                "other_amazon_postings": round(sum(m["other_amazon_postings"] for m in closed), 2),
                "product_cogs": round(sum(m["product_cogs"] for m in closed), 2),
                "contribution_after_product_cogs": agg_contribution,
                "contribution_margin_pct": round(100.0 * agg_contribution / agg_sales, 1) if agg_sales else None,
                "cash_transferred": round(sum(m["cash_transferred"] for m in closed), 2),
            }

            current_estimate = dict(current)
            if current:
                current_estimate["estimated_contribution_before_current_ads"] = round(float(current.get("amazon_order_net") or 0) + float(current.get("other_amazon_postings") or 0) - float(current.get("product_cogs") or 0), 2) if current.get("cogs_complete") else None
                current_estimate["current_month_advertising"] = None
                current_estimate["current_month_advertising_status"] = "Pending Ads API / month close"

            summary = _one(cur, """
                SELECT max(posted_date) AS latest_posted,
                       COALESCE(sum(total_amount) FILTER (WHERE transaction_status='RELEASED' AND transaction_type='ProductAdsPayment' AND posted_date>max_posted-interval '28 days'),0)::numeric(16,2) AS ads_amount_28
                FROM (SELECT f.*, max(posted_date) OVER () AS max_posted FROM core.financial_transaction f WHERE marketplace_id=%s) x
            """, (marketplace,))
            types = _all(cur, """
                SELECT transaction_type,count(*)::int AS transactions,COALESCE(sum(total_amount),0)::numeric(16,2) AS amount
                FROM core.financial_transaction
                WHERE marketplace_id=%s AND transaction_status='RELEASED' AND posted_date>%s::timestamptz-interval '90 days'
                GROUP BY transaction_type ORDER BY abs(sum(total_amount)) DESC
            """, (marketplace, cutoff))
            recent = _all(cur, f"""
                SELECT transaction_type,transaction_status,description,total_amount AS amount,
                       to_char(posted_date AT TIME ZONE '{TZ}','MM-DD HH24:MI') AS local_time
                FROM core.financial_transaction WHERE marketplace_id=%s ORDER BY posted_date DESC LIMIT 50
            """, (marketplace,))

            return {
                "summary": summary, "current_month": current_estimate,
                "closed_months": closed, "finalizing_months": finalizing,
                "closed_aggregate": aggregate, "monthly": months, "statement": current_estimate,
                "types": types, "daily": [], "breakdowns": [], "recent": recent, "cogs": cogs_rows,
                "local_time": local_time, "finance_cutoff": cutoff, "sales_through": last_sales_date,
                "close_policy": {
                    "ads_charge_grace_days": ADS_CLOSE_GRACE_DAYS,
                    "definition": "Closed only after no deferred order-finance events remain, seller COGS is complete, the following monthly Amazon advertising charge is observed, and the grace period has passed."
                },
                "diagnostic": errors,
            }
    except Exception as exc:
        errors.append(f"fatal:{type(exc).__name__}:{exc}")
        return {"summary": {}, "current_month": {}, "closed_months": [], "finalizing_months": [], "closed_aggregate": {}, "types": [], "recent": [], "cogs": [], "local_time": local_time, "diagnostic": errors}
