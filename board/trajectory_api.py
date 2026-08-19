from __future__ import annotations


def _one(cur, sql: str, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _all(cur, sql: str, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def trajectory_payload(connect, marketplace: str) -> dict:
    with connect() as conn, conn.cursor() as cur:
        cutoff = _one(
            cur,
            """
            SELECT max(business_date) AS d
            FROM mart.business_daily
            WHERE marketplace_id=%s AND reconciled_daily_report
            """,
            (marketplace,),
        ).get("d")
        if cutoff is None:
            return {"headline": {}, "horizons": [], "series": [], "weekly": [], "local_time": None}

        horizons = []
        for label, days in (("7D", 7), ("28D", 28), ("56D", 56), ("90D", 90)):
            row = _one(
                cur,
                """
                WITH c AS (SELECT %s::date d), x AS (
                  SELECT
                    COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-(%s-1) AND c.d),0)::numeric(14,2) sales,
                    COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-(%s*2-1) AND c.d-%s),0)::numeric(14,2) prior_sales,
                    COALESCE(sum(orders) FILTER (WHERE business_date BETWEEN c.d-(%s-1) AND c.d),0)::bigint orders,
                    COALESCE(sum(units) FILTER (WHERE business_date BETWEEN c.d-(%s-1) AND c.d),0)::bigint units
                  FROM mart.business_daily, c
                  WHERE marketplace_id=%s
                    AND business_date BETWEEN c.d-(%s*2-1) AND c.d
                )
                SELECT sales, prior_sales, orders, units,
                       round(sales/%s::numeric,2) daily_avg,
                       CASE WHEN prior_sales>0 THEN round(100.0*(sales-prior_sales)/prior_sales,1) END delta_pct
                FROM x
                """,
                (cutoff, days, days, days, days, days, marketplace, days, days),
            )
            row["label"] = label
            horizons.append(row)

        headline = {
            "business_date": cutoff,
            "sales_t28": horizons[1].get("sales") if len(horizons) > 1 else None,
            "delta28_pct": horizons[1].get("delta_pct") if len(horizons) > 1 else None,
            "daily_avg_t28": horizons[1].get("daily_avg") if len(horizons) > 1 else None,
            "delta90_pct": horizons[3].get("delta_pct") if len(horizons) > 3 else None,
        }

        series = _all(
            cur,
            """
            SELECT business_date, sales,
                   avg(sales) OVER (
                     PARTITION BY marketplace_id ORDER BY business_date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW
                   )::numeric(14,2) AS avg28
            FROM mart.business_daily
            WHERE marketplace_id=%s AND business_date BETWEEN %s::date-179 AND %s::date
            ORDER BY business_date
            """,
            (marketplace, cutoff, cutoff),
        )

        weekly = _all(
            cur,
            """
            WITH d AS (
              SELECT business_date, sales
              FROM mart.business_daily
              WHERE marketplace_id=%s AND business_date BETWEEN %s::date-97 AND %s::date
            )
            SELECT date_trunc('week',business_date)::date AS week_start,
                   sum(sales)::numeric(14,2) AS sales,
                   round(avg(sales),2) AS daily_avg
            FROM d
            GROUP BY 1
            ORDER BY 1
            """,
            (marketplace, cutoff, cutoff),
        )

        local_clock = _one(
            cur,
            "SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'America/Mexico_City','HH24:MI') local_time",
        )

    return {
        "headline": headline,
        "horizons": horizons,
        "series": series,
        "weekly": weekly,
        "local_time": local_clock.get("local_time"),
    }
