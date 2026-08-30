from __future__ import annotations

from datetime import date, timedelta


def _one(cur, sql: str, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _all(cur, sql: str, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def _resolve_target(cur, marketplace: str, selected_date: str | None) -> tuple[date, date, str]:
    clock = _one(
        cur,
        """
        SELECT (CURRENT_TIMESTAMP AT TIME ZONE timezone)::date AS local_today,
               to_char(CURRENT_TIMESTAMP AT TIME ZONE timezone,'HH24:MI') AS local_time
        FROM core.marketplace
        WHERE marketplace_id=%s
        """,
        (marketplace,),
    )
    local_today = clock.get("local_today")
    if local_today is None:
        raise ValueError("Marketplace timezone is unavailable")
    if selected_date:
        try:
            target = date.fromisoformat(selected_date)
        except ValueError as exc:
            raise ValueError("date must be YYYY-MM-DD") from exc
    else:
        target = local_today
    if target > local_today or target < local_today - timedelta(days=7):
        raise ValueError("Today history is limited to today and the previous 7 days")
    return local_today, target, clock.get("local_time") or ""


def _closed_day_payload(cur, decorate_products, marketplace: str, target: date, local_today: date, local_time: str) -> dict:
    day = _one(
        cur,
        """
        WITH item_rollup AS (
          SELECT i.amazon_order_id,
                 COALESCE(sum(i.quantity_ordered),0)::bigint AS units,
                 COALESCE(sum(i.proceeds_total_amount),sum(i.proceeds_item_amount),sum(i.unit_price_amount*i.quantity_ordered),0)::numeric(14,2) AS item_sales
          FROM core.amazon_order_item i
          GROUP BY i.amazon_order_id
        ), x AS (
          SELECT COALESCE(sum(COALESCE(o.grand_total_amount,i.item_sales,0)),0)::numeric(14,2) AS sales,
                 count(*)::bigint AS orders,
                 COALESCE(sum(i.units),0)::bigint AS units
          FROM core.amazon_order o
          JOIN core.marketplace mp USING (marketplace_id)
          LEFT JOIN item_rollup i USING (amazon_order_id)
          WHERE o.marketplace_id=%s
            AND (o.created_time AT TIME ZONE mp.timezone)::date=%s::date
            AND o.fulfillment_status IS DISTINCT FROM 'CANCELLED'
        ), comparable AS (
          SELECT avg(b.sales)::numeric(14,2) AS typical
          FROM mart.business_daily b
          WHERE b.marketplace_id=%s
            AND b.business_date BETWEEN %s::date-56 AND %s::date-1
            AND extract(isodow FROM b.business_date)=extract(isodow FROM %s::date)
        )
        SELECT x.sales AS sales_today, x.orders AS orders_today, x.units AS units_today,
               CASE WHEN c.typical>0 THEN round(100.0*(x.sales-c.typical)/c.typical,1) END AS pace_vs_same_weekday_pct
        FROM x CROSS JOIN comparable c
        """,
        (marketplace, target, marketplace, target, target, target),
    )

    context = _one(
        cur,
        """
        WITH t AS (SELECT %s::date AS d), hist AS (
          SELECT
            COALESCE(sum(b.sales) FILTER (
              WHERE b.business_date BETWEEN date_trunc('week',t.d)::date AND t.d-1
            ),0)::numeric(14,2) AS week_before_day,
            COALESCE(sum(b.sales) FILTER (
              WHERE b.business_date BETWEEN date_trunc('month',t.d)::date AND t.d-1
            ),0)::numeric(14,2) AS month_before_day,
            COALESCE(sum(b.sales) FILTER (
              WHERE b.business_date BETWEEN t.d-29 AND t.d-1
            ),0)::numeric(14,2) AS last30_before_day,
            COALESCE(sum(b.sales) FILTER (
              WHERE b.business_date BETWEEN date_trunc('week',t.d)::date-7 AND t.d-7
            ),0)::numeric(14,2) AS prior_week_same_days,
            COALESCE(sum(b.sales) FILTER (
              WHERE b.business_date BETWEEN date_trunc('month',t.d-interval '1 month')::date
                AND LEAST(
                  (date_trunc('month',t.d-interval '1 month')
                    + (extract(day FROM t.d)::int-1)*interval '1 day')::date,
                  date_trunc('month',t.d)::date-1
                )
            ),0)::numeric(14,2) AS prior_mtd_same_days,
            COALESCE(sum(b.sales) FILTER (
              WHERE b.business_date BETWEEN t.d-59 AND t.d-30
            ),0)::numeric(14,2) AS prior_30
          FROM t
          LEFT JOIN mart.business_daily b
            ON b.marketplace_id=%s AND b.business_date BETWEEN t.d-60 AND t.d-1
          GROUP BY t.d
        ), comparable AS (
          SELECT round(avg(b.sales),2) AS typical,
                 max(b.sales)::numeric(14,2) AS best
          FROM mart.business_daily b, t
          WHERE b.marketplace_id=%s
            AND b.business_date BETWEEN t.d-56 AND t.d-1
            AND extract(isodow FROM b.business_date)=extract(isodow FROM t.d)
        ), totals AS (
          SELECT (h.week_before_day+%s::numeric)::numeric(14,2) AS sales_week,
                 (h.month_before_day+%s::numeric)::numeric(14,2) AS sales_mtd,
                 (h.last30_before_day+%s::numeric)::numeric(14,2) AS sales_last30,
                 h.prior_week_same_days,h.prior_mtd_same_days,h.prior_30
          FROM hist h
        )
        SELECT %s AS local_time,
               to_char(t.d,'FMDay, FMMonth DD') AS local_date,
               24::int AS local_hour,
               c.typical AS typical_same_weekday_full_day,
               c.best AS best_same_weekday_full_day,
               x.sales_week,x.sales_mtd,x.sales_last30,
               x.prior_week_same_days,x.prior_mtd_same_days,x.prior_30,
               CASE WHEN x.prior_week_same_days>0 THEN round(100.0*(x.sales_week-x.prior_week_same_days)/x.prior_week_same_days,1) END AS week_delta_pct,
               CASE WHEN x.prior_mtd_same_days>0 THEN round(100.0*(x.sales_mtd-x.prior_mtd_same_days)/x.prior_mtd_same_days,1) END AS mtd_delta_pct,
               CASE WHEN x.prior_30>0 THEN round(100.0*(x.sales_last30-x.prior_30)/x.prior_30,1) END AS last30_delta_pct
        FROM t CROSS JOIN comparable c CROSS JOIN totals x
        """,
        (
            target,
            marketplace,
            marketplace,
            day.get("sales_today") or 0,
            day.get("sales_today") or 0,
            day.get("sales_today") or 0,
            local_time,
        ),
    )

    recent_orders = _all(
        cur,
        """
        WITH item_rollup AS (
          SELECT i.amazon_order_id,
                 min(i.seller_sku) FILTER (WHERE i.seller_sku IS NOT NULL) AS sku,
                 min(i.asin) FILTER (WHERE i.asin IS NOT NULL) AS asin,
                 string_agg(DISTINCT COALESCE(i.seller_sku,i.title,'item'), ', ' ORDER BY COALESCE(i.seller_sku,i.title,'item')) AS items,
                 COALESCE(sum(i.quantity_ordered),0)::bigint AS units,
                 COALESCE(sum(i.proceeds_total_amount),sum(i.proceeds_item_amount),sum(i.unit_price_amount*i.quantity_ordered),0)::numeric(14,2) AS item_sales
          FROM core.amazon_order_item i
          GROUP BY i.amazon_order_id
        )
        SELECT o.amazon_order_id AS order_id,
               right(o.amazon_order_id,9) AS order_short,
               i.sku,i.asin,
               COALESCE(sl.item_name,s.title,i.items,i.sku,'Order') AS product,
               COALESCE(sl.image_url,ci.image_url) AS image_url,
               COALESCE(o.grand_total_amount,i.item_sales,0)::numeric(14,2) AS sales,
               COALESCE(i.units,0)::bigint AS units,
               to_char(o.created_time AT TIME ZONE mp.timezone,'HH24:MI') AS local_time,
               NULL::bigint AS age_seconds,
               COALESCE(o.fulfillment_status,'') AS status
        FROM core.amazon_order o
        JOIN core.marketplace mp USING (marketplace_id)
        LEFT JOIN item_rollup i USING (amazon_order_id)
        LEFT JOIN core.sku s ON s.sku=i.sku
        LEFT JOIN core.seller_listing sl ON sl.marketplace_id=o.marketplace_id AND sl.seller_sku=i.sku
        LEFT JOIN core.catalog_item ci ON ci.marketplace_id=o.marketplace_id AND ci.asin=COALESCE(i.asin,s.asin)
        WHERE o.marketplace_id=%s
          AND (o.created_time AT TIME ZONE mp.timezone)::date=%s::date
          AND o.fulfillment_status IS DISTINCT FROM 'CANCELLED'
        ORDER BY o.created_time DESC
        LIMIT 16
        """,
        (marketplace, target),
    )

    sku_day = _all(
        cur,
        """
        SELECT i.seller_sku AS sku,
               max(i.asin) AS asin,
               COALESCE(sl.item_name,s.title,max(i.title),i.seller_sku) AS product,
               COALESCE(sl.image_url,ci.image_url) AS image_url,
               COALESCE(sum(i.proceeds_total_amount),sum(i.proceeds_item_amount),sum(i.unit_price_amount*i.quantity_ordered),0)::numeric(14,2) AS sales,
               COALESCE(sum(i.quantity_ordered),0)::bigint AS units,
               count(DISTINCT i.amazon_order_id)::bigint AS orders
        FROM core.amazon_order_item i
        JOIN core.amazon_order o USING (amazon_order_id)
        JOIN core.marketplace mp USING (marketplace_id)
        LEFT JOIN core.sku s ON s.sku=i.seller_sku
        LEFT JOIN core.seller_listing sl ON sl.marketplace_id=o.marketplace_id AND sl.seller_sku=i.seller_sku
        LEFT JOIN core.catalog_item ci ON ci.marketplace_id=o.marketplace_id AND ci.asin=COALESCE(i.asin,s.asin)
        WHERE o.marketplace_id=%s
          AND i.seller_sku IS NOT NULL
          AND (o.created_time AT TIME ZONE mp.timezone)::date=%s::date
          AND o.fulfillment_status IS DISTINCT FROM 'CANCELLED'
        GROUP BY i.seller_sku,sl.item_name,sl.image_url,ci.image_url,s.title
        ORDER BY sales DESC,units DESC
        LIMIT 8
        """,
        (marketplace, target),
    )

    daily_history = _all(
        cur,
        """
        WITH t AS (SELECT %s::date AS d), days AS (
          SELECT generate_series(date_trunc('year',t.d)::date,t.d,interval '1 day')::date AS business_date FROM t
        ), item_rollup AS (
          SELECT i.amazon_order_id,
                 COALESCE(sum(i.quantity_ordered),0)::bigint AS units,
                 COALESCE(sum(i.proceeds_total_amount),sum(i.proceeds_item_amount),sum(i.unit_price_amount*i.quantity_ordered),0)::numeric(14,2) AS item_sales
          FROM core.amazon_order_item i GROUP BY i.amazon_order_id
        ), od AS (
          SELECT (o.created_time AT TIME ZONE mp.timezone)::date AS business_date,
                 COALESCE(sum(COALESCE(o.grand_total_amount,i.item_sales,0)),0)::numeric(14,2) AS sales,
                 count(*)::bigint AS orders,
                 COALESCE(sum(i.units),0)::bigint AS units
          FROM core.amazon_order o
          JOIN core.marketplace mp USING (marketplace_id)
          LEFT JOIN item_rollup i USING (amazon_order_id), t
          WHERE o.marketplace_id=%s
            AND (o.created_time AT TIME ZONE mp.timezone)::date BETWEEN date_trunc('year',t.d)::date AND t.d
            AND o.fulfillment_status IS DISTINCT FROM 'CANCELLED'
          GROUP BY 1
        )
        SELECT d.business_date,
               CASE WHEN b.reconciled_daily_report THEN COALESCE(b.sales,0) ELSE COALESCE(od.sales,b.sales,0) END::numeric(14,2) AS sales,
               CASE WHEN b.reconciled_daily_report THEN COALESCE(b.orders,0) ELSE COALESCE(od.orders,b.orders,0) END::bigint AS orders,
               CASE WHEN b.reconciled_daily_report THEN COALESCE(b.units,0) ELSE COALESCE(od.units,b.units,0) END::bigint AS units,
               false AS live,
               d.business_date=%s::date AS selected
        FROM days d
        LEFT JOIN mart.business_daily b ON b.marketplace_id=%s AND b.business_date=d.business_date
        LEFT JOIN od ON od.business_date=d.business_date
        ORDER BY d.business_date
        """,
        (target, marketplace, target, marketplace),
    )
    recent_daily = daily_history[-30:]

    recent_orders = decorate_products(recent_orders)
    sku_day = decorate_products(sku_day)
    return {
        "selected_date": target,
        "local_today": local_today,
        "is_live": False,
        "history_limit_days": 7,
        "today": day,
        "context": context,
        "latest_order": recent_orders[0] if recent_orders else None,
        "recent_orders": recent_orders,
        "sku_today": sku_day,
        "daily_history": daily_history,
        "recent_daily": recent_daily,
    }


def today_payload(connect, decorate_products, marketplace: str, selected_date: str | None = None) -> dict:
    """Today wallboard plus up to seven prior closed days.

    Current-day facts come from Orders. A requested prior date uses the order ledger
    for that closed day's headline/product/order facts and reconciled business-day
    data where available for surrounding rhythm and benchmarks. No customer PII is
    selected or returned.
    """
    with connect() as conn, conn.cursor() as cur:
        local_today, target, local_time = _resolve_target(cur, marketplace, selected_date)
        if target != local_today:
            return _closed_day_payload(cur, decorate_products, marketplace, target, local_today, local_time)

        today = _one(cur, "SELECT * FROM mart.today_operating WHERE marketplace_id=%s", (marketplace,))

        context = _one(
            cur,
            """
            WITH clock AS (
              SELECT m.marketplace_id,m.timezone,CURRENT_TIMESTAMP AT TIME ZONE m.timezone AS local_now
              FROM core.marketplace m WHERE m.marketplace_id=%s
            ), comparable AS (
              SELECT b.business_date,b.sales
              FROM mart.business_daily b,clock c
              WHERE b.marketplace_id=c.marketplace_id
                AND b.business_date BETWEEN c.local_now::date-56 AND c.local_now::date-1
                AND extract(isodow FROM b.business_date)=extract(isodow FROM c.local_now)
            ), hist AS (
              SELECT
                COALESCE(sum(b.sales) FILTER (WHERE b.business_date BETWEEN date_trunc('week',c.local_now)::date AND c.local_now::date-1),0)::numeric(14,2) AS week_before_today,
                COALESCE(sum(b.sales) FILTER (WHERE b.business_date BETWEEN date_trunc('month',c.local_now)::date AND c.local_now::date-1),0)::numeric(14,2) AS month_before_today,
                COALESCE(sum(b.sales) FILTER (WHERE b.business_date BETWEEN c.local_now::date-29 AND c.local_now::date-1),0)::numeric(14,2) AS last30_before_today,
                COALESCE(sum(b.sales) FILTER (WHERE b.business_date BETWEEN date_trunc('week',c.local_now)::date-7 AND c.local_now::date-7),0)::numeric(14,2) AS prior_week_same_days,
                COALESCE(sum(b.sales) FILTER (
                  WHERE b.business_date BETWEEN date_trunc('month',c.local_now-interval '1 month')::date
                    AND LEAST((date_trunc('month',c.local_now-interval '1 month')+(extract(day FROM c.local_now)::int-1)*interval '1 day')::date,date_trunc('month',c.local_now)::date-1)
                ),0)::numeric(14,2) AS prior_mtd_same_days,
                COALESCE(sum(b.sales) FILTER (WHERE b.business_date BETWEEN c.local_now::date-59 AND c.local_now::date-30),0)::numeric(14,2) AS prior_30
              FROM clock c
              LEFT JOIN mart.business_daily b ON b.marketplace_id=c.marketplace_id AND b.business_date BETWEEN c.local_now::date-60 AND c.local_now::date-1
              GROUP BY c.local_now
            ), live AS (
              SELECT COALESCE(sales_today,0)::numeric(14,2) AS sales_today
              FROM mart.today_operating WHERE marketplace_id=%s
            ), totals AS (
              SELECT (h.week_before_today+l.sales_today)::numeric(14,2) AS sales_week,
                     (h.month_before_today+l.sales_today)::numeric(14,2) AS sales_mtd,
                     (h.last30_before_today+l.sales_today)::numeric(14,2) AS sales_last30,
                     h.prior_week_same_days,h.prior_mtd_same_days,h.prior_30
              FROM hist h CROSS JOIN live l
            )
            SELECT to_char(c.local_now,'HH24:MI') AS local_time,
                   to_char(c.local_now,'FMDay, FMMonth DD') AS local_date,
                   extract(hour FROM c.local_now)::int AS local_hour,
                   round(avg(comparable.sales),2) AS typical_same_weekday_full_day,
                   max(comparable.sales)::numeric(14,2) AS best_same_weekday_full_day,
                   t.sales_week,t.sales_mtd,t.sales_last30,t.prior_week_same_days,t.prior_mtd_same_days,t.prior_30,
                   CASE WHEN t.prior_week_same_days>0 THEN round(100.0*(t.sales_week-t.prior_week_same_days)/t.prior_week_same_days,1) END AS week_delta_pct,
                   CASE WHEN t.prior_mtd_same_days>0 THEN round(100.0*(t.sales_mtd-t.prior_mtd_same_days)/t.prior_mtd_same_days,1) END AS mtd_delta_pct,
                   CASE WHEN t.prior_30>0 THEN round(100.0*(t.sales_last30-t.prior_30)/t.prior_30,1) END AS last30_delta_pct
            FROM clock c CROSS JOIN totals t LEFT JOIN comparable ON true
            GROUP BY c.local_now,t.sales_week,t.sales_mtd,t.sales_last30,t.prior_week_same_days,t.prior_mtd_same_days,t.prior_30
            """,
            (marketplace, marketplace),
        )

        recent_orders = _all(
            cur,
            """
            WITH item_rollup AS (
              SELECT i.amazon_order_id,min(i.seller_sku) FILTER (WHERE i.seller_sku IS NOT NULL) AS sku,
                     min(i.asin) FILTER (WHERE i.asin IS NOT NULL) AS asin,
                     string_agg(DISTINCT COALESCE(i.seller_sku,i.title,'item'), ', ' ORDER BY COALESCE(i.seller_sku,i.title,'item')) AS items,
                     COALESCE(sum(i.quantity_ordered),0)::bigint AS units,
                     COALESCE(sum(i.proceeds_total_amount),sum(i.proceeds_item_amount),sum(i.unit_price_amount*i.quantity_ordered),0)::numeric(14,2) AS item_sales
              FROM core.amazon_order_item i GROUP BY i.amazon_order_id
            )
            SELECT o.amazon_order_id AS order_id,right(o.amazon_order_id,9) AS order_short,i.sku,i.asin,
                   COALESCE(sl.item_name,s.title,i.items,i.sku,'Order') AS product,
                   COALESCE(sl.image_url,ci.image_url) AS image_url,
                   COALESCE(o.grand_total_amount,i.item_sales,0)::numeric(14,2) AS sales,
                   COALESCE(i.units,0)::bigint AS units,
                   to_char(o.created_time AT TIME ZONE mp.timezone,'HH24:MI') AS local_time,
                   extract(epoch FROM (CURRENT_TIMESTAMP-o.created_time))::bigint AS age_seconds,
                   COALESCE(o.fulfillment_status,'') AS status
            FROM core.amazon_order o
            JOIN core.marketplace mp USING (marketplace_id)
            LEFT JOIN item_rollup i USING (amazon_order_id)
            LEFT JOIN core.sku s ON s.sku=i.sku
            LEFT JOIN core.seller_listing sl ON sl.marketplace_id=o.marketplace_id AND sl.seller_sku=i.sku
            LEFT JOIN core.catalog_item ci ON ci.marketplace_id=o.marketplace_id AND ci.asin=COALESCE(i.asin,s.asin)
            WHERE o.marketplace_id=%s
              AND (o.created_time AT TIME ZONE mp.timezone)::date=(CURRENT_TIMESTAMP AT TIME ZONE mp.timezone)::date
              AND o.fulfillment_status IS DISTINCT FROM 'CANCELLED'
            ORDER BY o.created_time DESC LIMIT 16
            """,
            (marketplace,),
        )

        sku_today = _all(
            cur,
            """
            SELECT i.seller_sku AS sku,max(i.asin) AS asin,
                   COALESCE(sl.item_name,s.title,max(i.title),i.seller_sku) AS product,
                   COALESCE(sl.image_url,ci.image_url) AS image_url,
                   COALESCE(sum(i.proceeds_total_amount),sum(i.proceeds_item_amount),sum(i.unit_price_amount*i.quantity_ordered),0)::numeric(14,2) AS sales,
                   COALESCE(sum(i.quantity_ordered),0)::bigint AS units,count(DISTINCT i.amazon_order_id)::bigint AS orders
            FROM core.amazon_order_item i
            JOIN core.amazon_order o USING (amazon_order_id)
            JOIN core.marketplace mp USING (marketplace_id)
            LEFT JOIN core.sku s ON s.sku=i.seller_sku
            LEFT JOIN core.seller_listing sl ON sl.marketplace_id=o.marketplace_id AND sl.seller_sku=i.seller_sku
            LEFT JOIN core.catalog_item ci ON ci.marketplace_id=o.marketplace_id AND ci.asin=COALESCE(i.asin,s.asin)
            WHERE o.marketplace_id=%s AND i.seller_sku IS NOT NULL
              AND (o.created_time AT TIME ZONE mp.timezone)::date=(CURRENT_TIMESTAMP AT TIME ZONE mp.timezone)::date
              AND o.fulfillment_status IS DISTINCT FROM 'CANCELLED'
            GROUP BY i.seller_sku,sl.item_name,sl.image_url,ci.image_url,s.title
            ORDER BY sales DESC,units DESC LIMIT 8
            """,
            (marketplace,),
        )

        daily_history = _all(
            cur,
            """
            WITH clock AS (
              SELECT m.marketplace_id,m.timezone,CURRENT_TIMESTAMP AT TIME ZONE m.timezone AS local_now
              FROM core.marketplace m WHERE m.marketplace_id=%s
            ), days AS (
              SELECT generate_series(date_trunc('year',c.local_now)::date,c.local_now::date,interval '1 day')::date AS business_date FROM clock c
            ), live AS (
              SELECT COALESCE(sales_today,0)::numeric(14,2) AS sales,COALESCE(orders_today,0)::bigint AS orders,COALESCE(units_today,0)::bigint AS units
              FROM mart.today_operating WHERE marketplace_id=%s
            )
            SELECT d.business_date,
                   CASE WHEN d.business_date=c.local_now::date THEN l.sales ELSE COALESCE(b.sales,0) END::numeric(14,2) AS sales,
                   CASE WHEN d.business_date=c.local_now::date THEN l.orders ELSE COALESCE(b.orders,0) END::bigint AS orders,
                   CASE WHEN d.business_date=c.local_now::date THEN l.units ELSE COALESCE(b.units,0) END::bigint AS units,
                   d.business_date=c.local_now::date AS live,
                   d.business_date=c.local_now::date AS selected
            FROM days d CROSS JOIN clock c CROSS JOIN live l
            LEFT JOIN mart.business_daily b ON b.marketplace_id=c.marketplace_id AND b.business_date=d.business_date
            ORDER BY d.business_date
            """,
            (marketplace, marketplace),
        )
        recent_daily = daily_history[-30:]

    recent_orders = decorate_products(recent_orders)
    sku_today = decorate_products(sku_today)
    return {
        "selected_date": target,
        "local_today": local_today,
        "is_live": True,
        "history_limit_days": 7,
        "today": today,
        "context": context,
        "latest_order": recent_orders[0] if recent_orders else None,
        "recent_orders": recent_orders,
        "sku_today": sku_today,
        "daily_history": daily_history,
        "recent_daily": recent_daily,
    }
