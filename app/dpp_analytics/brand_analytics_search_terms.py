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
    _payload,
    _wait_for_report,
    completed_week_periods,
    normalize_query,
)
from .settings import settings
from .spapi import SpApiClient, SpApiError

JOB = "search_terms_weekly"
REPORT_TYPE = "GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT"
CURSOR_PREFIX = "week:"


def report_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = _payload(payload).get("dataByDepartmentAndSearchTerm")
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def _periods(today: date | None = None) -> list[tuple[date, date]]:
    try:
        earliest = date.fromisoformat(
            settings.brand_analytics_search_terms_weekly_backfill_start
        )
    except ValueError as exc:
        raise ValueError(
            "BRAND_ANALYTICS_SEARCH_TERMS_WEEKLY_BACKFILL_START must be YYYY-MM-DD"
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
        raise RuntimeError("No completed weekly Amazon Search Terms period is in scope")
    completed = _completed_periods()
    for start, end in periods:
        if start.isoformat() not in completed:
            return start, end, True
    start, end = periods[0]
    return start, end, False


def search_terms_backfill_complete(today: date | None = None) -> bool:
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
        raise SpApiError("Amazon Search Terms response omitted its report specification")
    if not str(specification.get("dataStartTime") or "").startswith(start.isoformat()) or not str(
        specification.get("dataEndTime") or ""
    ).startswith(end.isoformat()):
        raise SpApiError("Amazon Search Terms response did not match its requested period grain")
    options = specification.get("reportOptions") or {}
    if options.get("reportPeriod") != WEEKLY_REPORT_PERIOD:
        raise SpApiError("Amazon Search Terms response did not preserve its weekly grain")
    rows = report_rows(payload)
    seen: set[tuple[str, str, str]] = set()
    for row in rows:
        department = str(row.get("departmentName") or "").strip()
        term = str(row.get("searchTerm") or "").strip()
        asin = str(row.get("clickedAsin") or "").strip()
        if not department or not term or not asin:
            raise SpApiError("Amazon Search Terms response contained an incomplete identity")
        key = (department, term, asin)
        if key in seen:
            raise SpApiError("Amazon Search Terms response duplicated its canonical grain")
        seen.add(key)
    return rows


def _row_values(
    row: dict[str, Any], start: date, end: date, raw_id: int, report_id: str
) -> tuple[list[str], list[Any]]:
    term = str(row.get("searchTerm") or "").strip()
    columns = [
        "marketplace_id", "report_period", "start_date", "end_date",
        "department_name", "search_term", "search_term_key", "search_frequency_rank",
        "clicked_asin", "clicked_item_name", "click_share_rank", "click_share",
        "conversion_share", "source_payload_id", "source_report_id",
    ]
    values = [
        settings.marketplace_id, WEEKLY_REPORT_PERIOD, start, end,
        str(row.get("departmentName") or "").strip(), term, normalize_query(term),
        _integer(row.get("searchFrequencyRank")),
        str(row.get("clickedAsin") or "").strip(),
        str(row.get("clickedItemName") or "").strip() or None,
        _integer(row.get("clickShareRank")), _decimal(row.get("clickShare")),
        _decimal(row.get("conversionShare")), raw_id, report_id,
    ]
    return columns, values


def _persist_report(
    payload: dict[str, Any], document_meta: dict[str, Any], report_id: str,
    document_id: str, start: date, end: date, run_id: int,
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
                SOURCE, REPORT_TYPE, report_id, settings.marketplace_id,
                json.dumps({
                    "report_id": report_id,
                    "report_document_id": document_id,
                    "report_type": REPORT_TYPE,
                    "report_period": WEEKLY_REPORT_PERIOD,
                    "start_date": start.isoformat(),
                    "end_date": end.isoformat(),
                    "document_meta": document_meta,
                    "report": payload,
                }),
                run_id,
            ),
        )
        raw_id = cur.fetchone()["id"]
        cur.execute(
            """
            DELETE FROM brand.amazon_search_term
            WHERE marketplace_id=%s AND report_period=%s AND start_date=%s AND end_date=%s
            """,
            (settings.marketplace_id, WEEKLY_REPORT_PERIOD, start, end),
        )
        for row in rows:
            columns, values = _row_values(row, start, end, raw_id, report_id)
            mutable = [column for column in columns if column not in {
                "marketplace_id", "report_period", "start_date", "end_date",
                "department_name", "search_term", "clicked_asin",
            }]
            cur.execute(
                f"""
                INSERT INTO brand.amazon_search_term({','.join(columns)})
                VALUES ({','.join(['%s'] * len(values))})
                ON CONFLICT (
                    marketplace_id,report_period,start_date,end_date,
                    department_name,search_term,clicked_asin
                ) DO UPDATE SET {','.join(f'{column}=EXCLUDED.{column}' for column in mutable)},
                                fetched_at=now()
                """,
                values,
            )
        conn.commit()
    return len(rows)


def ingest_search_terms(
    client: SpApiClient | None = None, *, today: date | None = None
) -> dict[str, Any]:
    """Pull one exact completed week of market-level Amazon Search Terms."""
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
                raise SpApiError(f"Completed Brand Analytics report {report_id} has no reportDocumentId")
            payload, document_meta = _download_report(client, str(document_id))
            run["records_read"] = len(report_rows(payload))
            run["records_written"] = _persist_report(
                payload, document_meta, report_id, str(document_id), start, end, int(run["id"])
            )
        db.set_cursor(SOURCE, JOB, end.isoformat(), f"{CURSOR_PREFIX}{start.isoformat()}")
        return {
            "status": "success",
            "report_period": WEEKLY_REPORT_PERIOD,
            "period": start.isoformat(),
            "period_start": start.isoformat(),
            "period_end": end.isoformat(),
            "records_read": run["records_read"],
            "records_written": run["records_written"],
            "backfill_complete": search_terms_backfill_complete(today),
        }
    finally:
        if own_client and client is not None:
            client.close()
        lock_conn.close()
