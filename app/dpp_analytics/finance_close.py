from __future__ import annotations

"""Freeze seller-owned COGS and management economics when a month closes.

Standard costs are editable inputs for OPEN months. Once a historical month has
finished Amazon release/advertising close and all SKU costs are known, this job
writes an immutable close version plus SKU-level COGS snapshot. Later edits to
product_costs.json do not rewrite history. A historical correction requires an
explicit RESTATED version.

The cost config is backward compatible:
- "SKU": 50 applies to all periods.
- "SKU": {"unit_cogs": 50} also applies to all periods.
- effective-dated history can be supplied when costs changed over time:
  "SKU": {
    "unit_cogs": 55,
    "effective_from": "2026-08-01",
    "history": [
      {"effective_from": "2025-11-01", "effective_to": "2026-07-31", "unit_cogs": 50}
    ]
  }
The resolver uses the cost applicable to the business month being closed.
"""

import argparse
import calendar
import json
import os
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from . import db
from .settings import settings

TZ = "America/Mexico_City"
VAT_RATE = float(os.getenv("MX_VAT_RATE", "0.16"))
CLOSE_GRACE_DAYS = int(os.getenv("FINANCE_ADS_CLOSE_GRACE_DAYS", "10"))
COSTS_PATH = Path(os.getenv("PRODUCT_COSTS_PATH", "/config/product_costs.json"))


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
        amount = float(value)
    except (TypeError, ValueError):
        return None
    return amount if amount >= 0 else None


def _load_costs() -> dict[str, object]:
    try:
        raw = json.loads(COSTS_PATH.read_text())
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

    # Explicit dated history wins whenever a matching period exists.
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

    # Current/standard value can optionally have its own effective-from date.
    amount = _numeric(value.get("unit_cogs"))
    if amount is None:
        amount = _numeric(value.get("current"))
    if amount is None:
        return None
    effective_from = _parse_dateish(value.get("effective_from"))
    if effective_from and when < effective_from:
        return None
    return amount


