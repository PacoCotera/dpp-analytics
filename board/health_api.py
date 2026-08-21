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
        ads_quality = _all(
            cur,
            """
            SELECT account_id, first_date, latest_date, days_seen, healthy_days,
                   issue_days, latest_ingested_at, quality_state
            FROM mart.ads_ingestion_quality_summary
            WHERE marketplace_id=%s
            ORDER BY account_id
            """,
            (marketplace,),
        )
        ads_issue_breakdown = _all(
            cur,
            """
            SELECT quality_state, count(*)::int AS days
            FROM mart.ads_ingestion_quality
            WHERE marketplace_id=%s AND quality_state <> 'OK'
            GROUP BY quality_state
            ORDER BY days DESC, quality_state
            """,
            (marketplace,),
        )
        ads_summary = {
            "accounts": len(ads_quality),
            "healthy_accounts": sum(1 for row in ads_quality if row.get("quality_state") == "HEALTHY"),
            "attention_accounts": sum(1 for row in ads_quality if row.get("quality_state") == "ATTENTION"),
            "issue_days": sum(int(row.get("issue_days") or 0) for row in ads_quality),
            "state": (
                "AWAITING_DATA" if not ads_quality
                else "ATTENTION" if any(row.get("quality_state") == "ATTENTION" for row in ads_quality)
                else "HEALTHY"
            ),
        }
        local_clock = _one(
            cur,
            "SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'America/Mexico_City','HH24:MI') local_time",
        )
    return {
        "summary": summary,
        "warehouse": warehouse,
        "ads": {
            "summary": ads_summary,
            "accounts": ads_quality,
            "issues": ads_issue_breakdown,
            "contract": {
                "account_campaign": "Account rollup must reconcile to campaign reporting at account/day grain.",
                "account_product": "Advertised-product spend and attributed sales must reconcile to account values.",
                "currency": "Fact currency must match the advertiser-account currency.",
                "tacos_denominator": "TACOS requires independently reconciled seller sales for the same marketplace/day.",
                "attribution": "Attributed sales are Amazon attribution, not incremental or exact organic sales.",
            },
        },
        "jobs": jobs,
        "local_time": local_clock.get("local_time"),
    }
