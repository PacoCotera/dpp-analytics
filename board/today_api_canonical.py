from __future__ import annotations

from datetime import date, timedelta

from today_api_legacy import today_payload as _legacy_today_payload


def _pct(current: float, prior: float):
    return round(100.0 * (current - prior) / prior, 1) if prior > 0 else None


def _basis(cur, marketplace: str) -> dict:
    cur.execute(
        "SELECT currency,timezone,country_code FROM core.marketplace WHERE marketplace_id=%s",
        (marketplace,),
    )
    row = cur.fetchone() or {}
    return {
        "currency": row.get("currency") or "MXN",
        "timezone": row.get("timezone"),
        "operating_sales": {
            "id": "GROSS_CUSTOMER_SPEND",
            "label": "Shopper spend incl. IVA",
            "source": "Amazon Orders",
            "definition": "Order grand total; item price × quantity is the only fallback. Settlement/proceeds amounts are never used.",
        },
    }


def _gross_daily(cur, marketplace: str, target: date, days: int = 61) -> list[dict]:
    cur.execute(
        """
        WITH d AS (
          SELECT generate_series(%s::date-(%s-1),%s::date,interval '1 day')::date AS business_date
        ), x AS (
          SELECT business_date,
                 COALESCE(sum(customer_spend),0)::numeric(14,2) AS sales,
                 count(*)::bigint AS orders,
                 COALESCE(sum(units),0)::bigint AS units
          FROM mart.order_customer_spend
          WHERE marketplace_id=%s
            AND business_date BETWEEN %s::date-(%s-1) AND %s::date
          GROUP BY business_date
        )
        SELECT d.business_date,COALESCE(x.sales,0)::numeric(14,2) AS sales,
               COALESCE(x.orders,0)::bigint AS orders,COALESCE(x.units,0)::bigint AS units
        FROM d LEFT JOIN x USING(business_date)
        ORDER BY d.business_date
        """,
        (target, days, target, marketplace, target, days, target),
    )
    return list(cur.fetchall())


def _context_from_gross(rows: list[dict], target: date, local_time: str, live: bool) -> dict:
    by_date = {r["business_date"]: float(r.get("sales") or 0) for r in rows}
    current = by_date.get(target, 0.0)
    week_start = target - timedelta(days=target.weekday())
    month_start = target.replace(day=1)
    year, month = target.year, target.month
    prev_month_end = month_start - timedelta(days=1)
    prev_month_start = prev_month_end.replace(day=1)
    prev_same_end = min(prev_month_end, prev_month_start + timedelta(days=target.day - 1))

    def total(start: date, end: date) -> float:
        if end < start:
            return 0.0
        return round(sum(v for d, v in by_date.items() if start <= d <= end), 2)

    same_weekdays = [
        v for d, v in by_date.items()
        if target - timedelta(days=56) <= d < target and d.weekday() == target.weekday()
    ]
    typical = round(sum(same_weekdays) / len(same_weekdays), 2) if same_weekdays else None
    best = round(max(same_weekdays), 2) if same_weekdays else None
    sales_week = total(week_start, target)
    sales_mtd = total(month_start, target)
    sales_last30 = total(target - timedelta(days=29), target)
    prior_week_same_days = total(week_start - timedelta(days=7), target - timedelta(days=7))
    prior_mtd_same_days = total(prev_month_start, prev_same_end)
    prior_30 = total(target - timedelta(days=59), target - timedelta(days=30))
    return {
        "local_time": local_time,
        "local_date": target.strftime("%A, %B %d").replace(" 0", " "),
        "local_hour": None if not local_time else int(str(local_time).split(":", 1)[0]),
        "typical_same_weekday_full_day": typical,
        "best_same_weekday_full_day": best,
        "sales_week": sales_week,
        "sales_mtd": sales_mtd,
        "sales_last30": sales_last30,
        "prior_week_same_days": prior_week_same_days,
        "prior_mtd_same_days": prior_mtd_same_days,
        "prior_30": prior_30,
        "week_delta_pct": _pct(sales_week, prior_week_same_days),
        "mtd_delta_pct": _pct(sales_mtd, prior_mtd_same_days),
        "last30_delta_pct": _pct(sales_last30, prior_30),
        "sales_basis": "GROSS_CUSTOMER_SPEND",
        "comparison_note": "All Today comparisons use shopper spend from Orders on the same basis.",
    }


def today_payload(connect, decorate_products, marketplace: str, selected_date: str | None = None) -> dict:
    payload = _legacy_today_payload(connect, decorate_products, marketplace, selected_date)
    target = payload.get("selected_date")
    if isinstance(target, str):
        target = date.fromisoformat(target)
    if not isinstance(target, date):
        return payload

    with connect() as conn, conn.cursor() as cur:
        basis = _basis(cur, marketplace)
        daily = _gross_daily(cur, marketplace, target, 61)
        target_row = next((r for r in daily if r.get("business_date") == target), {})

        # Correct the headline on both live and selected closed days.
        today = payload.setdefault("today", {})
        today["sales_today"] = target_row.get("sales") or 0
        today["sales_basis"] = "GROSS_CUSTOMER_SPEND"

        # Product contribution is item shopper price × quantity, never proceeds.
        cur.execute(
            """
            SELECT seller_sku AS sku,COALESCE(sum(customer_spend),0)::numeric(14,2) AS sales,
                   COALESCE(sum(units),0)::bigint AS units,count(DISTINCT amazon_order_id)::bigint AS orders
            FROM mart.order_item_customer_spend
            WHERE marketplace_id=%s AND business_date=%s AND seller_sku IS NOT NULL
            GROUP BY seller_sku
            """,
            (marketplace, target),
        )
        sku_values = {r["sku"]: r for r in cur.fetchall()}
        for product in payload.get("sku_today") or []:
            row = sku_values.get(product.get("sku"))
            if row:
                product.update(sales=row["sales"], units=row["units"], orders=row["orders"])
            product["sales_basis"] = "GROSS_CUSTOMER_SPEND"

        # Order evidence uses order grand total with gross item fallback.
        cur.execute(
            """
            SELECT amazon_order_id,customer_spend
            FROM mart.order_customer_spend
            WHERE marketplace_id=%s AND business_date=%s
            """,
            (marketplace, target),
        )
        order_values = {r["amazon_order_id"]: r["customer_spend"] for r in cur.fetchall()}
        for order in payload.get("recent_orders") or []:
            if order.get("order_id") in order_values:
                order["sales"] = order_values[order["order_id"]]
            order["sales_basis"] = "GROSS_CUSTOMER_SPEND"
        payload["latest_order"] = (payload.get("recent_orders") or [None])[0]

    last30 = [r for r in daily if r["business_date"] >= target - timedelta(days=29)]
    for row in last30:
        row["live"] = bool(payload.get("is_live") and row["business_date"] == target)
        row["selected"] = row["business_date"] == target
        row["sales_basis"] = "GROSS_CUSTOMER_SPEND"
    payload["recent_daily"] = last30
    local_time = (payload.get("context") or {}).get("local_time") or ""
    payload["context"] = _context_from_gross(daily, target, local_time, bool(payload.get("is_live")))
    payload["metric_basis"] = basis
    payload["product_contribution_sales_basis"] = "GROSS_CUSTOMER_SPEND"
    return payload
