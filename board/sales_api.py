from __future__ import annotations


def _one(cur, sql: str, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _all(cur, sql: str, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def sales_payload(connect, decorate_products, marketplace: str) -> dict:
    """Build the decision-oriented Sales page payload.

    Historical headline/period metrics use the latest reconciled Data Kiosk day.
    Today remains the near-real-time Orders API view. No customer PII is selected.
    """
    with connect() as conn, conn.cursor() as cur:
        cutoff = _one(
            cur,
            """
            SELECT max(business_date) AS business_date
            FROM mart.business_daily
            WHERE marketplace_id=%s AND reconciled_daily_report
            """,
            (marketplace,),
        ).get("business_date")

        if cutoff is None:
            return {
                "today": {}, "headline": {}, "periods": [], "series": [],
                "skus": [], "orders": [], "local_time": None,
            }

        today = _one(cur, "SELECT * FROM mart.today_operating WHERE marketplace_id=%s", (marketplace,))

        headline = _one(
            cur,
            """
            WITH c AS (SELECT %s::date AS d),
            now28 AS (
              SELECT
                COALESCE(sum(sales),0)::numeric(14,2) sales_t28,
                COALESCE(sum(orders),0)::bigint orders_t28,
                COALESCE(sum(units),0)::bigint units_t28,
                COALESCE(sum(sessions),0)::bigint sessions_t28
              FROM mart.business_daily, c
              WHERE marketplace_id=%s AND business_date BETWEEN c.d-27 AND c.d
            ),
            prev28 AS (
              SELECT COALESCE(sum(sales),0)::numeric(14,2) sales_prior_t28
              FROM mart.business_daily, c
              WHERE marketplace_id=%s AND business_date BETWEEN c.d-55 AND c.d-28
            ),
            now7 AS (
              SELECT COALESCE(sum(sales),0)::numeric(14,2) sales_t7
              FROM mart.business_daily, c
              WHERE marketplace_id=%s AND business_date BETWEEN c.d-6 AND c.d
            ),
            prev7 AS (
              SELECT COALESCE(sum(sales),0)::numeric(14,2) sales_prior_t7
              FROM mart.business_daily, c
              WHERE marketplace_id=%s AND business_date BETWEEN c.d-13 AND c.d-7
            )
            SELECT
              c.d AS business_date,
              n.sales_t28, n.orders_t28, n.units_t28, n.sessions_t28,
              n7.sales_t7,
              round(n7.sales_t7/7.0,2) AS daily_avg_t7,
              CASE WHEN p7.sales_prior_t7>0
                   THEN round(100.0*(n7.sales_t7-p7.sales_prior_t7)/p7.sales_prior_t7,1) END delta7_pct,
              CASE WHEN p.sales_prior_t28>0
                   THEN round(100.0*(n.sales_t28-p.sales_prior_t28)/p.sales_prior_t28,1) END delta28_pct,
              CASE WHEN n.sessions_t28>0
                   THEN round(100.0*n.units_t28/n.sessions_t28,1) END cvr28_pct
            FROM c CROSS JOIN now28 n CROSS JOIN prev28 p CROSS JOIN now7 n7 CROSS JOIN prev7 p7
            """,
            (cutoff, marketplace, marketplace, marketplace, marketplace),
        )

        periods = []
        for label, days in (("7 days", 7), ("28 days", 28), ("56 days", 56), ("90 days", 90)):
            row = _one(
                cur,
                """
                WITH c AS (SELECT %s::date AS d),
                x AS (
                  SELECT
                    COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-(%s-1) AND c.d),0)::numeric(14,2) sales,
                    COALESCE(sum(orders) FILTER (WHERE business_date BETWEEN c.d-(%s-1) AND c.d),0)::bigint orders,
                    COALESCE(sum(units) FILTER (WHERE business_date BETWEEN c.d-(%s-1) AND c.d),0)::bigint units,
                    COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-(%s*2-1) AND c.d-%s),0)::numeric(14,2) prior_sales
                  FROM mart.business_daily, c
                  WHERE marketplace_id=%s
                    AND business_date BETWEEN c.d-(%s*2-1) AND c.d
                )
                SELECT sales, orders, units,
                       round(sales/%s::numeric,2) daily_avg,
                       CASE WHEN prior_sales>0 THEN round(100.0*(sales-prior_sales)/prior_sales,1) END delta_pct
                FROM x
                """,
                (cutoff, days, days, days, days, days, marketplace, days, days),
            )
            row["label"] = label
            periods.append(row)

        series = _all(
            cur,
            """
            SELECT business_date, sales, orders, units
            FROM mart.business_daily
            WHERE marketplace_id=%s AND business_date BETWEEN %s::date-89 AND %s::date
            ORDER BY business_date
            """,
            (marketplace, cutoff, cutoff),
        )

        skus = _all(
            cur,
            """
            SELECT
              m.seller_sku AS sku,
              COALESCE(m.asin,s.asin) AS asin,
              COALESCE(sl.item_name,ci.title,s.title,m.seller_sku) AS product,
              COALESCE(sl.image_url,ci.image_url) AS image_url,
              m.sales_t28, m.units_t28, m.delta28_pct, m.state
            FROM mart.catalog_movers_t28 m
            LEFT JOIN core.sku s ON s.sku=m.seller_sku
            LEFT JOIN core.seller_listing sl
              ON sl.marketplace_id=m.marketplace_id AND sl.seller_sku=m.seller_sku
            LEFT JOIN core.catalog_item ci
              ON ci.marketplace_id=m.marketplace_id AND ci.asin=COALESCE(m.asin,s.asin)
            WHERE m.marketplace_id=%s AND m.sales_t28>0
            ORDER BY m.sales_t28 DESC
            LIMIT 12
            """,
            (marketplace,),
        )

        orders = _all(
            cur,
            """
            WITH items AS (
              SELECT
                i.amazon_order_id,
                string_agg(DISTINCT COALESCE(i.seller_sku,i.title,'item'), ', ' ORDER BY COALESCE(i.seller_sku,i.title,'item')) AS items,
                COALESCE(sum(i.proceeds_total_amount),sum(i.proceeds_item_amount),sum(i.unit_price_amount*i.quantity_ordered),0)::numeric(14,2) AS item_sales
              FROM core.amazon_order_item i
              GROUP BY i.amazon_order_id
            )
            SELECT
              to_char(o.created_time AT TIME ZONE mp.timezone,'MM-DD HH24:MI') AS local_time,
              extract(epoch FROM (CURRENT_TIMESTAMP-o.created_time))::bigint AS age_seconds,
              right(o.amazon_order_id,9) AS order_short,
              COALESCE(i.items,'') AS items,
              COALESCE(o.grand_total_amount,i.item_sales,0)::numeric(14,2) AS sales,
              COALESCE(o.fulfillment_status,'') AS status
            FROM core.amazon_order o
            JOIN core.marketplace mp USING (marketplace_id)
            LEFT JOIN items i USING (amazon_order_id)
            WHERE o.marketplace_id=%s
            ORDER BY o.created_time DESC
            LIMIT 20
            """,
            (marketplace,),
        )

        local_clock = _one(
            cur,
            "SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'America/Mexico_City','HH24:MI') local_time",
        )

    return {
        "today": today,
        "headline": headline,
        "periods": periods,
        "series": series,
        "skus": decorate_products(skus),
        "orders": orders,
        "local_time": local_clock.get("local_time"),
    }
