from __future__ import annotations

import json
from datetime import date
from typing import Any

from . import db
from .brand_analytics_search_query import (
    SOURCE,
    WEEKLY_REPORT_PERIOD,
    _acquire_collector_lock,
    _decimal,
    _download_report,
    _integer,
    _local_today,
    _money,
    _payload,
    _wait_for_report,
    completed_week_periods,
)
from .settings import settings
from .spapi import SpApiClient, SpApiError

JOB = "repeat_purchase_weekly"
REPORT_TYPE = "GET_BRAND_ANALYTICS_REPEAT_PURCHASE_REPORT"
CURSOR_PREFIX = "week:"
REVENUE_BASIS = "ORDERED_REVENUE_RETURNS_EXCLUDED"
TAX_BASIS = "SOURCE_UNSPECIFIED"


def report_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = _payload(payload).get("dataByAsin")
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def _periods(today: date | None = None) -> list[tuple[date, date]]:
    try:
        earliest = date.fromisoformat(
            settings.brand_analytics_repeat_purchase_weekly_backfill_start
        )
    except ValueError as exc:
        raise ValueError(
            "BRAND_ANALYTICS_REPEAT_PURCHASE_WEEKLY_BACKFILL_START must be YYYY-MM-DD"
        ) from exc
    return completed_week_periods(today or _local_today(), earliest)


def _completed_periods() -> set[str]:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT cursor_name
            FROM ops.ingestion_cursor
            WHERE source=%s AND job_name=%s AND cursor_name LIKE %s
            """,
            (SOURCE, JOB, f"{CURSOR_PREFIX}%"),
        )
        return {
            str(row["cursor_name"])[len(CURSOR_PREFIX) :]
            for row in cur.fetchall()
        }


def next_period(today: date | None = None) -> tuple[date, date, bool]:
    periods = _periods(today)
    if not periods:
        raise RuntimeError("No completed weekly Repeat Purchase period is in scope")
    completed = _completed_periods()
    for start, end in periods:
        if start.isoformat() not in completed:
            return start, end, True
    start, end = periods[0]
    return start, end, False


def repeat_purchase_backfill_complete(today: date | None = None) -> bool:
    periods = _periods(today)
    completed = _completed_periods()
    return bool(periods) and all(start.isoformat() in completed for start, _ in periods)


def _create_report(client: SpApiClient, start: date, end: date) -> str:
    created = _payload(
        client.post(
            "/reports/2021-06-30/reports",
            json_body={
                "reportType": REPORT_TYPE,
                "dataStartTime": start.isoformat(),
                "dataEndTime": end.isoformat(),
                "marketplaceIds": [settings.marketplace_id],
                "reportOptions": {"reportPeriod": WEEKLY_REPORT_PERIOD},
            },
        )
    )
    report_id = created.get("reportId")
    if not report_id:
        raise SpApiError(f"Reports API returned no reportId: {created}")
    return str(report_id)


def validate_report_payload(
    payload: dict[str, Any], start: date, end: date
) -> list[dict[str, Any]]:
    unwrapped = _payload(payload)
    specification = unwrapped.get("reportSpecification")
    if not isinstance(specification, dict):
        raise SpApiError("Repeat Purchase response omitted its report specification")
    if specification.get("reportType") != REPORT_TYPE or specification.get(
        "marketplaceIds"
    ) != [settings.marketplace_id]:
        raise SpApiError("Repeat Purchase response did not match its source contract")
    if (
        not str(specification.get("dataStartTime") or "").startswith(start.isoformat())
        or not str(specification.get("dataEndTime") or "").startswith(end.isoformat())
    ):
        raise SpApiError("Repeat Purchase response did not match its requested period grain")
    options = specification.get("reportOptions") or {}
    if options.get("reportPeriod") != WEEKLY_REPORT_PERIOD:
        raise SpApiError("Repeat Purchase response did not preserve its weekly grain")

    rows = report_rows(payload)
    seen: set[str] = set()
    for row in rows:
        asin = str(row.get("asin") or "").strip()
        orders = _integer(row.get("orders"))
        customers = _integer(row.get("uniqueCustomers"))
        repeat_ratio = _decimal(row.get("repeatCustomersPctTotal"))
        revenue, currency = _money(row.get("repeatPurchaseRevenue"))
        revenue_ratio = _decimal(row.get("repeatPurchaseRevenuePctTotal"))
        ratios = (repeat_ratio, revenue_ratio)
        if (
            not asin
            or row.get("startDate") != start.isoformat()
            or row.get("endDate") != end.isoformat()
            or orders is None
            or orders < 0
            or customers is None
            or customers < 0
            or revenue is None
            or not revenue.is_finite()
            or revenue < 0
            or currency is None
            or len(currency) != 3
            or not currency.isascii()
            or not currency.isalpha()
            or any(
                ratio is None
                or not ratio.is_finite()
                or ratio < 0
                or ratio > 1
                for ratio in ratios
            )
        ):
            raise SpApiError("Repeat Purchase response contained an invalid canonical row")
        if asin in seen:
            raise SpApiError("Repeat Purchase response duplicated its canonical ASIN grain")
        seen.add(asin)
    return rows


def _row_values(
    row: dict[str, Any], raw_id: int, report_id: str
) -> tuple[list[str], list[Any]]:
    revenue, currency = _money(row.get("repeatPurchaseRevenue"))
    columns = [
        "marketplace_id",
        "report_period",
        "start_date",
        "end_date",
        "asin",
        "orders",
        "unique_customers",
        "repeat_customer_ratio",
        "repeat_purchase_revenue",
        "repeat_purchase_revenue_currency",
        "repeat_purchase_revenue_ratio",
        "revenue_basis",
        "tax_basis",
        "source_payload_id",
        "source_report_id",
    ]
    values = [
        settings.marketplace_id,
        WEEKLY_REPORT_PERIOD,
        row.get("startDate"),
        row.get("endDate"),
        str(row.get("asin") or "").strip(),
        _integer(row.get("orders")),
        _integer(row.get("uniqueCustomers")),
        _decimal(row.get("repeatCustomersPctTotal")),
        revenue,
        currency,
        _decimal(row.get("repeatPurchaseRevenuePctTotal")),
        REVENUE_BASIS,
        TAX_BASIS,
        raw_id,
        report_id,
    ]
    return columns, values


def _persist_report(
    payload: dict[str, Any],
    document_meta: dict[str, Any],
    report_id: str,
    document_id: str,
    start: date,
    end: date,
    run_id: int,
) -> int:
    rows = validate_report_payload(payload, start, end)
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO raw.api_payload(
                source,resource_type,resource_id,marketplace_id,payload,ingestion_run_id
            ) VALUES (%s,%s,%s,%s,%s::jsonb,%s)
            RETURNING id
            """,
            (
                SOURCE,
                REPORT_TYPE,
                report_id,
                settings.marketplace_id,
                json.dumps(
                    {
                        "report_id": report_id,
                        "report_document_id": document_id,
                        "report_type": REPORT_TYPE,
                        "report_period": WEEKLY_REPORT_PERIOD,
                        "start_date": start.isoformat(),
                        "end_date": end.isoformat(),
                        "document_meta": document_meta,
                        "report": payload,
                    }
                ),
                run_id,
            ),
        )
        raw_id = cur.fetchone()["id"]
        cur.execute(
            """
            DELETE FROM brand.repeat_purchase_behavior
            WHERE marketplace_id=%s AND report_period=%s
              AND start_date=%s AND end_date=%s
            """,
            (settings.marketplace_id, WEEKLY_REPORT_PERIOD, start, end),
        )
        for row in rows:
            columns, values = _row_values(row, raw_id, report_id)
            mutable = [
                column
                for column in columns
                if column
                not in {
                    "marketplace_id",
                    "report_period",
                    "start_date",
                    "end_date",
                    "asin",
                }
            ]
            cur.execute(
                f"""
                INSERT INTO brand.repeat_purchase_behavior({','.join(columns)})
                VALUES ({','.join(['%s'] * len(values))})
                ON CONFLICT (marketplace_id,report_period,start_date,end_date,asin)
                DO UPDATE SET {','.join(f'{column}=EXCLUDED.{column}' for column in mutable)},
                              fetched_at=now()
                """,
                values,
            )
        conn.commit()
    return len(rows)


