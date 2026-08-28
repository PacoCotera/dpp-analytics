from __future__ import annotations

from datetime import date, timedelta
from statistics import median

from interpretation_rules import rule_catalog, today_business_context, today_pace
from today_api_legacy import today_payload as _legacy_today_payload


TERMINAL_ORDER_STATUSES = {"SHIPPED", "CANCELLED"}
PENDING_ORDER_STATUSES = {"PENDING", "PENDING_AVAILABILITY", "INVOICE_UNCONFIRMED"}
OPEN_ORDER_STATUSES = PENDING_ORDER_STATUSES | {"UNSHIPPED", "PARTIALLY_SHIPPED"}


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
            "source": "Amazon Orders item price",
            "definition": "Item price × quantity is authoritative whenever item detail exists; order grand total is only a temporary fallback before item detail arrives. Settlement/proceeds amounts are never used.",
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


def _context_from_gross(rows: list[dict], target: date, local_time: str) -> dict:
    by_date = {r["business_date"]: float(r.get("sales") or 0) for r in rows}
    week_start = target - timedelta(days=target.weekday())
    month_start = target.replace(day=1)
    prev_month_end = month_start - timedelta(days=1)
    prev_month_start = prev_month_end.replace(day=1)
    prev_same_end = min(prev_month_end, prev_month_start + timedelta(days=target.day - 1))

    def total(start: date, end: date) -> float:
        if end < start:
            return 0.0
        return round(sum(v for d, v in by_date.items() if start <= d <= end), 2)

    same_weekdays = [
        v
        for d, v in by_date.items()
        if target - timedelta(days=56) <= d < target and d.weekday() == target.weekday()
    ]
    typical = round(sum(same_weekdays) / len(same_weekdays), 2) if same_weekdays else None
    typical_median = round(float(median(same_weekdays)), 2) if same_weekdays else None
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
        "median_same_weekday_full_day": typical_median,
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


def _attach_order_detail(cur, orders: list[dict]) -> list[dict]:
    order_ids = [str(row.get("order_id")) for row in orders if row.get("order_id")]
    if not order_ids:
        return orders

    cur.execute(
        """
        SELECT o.amazon_order_id AS order_id,
               COALESCE(o.fulfillment_status,'') AS status,
               COALESCE(o.fulfilled_by,'') AS fulfilled_by,
               COALESCE(o.channel_name,'') AS channel_name,
               COALESCE(o.quantity_fulfilled,0)::bigint AS quantity_fulfilled,
               COALESCE(o.quantity_unfulfilled,0)::bigint AS quantity_unfulfilled,
               to_char(o.created_time AT TIME ZONE mp.timezone,'FMMon DD · HH24:MI') AS local_time,
               greatest(0,extract(epoch FROM (CURRENT_TIMESTAMP-o.created_time)))::bigint AS age_seconds,
               cs.customer_spend::numeric(14,2) AS sales
        FROM core.amazon_order o
        JOIN core.marketplace mp USING (marketplace_id)
        LEFT JOIN mart.order_customer_spend cs
          ON cs.marketplace_id=o.marketplace_id AND cs.amazon_order_id=o.amazon_order_id
        WHERE o.amazon_order_id=ANY(%s)
        """,
        (order_ids,),
    )
    metadata = {row["order_id"]: row for row in cur.fetchall()}

    cur.execute(
        """
        SELECT i.amazon_order_id AS order_id,
               i.order_item_id,
               i.seller_sku AS sku,
               i.asin,
               COALESCE(sl.item_name,s.title,i.title,i.seller_sku,'Item') AS product,
               COALESCE(sl.image_url,ci.image_url) AS image_url,
               COALESCE(i.quantity_ordered,0)::bigint AS quantity_ordered,
               COALESCE(i.quantity_fulfilled,0)::bigint AS quantity_fulfilled,
               COALESCE(i.quantity_unfulfilled,0)::bigint AS quantity_unfulfilled
        FROM core.amazon_order_item i
        JOIN core.amazon_order o USING (amazon_order_id)
        LEFT JOIN core.sku s ON s.sku=i.seller_sku
        LEFT JOIN core.seller_listing sl
          ON sl.marketplace_id=o.marketplace_id AND sl.seller_sku=i.seller_sku
        LEFT JOIN core.catalog_item ci
          ON ci.marketplace_id=o.marketplace_id AND ci.asin=COALESCE(i.asin,s.asin)
        WHERE i.amazon_order_id=ANY(%s)
        ORDER BY i.amazon_order_id,i.order_item_id
        """,
        (order_ids,),
    )
    items: dict[str, list[dict]] = {}
    for item in cur.fetchall():
        items.setdefault(item["order_id"], []).append(dict(item))

    for order in orders:
        order_id = str(order.get("order_id") or "")
        detail = metadata.get(order_id) or {}
        for key in (
            "status",
            "fulfilled_by",
            "channel_name",
            "quantity_fulfilled",
            "quantity_unfulfilled",
            "local_time",
            "age_seconds",
            "sales",
        ):
            if detail.get(key) is not None:
                order[key] = detail[key]
        order["fulfillment_model"] = (
            "FBA"
            if str(order.get("fulfilled_by") or "").upper() == "AMAZON"
            else "FBM"
            if str(order.get("fulfilled_by") or "").upper() == "MERCHANT"
            else "—"
        )
        order["items"] = items.get(order_id, [])
        order["item_count"] = len(order["items"])
    return orders