def _month_snapshot(cur, marketplace: str, month: date, costs: dict[str, object]) -> dict:
    nxt = _next_month(month)
    after = _next_month(nxt)

    cur.execute(
        """
        SELECT COALESCE(sum(sales),0)::numeric(16,2) AS sales,
               COALESCE(sum(orders),0)::bigint AS orders,
               COALESCE(sum(units),0)::bigint AS units
        FROM mart.business_daily
        WHERE marketplace_id=%s AND reconciled_daily_report
          AND business_date >= %s::date AND business_date < %s::date
        """,
        (marketplace, month, nxt),
    )
    sales = cur.fetchone() or {}
    net_sales = float(sales.get("sales") or 0)

    cur.execute(
        f"""
        WITH om AS (
          SELECT amazon_order_id
          FROM core.amazon_order
          WHERE marketplace_id=%s
            AND (created_time AT TIME ZONE '{TZ}')::date >= %s::date
            AND (created_time AT TIME ZONE '{TZ}')::date < %s::date
            AND fulfillment_status IS DISTINCT FROM 'CANCELLED'
        )
        SELECT count(DISTINCT om.amazon_order_id)::int AS core_orders,
               count(DISTINCT ft.amazon_order_id) FILTER (
                 WHERE ft.transaction_status='RELEASED' AND ft.transaction_type='Shipment'
               )::int AS released_orders,
               count(*) FILTER (WHERE ft.transaction_status='DEFERRED')::int AS deferred_events,
               COALESCE(sum(ft.total_amount) FILTER (
                 WHERE ft.transaction_status='RELEASED' AND ft.transaction_type IN ('Shipment','Refund')
               ),0)::numeric(16,2) AS order_net
        FROM om
        LEFT JOIN core.financial_transaction ft
          ON ft.marketplace_id=%s AND ft.amazon_order_id=om.amazon_order_id
        """,
        (marketplace, month, nxt, marketplace),
    )
    fin = cur.fetchone() or {}
    core_orders = int(fin.get("core_orders") or 0)
    released_orders = int(fin.get("released_orders") or 0)
    deferred_events = int(fin.get("deferred_events") or 0)
    order_net = float(fin.get("order_net") or 0)

    # Temporary bridge until Ads API reporting is authorized: the Amazon ad
    # charge posted in the following calendar month closes the prior ad month.
    cur.execute(
        f"""
        SELECT COALESCE(sum(total_amount),0)::numeric(16,2) AS amount,
               count(*)::int AS events
        FROM core.financial_transaction
        WHERE marketplace_id=%s AND transaction_status='RELEASED'
          AND transaction_type='ProductAdsPayment'
          AND (posted_date AT TIME ZONE '{TZ}')::date >= %s::date
          AND (posted_date AT TIME ZONE '{TZ}')::date < %s::date
        """,
        (marketplace, nxt, after),
    )
    ads_row = cur.fetchone() or {}
    ads_events = int(ads_row.get("events") or 0)
    advertising = float(ads_row.get("amount") or 0)

    cur.execute(
        f"""
        SELECT COALESCE(sum(total_amount),0)::numeric(16,2) AS amount
        FROM core.financial_transaction
        WHERE marketplace_id=%s AND transaction_status='RELEASED'
          AND transaction_type IN ('ServiceFee','Adjustment','MiscellaneousLedgerAdjustment','FBAInventoryReimbursement')
          AND (posted_date AT TIME ZONE '{TZ}')::date >= %s::date
          AND (posted_date AT TIME ZONE '{TZ}')::date < %s::date
        """,
        (marketplace, month, nxt),
    )
    other_postings = float((cur.fetchone() or {}).get("amount") or 0)

    cur.execute(
        f"""
        SELECT COALESCE(sum(total_amount),0)::numeric(16,2) AS amount
        FROM core.financial_transaction
        WHERE marketplace_id=%s AND transaction_status='RELEASED'
          AND transaction_type='Transfer'
          AND (posted_date AT TIME ZONE '{TZ}')::date >= %s::date
          AND (posted_date AT TIME ZONE '{TZ}')::date < %s::date
        """,
        (marketplace, month, nxt),
    )
    cash = float((cur.fetchone() or {}).get("amount") or 0)

    cur.execute(
        f"""
        SELECT i.seller_sku AS sku, COALESCE(sum(i.quantity_ordered),0)::bigint AS units
        FROM core.amazon_order o
        JOIN core.amazon_order_item i USING (amazon_order_id)
        WHERE o.marketplace_id=%s
          AND (o.created_time AT TIME ZONE '{TZ}')::date >= %s::date
          AND (o.created_time AT TIME ZONE '{TZ}')::date < %s::date
          AND o.fulfillment_status IS DISTINCT FROM 'CANCELLED'
          AND i.seller_sku IS NOT NULL
        GROUP BY i.seller_sku ORDER BY i.seller_sku
        """,
        (marketplace, month, nxt),
    )
    sku_rows = []
    total_units = covered_units = 0
    product_cogs = 0.0
    for row in cur.fetchall():
        sku = row.get("sku")
        units = int(row.get("units") or 0)
        total_units += units
        unit_cogs = _unit_cost(costs, sku, month)
        configured = unit_cogs is not None
        extended = round(units * unit_cogs, 2) if configured else None
        if configured:
            covered_units += units
            product_cogs += extended or 0.0
        sku_rows.append({
            "sku": sku,
            "units": units,
            "unit_cogs": unit_cogs,
            "extended_cogs": extended,
            "configured": configured,
        })

    cogs_complete = total_units == covered_units
    missing_skus = [
        {"sku": r["sku"], "units": r["units"]}
        for r in sku_rows if not r["configured"]
    ]
    finance_released = deferred_events == 0 and (released_orders > 0 or net_sales == 0)
    now_local = datetime.now(ZoneInfo(TZ)).date()
    old_enough = now_local >= _month_end(month) + timedelta(days=CLOSE_GRACE_DAYS)
    amazon_closed = finance_released and ads_events > 0 and old_enough

    contribution = None
    margin = None
    if amazon_closed and cogs_complete:
        contribution = round(order_net + advertising + other_postings - product_cogs, 2)
        margin = round(100.0 * contribution / net_sales, 2) if net_sales else None

    return {
        "month": month,
        "net_sales_ex_vat": round(net_sales, 2),
        "iva_on_sales": round(net_sales * VAT_RATE, 2),
        "shopper_product_spend": round(net_sales * (1 + VAT_RATE), 2),
        "amazon_order_net": round(order_net, 2),
        "amazon_order_effect": round(order_net - net_sales, 2),
        "advertising": round(advertising, 2),
        "advertising_events": ads_events,
        "other_amazon_postings": round(other_postings, 2),
        "product_cogs": round(product_cogs, 2),
        "contribution_after_product_cogs": contribution,
        "contribution_margin_pct": margin,
        "cash_transferred": round(cash, 2),
        "sku_rows": sku_rows,
        "missing_skus": missing_skus,
        "cogs_complete": cogs_complete,
        "cogs_coverage_pct": round(100.0 * covered_units / total_units, 1) if total_units else 100.0,
        "core_orders": core_orders,
        "released_orders": released_orders,
        "deferred_events": deferred_events,
        "finance_released": finance_released,
        "old_enough": old_enough,
        "amazon_closed": amazon_closed,
    }


