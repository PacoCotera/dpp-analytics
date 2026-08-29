from __future__ import annotations

import os

from catalog_onboarding import catalog_onboarding_snapshot
from health_contract import build_health_contract


def _one(cur, sql: str, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _all(cur, sql: str, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def _seconds(name: str, default: int) -> int:
    return max(1, int(os.getenv(name, str(default))))


JOB_DEFINITIONS = {
    ("amazon_spapi", "orders_v2026"): {
        "label": "Orders",
        "operation": "Amazon SP-API · Orders v2026-01-01",
        "purpose": "Powers Today sales, recent orders and fulfillment status.",
        "domain": "Today",
        "interval_seconds": lambda: _seconds("ORDERS_INTERVAL_SECONDS", 180),
        "grace_seconds": 420,
    },
    ("amazon_spapi", "fba_inventory_v1"): {
        "label": "FBA inventory",
        "operation": "Amazon SP-API · FBA Inventory v1",
        "purpose": "Powers stock position, cover and replenishment decisions.",
        "domain": "Inventory",
        "interval_seconds": lambda: _seconds("INVENTORY_INTERVAL_SECONDS", 1800),
        "grace_seconds": 1800,
    },
    ("amazon_spapi", "finances_v2024"): {
        "label": "Finance transactions",
        "operation": "Amazon SP-API · Finances v2024-06-19",
        "purpose": "Powers Amazon postings and open-period contribution.",
        "domain": "Finance",
        "interval_seconds": lambda: _seconds("FINANCES_INTERVAL_SECONDS", 14400),
        "grace_seconds": 7200,
    },
    ("amazon_reports", "settlement_reports_v2"): {
        "label": "Settlement reports",
        "operation": "Amazon SP-API · Reports settlement feed",
        "purpose": "Provides payout and settlement detail for Finance.",
        "domain": "Finance",
        "interval_seconds": lambda: _seconds("SETTLEMENT_REPORTS_INTERVAL_SECONDS", 21600),
        "grace_seconds": 21600,
    },
    ("amazon_data_kiosk", "sales_traffic_2024_04_24"): {
        "label": "Sales & Traffic",
        "operation": "Amazon Data Kiosk · Sales and Traffic",
        "purpose": "Powers historical sales, traffic, conversion and product contribution.",
        "domain": "Sales",
        "interval_seconds": lambda: _seconds("DATA_KIOSK_INTERVAL_SECONDS", 43200),
        "grace_seconds": 21600,
    },
    ("amazon_reports", "merchant_listings_all_data"): {
        "label": "Seller listings",
        "operation": "Amazon SP-API · Merchant Listings report",
        "purpose": "Provides seller SKU identity, offer state, titles and listing images.",
        "domain": "Products",
        "interval_seconds": lambda: _seconds("LISTINGS_REPORT_INTERVAL_SECONDS", 21600),
        "grace_seconds": 21600,
    },
    ("amazon_spapi", "catalog_items_2022_04_01"): {
        "label": "Catalog enrichment",
        "operation": "Amazon SP-API · Catalog Items 2022-04-01",
        "purpose": "Enriches product identity, variation structure and marketplace media.",
        "domain": "Products",
        "interval_seconds": lambda: _seconds("CATALOG_INTERVAL_SECONDS", 86400),
        "grace_seconds": 86400,
    },
    ("amazon_spapi", "orders_geography_state_v2026"): {
        "label": "Order geography",
        "operation": "Amazon SP-API · Orders geography backfill",
        "purpose": "Enriches historical orders for Sales geography decisions.",
        "domain": "Sales",
        "interval_seconds": lambda: 86400,
        "grace_seconds": 86400,
    },
    ("dpp_finance", "month_close"): {
        "label": "Finance month close",
        "operation": "DPP accounting · close-state evaluator",
        "purpose": "Evaluates whether historical Finance periods are ready to close.",
        "domain": "Finance",
        "interval_seconds": lambda: 3600,
        "grace_seconds": 3600,
    },
    ("amazon_ads", "sponsored_products_reporting_v3"): {
        "label": "Sponsored Products",
        "operation": "Amazon Ads · Reporting v3",
        "purpose": "Powers paid-media efficiency and attributed advertising decisions.",
        "domain": "Ads",
        "interval_seconds": lambda: _seconds("AMAZON_ADS_REPORTING_INTERVAL_SECONDS", 21600),
        "grace_seconds": 21600,
    },
}


def _decorate_job(row: dict) -> dict:
    definition = JOB_DEFINITIONS.get((row.get("source"), row.get("job_name")), {})
    interval_factory = definition.get("interval_seconds", lambda: 86400)
    interval_seconds = int(interval_factory())
    stale_after_seconds = interval_seconds + int(definition.get("grace_seconds", interval_seconds))
    age_seconds = max(0, int(row.get("age_seconds") or 0))
    latest_status = row.get("latest_status") or "unknown"
    return {
        **row,
        "label": definition.get("label")
        or (row.get("job_name") or "Unknown stream").replace("_", " ").title(),
        "operation": definition.get("operation") or row.get("source") or "Unknown source",
        "purpose": definition.get("purpose")
        or "Supports the operating warehouse and its dependent dashboards.",
        "domain": definition.get("domain") or "Warehouse",
        "expected_interval_seconds": interval_seconds,
        "stale_after_seconds": stale_after_seconds,
        "next_due_in_seconds": max(0, interval_seconds - age_seconds),
        "overdue_by_seconds": max(0, age_seconds - interval_seconds),
        "stale_by_seconds": max(0, age_seconds - stale_after_seconds),
        "is_stale": age_seconds > stale_after_seconds,
        "waiting_for": (
            "current run to finish"
            if latest_status == "running"
            else "a successful retry"
            if latest_status in ("error", "interrupted")
            else "the next scheduled collection"
        ),
    }


def load_health_jobs(cur) -> list[dict]:
    return [
        _decorate_job(row)
        for row in _all(
            cur,
            """
            WITH latest AS (
                SELECT DISTINCT ON (source, job_name)
                    source, job_name, started_at, finished_at, status,
                    records_read, records_written, error_message
                FROM ops.ingestion_runs
                ORDER BY source, job_name, started_at DESC
            ), last_success AS (
                SELECT DISTINCT ON (source, job_name)
                    source, job_name, finished_at AS last_success_at,
                    records_read AS success_records_read,
                    records_written AS success_records_written
                FROM ops.ingestion_runs
                WHERE status='success' AND finished_at IS NOT NULL
                ORDER BY source, job_name, finished_at DESC
            ), last_error AS (
                SELECT DISTINCT ON (source, job_name)
                    source, job_name, started_at AS last_error_at,
                    error_message AS last_error_message
                FROM ops.ingestion_runs
                WHERE status='error'
                ORDER BY source, job_name, started_at DESC
            )
            SELECT
                l.source,
                l.job_name,
                CASE
                    WHEN l.status='interrupted' AND s.last_success_at IS NOT NULL THEN 'success'
                    ELSE l.status
                END AS latest_status,
                l.status AS latest_attempt_status,
                l.started_at AS last_started_at,
                l.finished_at AS last_finished_at,
                s.last_success_at,
                extract(epoch from (CURRENT_TIMESTAMP - COALESCE(s.last_success_at, l.finished_at, l.started_at)))::bigint AS age_seconds,
                extract(epoch from (CURRENT_TIMESTAMP - l.started_at))::bigint AS attempt_age_seconds,
                l.records_read,
                l.records_written,
                s.success_records_read,
                s.success_records_written,
                l.error_message,
                e.last_error_at,
                e.last_error_message
            FROM latest l
            LEFT JOIN last_success s USING (source, job_name)
            LEFT JOIN last_error e USING (source, job_name)
            ORDER BY
                CASE l.status WHEN 'error' THEN 0 WHEN 'running' THEN 1 ELSE 2 END,
                age_seconds DESC,
                l.source,
                l.job_name
            """,
        )
    ]


def load_ads_quality(cur, marketplace: str) -> list[dict]:
    return _all(
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


def ads_health_summary(ads_quality: list[dict]) -> dict:
    return {
        "accounts": len(ads_quality),
        "healthy_accounts": sum(
            1 for row in ads_quality if row.get("quality_state") == "HEALTHY"
        ),
        "attention_accounts": sum(
            1 for row in ads_quality if row.get("quality_state") == "ATTENTION"
        ),
        "issue_days": sum(int(row.get("issue_days") or 0) for row in ads_quality),
        "state": (
            "AWAITING_DATA"
            if not ads_quality
            else "ATTENTION"
            if any(row.get("quality_state") == "ATTENTION" for row in ads_quality)
            else "HEALTHY"
        ),
    }


def health_board_payload(connect, marketplace: str) -> dict:
    with connect() as conn, conn.cursor() as cur:
        jobs = load_health_jobs(cur)
        summary = {
            "jobs": len(jobs),
            "healthy": sum(
                1
                for row in jobs
                if row.get("latest_status") in ("success", "running")
                and not row.get("is_stale")
            ),
            "errors": sum(1 for row in jobs if row.get("latest_attempt_status") == "error"),
            "stale": sum(1 for row in jobs if row.get("is_stale")),
        }
        warehouse = _one(
            cur,
            """
            SELECT
              (SELECT count(*) FROM core.amazon_order WHERE marketplace_id=%s)::int AS orders,
              (SELECT count(*) FROM core.financial_transaction WHERE marketplace_id=%s)::int AS financial_transactions,
              (SELECT count(*) FROM core.seller_listing WHERE marketplace_id=%s AND is_current_listing)::int AS seller_listings,
              (SELECT count(*) FROM core.seller_listing WHERE marketplace_id=%s AND NOT is_current_listing)::int AS deleted_seller_listing_records,
              (SELECT count(*) FROM core.inventory_snapshot WHERE marketplace_id=%s)::int AS inventory_snapshots,
              (SELECT max(business_date) FROM core.sales_traffic_daily WHERE marketplace_id=%s) AS sales_traffic_last_date,
              (SELECT max(posted_date) FROM core.financial_transaction WHERE marketplace_id=%s) AS finance_last_posted,
              (SELECT max(fetched_at) FROM core.seller_listing WHERE marketplace_id=%s AND is_current_listing) AS listings_last_updated
            """,
            (marketplace, marketplace, marketplace, marketplace, marketplace, marketplace, marketplace, marketplace),
        )
        ads_quality = load_ads_quality(cur, marketplace)
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
        ads_summary = ads_health_summary(ads_quality)
        local_clock = _one(
            cur,
            """
            SELECT CURRENT_TIMESTAMP AS checked_at,
                   to_char(CURRENT_TIMESTAMP AT TIME ZONE 'America/Mexico_City','HH24:MI') AS local_time
            """,
        )

    catalog = catalog_onboarding_snapshot(connect, marketplace)
    summary["catalog_onboarding"] = catalog["summary"]["onboarding"]
    summary["catalog_attention"] = (
        catalog["summary"]["source_attention"] + catalog["summary"]["taxonomy_attention"]
    )
    health_contract = build_health_contract(jobs, catalog["summary"], ads_summary)

    return {
        "summary": summary,
        "health_contract": health_contract,
        "warehouse": warehouse,
        "catalog": {
            **catalog,
            "contract": {
                "discovery": "The latest complete Seller Listings snapshot is authoritative for current seller SKUs; records absent from it are retained only as deleted history. Catalog Items owns enrichment and current parent-child relationships.",
                "grace": "New/partial offers have a 48-hour onboarding grace. Catalog is retried every 30 minutes while an ASIN is known but source enrichment is unresolved.",
                "source_attention": "After 48 hours, missing ASIN or unresolved Catalog data is a source-completeness exception.",
                "taxonomy_attention": "Seller taxonomy becomes actionable only after source enrichment is ready and the onboarding grace has elapsed.",
            },
        },
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
        "checked_at": local_clock.get("checked_at"),
    }