def ingest_repeat_purchase(
    client: SpApiClient | None = None, *, today: date | None = None
) -> dict[str, Any]:
    """Pull one exact completed week of repeat-purchase portfolio context."""
    lock_conn = _acquire_collector_lock()
    if lock_conn is None:
        return {"status": "already_running", "records_read": 0, "records_written": 0}
    own_client = client is None
    try:
        start, end, backfill = next_period(today)
        client = client or SpApiClient()
        with db.ingestion_run(
            SOURCE,
            JOB,
            {
                "marketplace": settings.marketplace_id,
                "report_type": REPORT_TYPE,
                "report_period": WEEKLY_REPORT_PERIOD,
                "start": start.isoformat(),
                "end": end.isoformat(),
                "backfill": backfill,
            },
        ) as run:
            report_id = _create_report(client, start, end)
            report = _wait_for_report(client, report_id)
            document_id = report.get("reportDocumentId")
            if not document_id:
                raise SpApiError(
                    f"Completed Brand Analytics report {report_id} has no reportDocumentId"
                )
            payload, document_meta = _download_report(client, str(document_id))
            run["records_read"] = len(report_rows(payload))
            run["records_written"] = _persist_report(
                payload,
                document_meta,
                report_id,
                str(document_id),
                start,
                end,
                int(run["id"]),
            )
        db.set_cursor(
            SOURCE,
            JOB,
            end.isoformat(),
            f"{CURSOR_PREFIX}{start.isoformat()}",
        )
        return {
            "status": "success",
            "report_period": WEEKLY_REPORT_PERIOD,
            "period": start.isoformat(),
            "period_start": start.isoformat(),
            "period_end": end.isoformat(),
            "records_read": run["records_read"],
            "records_written": run["records_written"],
            "backfill_complete": repeat_purchase_backfill_complete(today),
        }
    finally:
        if own_client and client is not None:
            client.close()
        lock_conn.close()