def _decorate_order_items(decorate_products, orders: list[dict]) -> list[dict]:
    """Apply the same editable SKU display dictionary used everywhere else."""
    item_rows = [
        item
        for order in orders
        for item in (order.get("items") or [])
        if isinstance(item, dict)
    ]
    if item_rows:
        decorate_products(item_rows)
    return orders


def _current_order_queue(cur, marketplace: str) -> tuple[dict, list[dict]]:
    cur.execute(
        """
        WITH q AS (
          SELECT o.*,
                 upper(COALESCE(o.fulfillment_status,'')) AS status_norm,
                 upper(COALESCE(o.fulfilled_by,'')) AS fulfilled_by_norm,
                 mp.timezone
          FROM core.amazon_order o
          JOIN core.marketplace mp USING (marketplace_id)
          WHERE o.marketplace_id=%s
        )
        SELECT
          count(*) FILTER (
            WHERE status_norm IN ('PENDING','PENDING_AVAILABILITY','INVOICE_UNCONFIRMED','UNSHIPPED','PARTIALLY_SHIPPED')
          )::bigint AS open_orders,
          count(*) FILTER (
            WHERE status_norm IN ('PENDING','PENDING_AVAILABILITY','INVOICE_UNCONFIRMED')
          )::bigint AS pending_orders,
          count(*) FILTER (WHERE status_norm='UNSHIPPED')::bigint AS unshipped_orders,
          count(*) FILTER (WHERE status_norm='PARTIALLY_SHIPPED')::bigint AS partially_shipped_orders,
          count(*) FILTER (WHERE status_norm='UNFULFILLABLE')::bigint AS problem_orders,
          count(*) FILTER (
            WHERE status_norm IN ('PENDING','PENDING_AVAILABILITY','INVOICE_UNCONFIRMED','UNSHIPPED','PARTIALLY_SHIPPED')
              AND fulfilled_by_norm='AMAZON'
          )::bigint AS fba_open_orders,
          count(*) FILTER (
            WHERE status_norm IN ('PENDING','PENDING_AVAILABILITY','INVOICE_UNCONFIRMED','UNSHIPPED','PARTIALLY_SHIPPED')
              AND fulfilled_by_norm='MERCHANT'
          )::bigint AS fbm_open_orders,
          count(*) FILTER (
            WHERE status_norm='SHIPPED'
              AND (COALESCE(o.last_updated_time,o.created_time) AT TIME ZONE timezone)::date
                  =(CURRENT_TIMESTAMP AT TIME ZONE timezone)::date
          )::bigint AS shipped_today
        FROM q o
        """,
        (marketplace,),
    )
    flow = dict(cur.fetchone() or {})
    flow["basis"] = "CURRENT_FULFILLMENT_STATE"

    cur.execute(
        """
        SELECT o.amazon_order_id AS order_id,
               right(o.amazon_order_id,9) AS order_short,
               COALESCE(o.fulfillment_status,'') AS status,
               COALESCE(o.fulfilled_by,'') AS fulfilled_by,
               COALESCE(o.channel_name,'') AS channel_name,
               to_char(o.created_time AT TIME ZONE mp.timezone,'FMMon DD · HH24:MI') AS local_time,
               greatest(0,extract(epoch FROM (CURRENT_TIMESTAMP-o.created_time)))::bigint AS age_seconds,
               cs.customer_spend::numeric(14,2) AS sales,
               COALESCE(cs.units,COALESCE(o.quantity_fulfilled,0)+COALESCE(o.quantity_unfulfilled,0),0)::bigint AS units
        FROM core.amazon_order o
        JOIN core.marketplace mp USING (marketplace_id)
        LEFT JOIN mart.order_customer_spend cs
          ON cs.marketplace_id=o.marketplace_id AND cs.amazon_order_id=o.amazon_order_id
        WHERE o.marketplace_id=%s
          AND upper(COALESCE(o.fulfillment_status,'')) IN (
            'PENDING','PENDING_AVAILABILITY','INVOICE_UNCONFIRMED','UNSHIPPED','PARTIALLY_SHIPPED'
          )
        ORDER BY o.created_time DESC
        LIMIT 20
        """,
        (marketplace,),
    )
    orders = [dict(row) for row in cur.fetchall()]
    _attach_order_detail(cur, orders)
    for order in orders:
        order["sales_basis"] = "GROSS_CUSTOMER_SPEND"
    return flow, orders


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

        recent_orders = payload.get("recent_orders") or []
        _attach_order_detail(cur, recent_orders)
        _decorate_order_items(decorate_products, recent_orders)
        for order in recent_orders:
            order["sales_basis"] = "GROSS_CUSTOMER_SPEND"
        payload["latest_order"] = (recent_orders or [None])[0]

        flow, open_orders = _current_order_queue(cur, marketplace)
        _decorate_order_items(decorate_products, open_orders)
        payload["order_flow"] = flow
        payload["open_orders"] = open_orders

    last30 = [r for r in daily if r["business_date"] >= target - timedelta(days=29)]
    for row in last30:
        row["live"] = bool(payload.get("is_live") and row["business_date"] == target)
        row["selected"] = row["business_date"] == target
        row["sales_basis"] = "GROSS_CUSTOMER_SPEND"
    payload["recent_daily"] = last30

    local_time = (payload.get("context") or {}).get("local_time") or ""
    context = _context_from_gross(daily, target, local_time)
    payload["context"] = context

    # Live same-time pace is already computed by mart.today_operating on the same
    # shopper-spend basis. A selected closed day instead compares its full-day
    # shopper spend with prior matching weekdays, also on that same basis.
    if not payload.get("is_live"):
        typical = context.get("typical_same_weekday_full_day")
        current = float(today.get("sales_today") or 0)
        today["pace_vs_same_weekday_pct"] = _pct(current, float(typical or 0))

    payload["metric_basis"] = basis
    payload["product_contribution_sales_basis"] = "GROSS_CUSTOMER_SPEND"
    payload["order_operations_basis"] = "CURRENT_AMAZON_FULFILLMENT_STATE"
    payload["day_read"] = today_pace(
        payload.get("is_live"),
        today.get("orders_today"),
        today.get("pace_vs_same_weekday_pct"),
        target.strftime("%A"),
    )
    payload["business_context_read"] = today_business_context(
        context.get("mtd_delta_pct"), context.get("last30_delta_pct")
    )
    payload["interpretation_rules"] = rule_catalog(
        "TODAY_PACE_V1", "TODAY_BUSINESS_CONTEXT_V1"
    )
    return payload
