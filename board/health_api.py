from __future__ import annotations


def _one(cur, sql: str, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _all(cur, sql: str, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def health_board_payload(connect, marketplace: str) -> dict:
    with connect() as conn, conn.cursor() as cur:
        jobs = _all(
            cur,
            """
            SELECT source, job_name, latest_status,
                   extract(epoch from age)::bigint AS age_seconds,
                   records_read, records_written,
                   error_message
            FROM ops.data_health
            ORDER BY CASE latest_status WHEN 'error' THEN 0 WHEN 'running' THEN 1 ELSE 2 END,
                     age DESC, source, job_name
            """,
        )
        summary = {
            "jobs": len(jobs),
            "healthy": sum(1 for row in jobs if row.get("latest_status") in ("success", "running")),
            "errors": sum(1 for row in jobs if row.get("latest_status") == "error"),
            "stale": sum(1 for row in jobs if (row.get("age_seconds") or 0) > 86400),
        }
        warehouse = _one(
            cur,
            """
            SELECT
              (SELECT count(*) FROM core.amazon_order WHERE marketplace_id=%s)::int AS orders,
              (SELECT count(*) FROM core.financial_transaction WHERE marketplace_id=%s)::int AS financial_transactions,
              (SELECT count(*) FROM core.seller_listing WHERE marketplace_id=%s)::int AS seller_listings,
              (SELECT count(*) FROM core.inventory_snapshot WHERE marketplace_id=%s)::int AS inventory_snapshots,
              (SELECT max(business_date) FROM core.sales_traffic_daily WHERE marketplace_id=%s) AS sales_traffic_last_date,
              (SELECT max(posted_date) FROM core.financial_transaction WHERE marketplace_id=%s) AS finance_last_posted,
              (SELECT max(fetched_at) FROM core.seller_listing WHERE marketplace_id=%s) AS listings_last_updated
            """,
            (marketplace, marketplace, marketplace, marketplace, marketplace, marketplace, marketplace),
        )
        local_clock = _one(
            cur,
            "SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'America/Mexico_City','HH24:MI') local_time",
        )
    return {"summary": summary, "warehouse": warehouse, "jobs": jobs, "local_time": local_clock.get("local_time")}