def _write_close(cur, marketplace: str, snap: dict, version: int, *, restatement_reason: str | None = None) -> None:
    month = snap["month"]
    state = "RESTATED" if version > 1 else "CLOSED"
    supersedes = version - 1 if version > 1 else None
    basis = {
        "amazon_finance_status": "RELEASED",
        "amazon_order_releases_complete": snap["finance_released"],
        "deferred_events": snap["deferred_events"],
        "advertising_source": "following_calendar_month_ProductAdsPayment_bridge",
        "advertising_events": snap["advertising_events"],
        "cogs_source": "seller_standard_cost_snapshot",
        "cogs_config_path": str(COSTS_PATH),
        "cogs_coverage_pct": snap["cogs_coverage_pct"],
        "vat_rate": VAT_RATE,
    }
    cur.execute(
        """
        INSERT INTO core.finance_month_close(
          marketplace_id,month,version,state,supersedes_version,restatement_reason,
          net_sales_ex_vat,iva_on_sales,shopper_product_spend,
          amazon_order_net,amazon_order_effect,advertising,other_amazon_postings,
          product_cogs,contribution_after_product_cogs,contribution_margin_pct,
          cash_transferred,close_basis
        ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
        """,
        (
            marketplace, month, version, state, supersedes, restatement_reason,
            snap["net_sales_ex_vat"], snap["iva_on_sales"], snap["shopper_product_spend"],
            snap["amazon_order_net"], snap["amazon_order_effect"], snap["advertising"],
            snap["other_amazon_postings"], snap["product_cogs"],
            snap["contribution_after_product_cogs"], snap["contribution_margin_pct"],
            snap["cash_transferred"], json.dumps(basis),
        ),
    )
    for row in snap["sku_rows"]:
        if not row["configured"]:
            raise RuntimeError(f"Cannot close {month}: missing COGS for {row['sku']}")
        cur.execute(
            """
            INSERT INTO core.finance_month_cogs_snapshot(
              marketplace_id,month,version,seller_sku,units,unit_cogs,extended_cogs
            ) VALUES (%s,%s,%s,%s,%s,%s,%s)
            """,
            (marketplace, month, version, row["sku"], row["units"], row["unit_cogs"], row["extended_cogs"]),
        )


def close_ready_months() -> dict:
    marketplace = settings.marketplace_id
    costs = _load_costs()
    created = []
    pending = []
    with db.ingestion_run("dpp_finance", "month_close", {"marketplace": marketplace}) as run:
        with db.connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT min(business_date) AS first_sales, max(business_date) AS last_sales
                FROM mart.business_daily
                WHERE marketplace_id=%s AND reconciled_daily_report
                """,
                (marketplace,),
            )
            span = cur.fetchone() or {}
            first_sales = span.get("first_sales")
            last_sales = span.get("last_sales")
            if not first_sales or not last_sales:
                return {"created": 0, "pending": 0, "reason": "no reconciled sales"}
            current_month = last_sales.replace(day=1)
            cursor = first_sales.replace(day=1)
            while cursor < current_month:
                cur.execute(
                    "SELECT max(version) AS version FROM core.finance_month_close WHERE marketplace_id=%s AND month=%s",
                    (marketplace, cursor),
                )
                if (cur.fetchone() or {}).get("version"):
                    cursor = _next_month(cursor)
                    continue
                snap = _month_snapshot(cur, marketplace, cursor, costs)
                if snap["amazon_closed"] and snap["cogs_complete"]:
                    _write_close(cur, marketplace, snap, 1)
                    created.append(str(cursor))
                else:
                    waits = []
                    if not snap["amazon_closed"]:
                        if not snap["finance_released"]:
                            waits.append("amazon_order_releases")
                        if snap["advertising_events"] == 0:
                            waits.append("advertising_close")
                        if not snap["old_enough"]:
                            waits.append("close_grace")
                    if not snap["cogs_complete"]:
                        waits.append("product_cogs")
                    pending.append({
                        "month": str(cursor),
                        "amazon_closed": snap["amazon_closed"],
                        "waits": waits,
                        "cogs_coverage_pct": snap["cogs_coverage_pct"],
                        "missing_skus": snap["missing_skus"],
                    })
                cursor = _next_month(cursor)
            conn.commit()
        run["records_read"] = len(created) + len(pending)
        run["records_written"] = len(created)
    return {"created": len(created), "months": created, "pending": pending}


def restate_month(month_text: str, reason: str) -> dict:
    month = date.fromisoformat(month_text + "-01" if len(month_text) == 7 else month_text).replace(day=1)
    marketplace = settings.marketplace_id
    costs = _load_costs()
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT max(version) AS version FROM core.finance_month_close WHERE marketplace_id=%s AND month=%s",
            (marketplace, month),
        )
        previous = int((cur.fetchone() or {}).get("version") or 0)
        if previous < 1:
            raise RuntimeError(f"{month:%Y-%m} is not closed yet; cannot restate it")
        snap = _month_snapshot(cur, marketplace, month, costs)
        if not snap["amazon_closed"]:
            raise RuntimeError(f"{month:%Y-%m} no longer satisfies Amazon-close criteria")
        if not snap["cogs_complete"]:
            missing = ", ".join(r["sku"] for r in snap["missing_skus"])
            raise RuntimeError(f"{month:%Y-%m} has incomplete product COGS: {missing}")
        version = previous + 1
        _write_close(cur, marketplace, snap, version, restatement_reason=reason)
        conn.commit()
    return {"month": str(month), "version": version, "state": "RESTATED", "reason": reason}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--restate", help="Explicitly restate a closed YYYY-MM month using current source data/costs")
    parser.add_argument("--reason", default="Manual finance restatement")
    args = parser.parse_args()
    result = restate_month(args.restate, args.reason) if args.restate else close_ready_months()
    print(json.dumps(result, default=str))


if __name__ == "__main__":
    main()
