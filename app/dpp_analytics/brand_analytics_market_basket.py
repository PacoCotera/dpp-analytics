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
)
from .settings import settings
from .spapi import SpApiClient, SpApiError

JOB = "market_basket_weekly"
REPORT_TYPE = "GET_BRAND_ANALYTICS_MARKET_BASKET_REPORT"
CURSOR_PREFIX = "week:"


def report_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = _payload(payload).get("dataByAsin")
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def _periods(today: date | None = None) -> list[tuple[date, date]]:
    try:
        earliest = date.fromisoformat(
            settings.brand_analytics_market_basket_weekly_backfill_start
        )
    except ValueError as exc:
        raise ValueError(
            "BRAND_ANALYTICS_MARKET_BASKET_WEEKLY_BACKFILL_START must be YYYY-MM-DD"
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
        raise RuntimeError("No completed weekly Market Basket period is in scope")
    completed = _completed_periods()
    for start, end in periods:
        if start.isoformat() not in completed:
            return start, end, True
    start, end = periods[0]
    return start, end, False


def market_basket_backfill_complete(today: date | None = None) -> bool:
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
        raise SpApiError("Market Basket response omitted its report specification")
    if specification.get("reportType") != REPORT_TYPE or specification.get(
        "marketplaceIds"
    ) != [settings.marketplace_id]:
        raise SpApiError("Market Basket response did not match its source contract")
    if (
        not str(specification.get("dataStartTime") or "").startswith(start.isoformat())
        or not str(specification.get("dataEndTime") or "").startswith(end.isoformat())
    ):
        raise SpApiError("Market Basket response did not match its requested period grain")
    options = specification.get("reportOptions") or {}
    if options.get("reportPeriod") != WEEKLY_REPORT_PERIOD:
        raise SpApiError("Market Basket response did not preserve its weekly grain")

    rows = report_rows(payload)
    seen: set[tuple[str, str]] = set()
    for row in rows:
        asin = str(row.get("asin") or "").strip()
        companion = str(row.get("purchasedWithAsin") or "").strip()
        rank = _integer(row.get("purchasedWithRank"))
        ratio = _decimal(row.get("combinationPct"))
        if (
            not asin
            or not companion
            or row.get("startDate") != start.isoformat()
            or row.get("endDate") != end.isoformat()
            or rank is None
            or rank <= 0
            or ratio is None
            or not ratio.is_finite()
            or ratio < 0
            or ratio > 1
        ):
            raise SpApiError("Market Basket response contained an invalid canonical row")
        key = (asin, companion)
        if key in seen:
            raise SpApiError("Market Basket response duplicated its canonical pair grain")
        seen.add(key)
    return rows


def _row_values(
    row: dict[str, Any], raw_id: int, report_id: str
) -> tuple[list[str], list[Any]]:
    columns = [
        "marketplace_id",
        "report_period",
        "start_date",
        "end_date",
        "asin",
        "purchased_with_asin",
        "purchased_with_rank",
        "combination_ratio",
        "source_payload_id",
        "source_report_id",
    ]
    values = [
        settings.marketplace_id,
        WEEKLY_REPORT_PERIOD,
        row.get("startDate"),
        row.get("endDate"),
        str(row.get("asin") or "").strip(),
        str(row.get("purchasedWithAsin") or "").strip(),
        _integer(row.get("purchasedWithRank")),
        _decimal(row.get("combinationPct")),
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
            DELETE FROM brand.market_basket_affinity
            WHERE marketplace_id=%s AND report_period=%s
              AND start_date=%s AND end_date=%s
            """,
            (settings.marketplace_id, WEEKLY_REPORT_PERIOD, start, end),
        )
        for row in rows:
            columns, values = _row_values(row, raw_id, report_id)
            cur.execute(
                f"""
                INSERT INTO brand.market_basket_affinity({','.join(columns)})
                VALUES ({','.join(['%s'] * len(values))})
                ON CONFLICT (
                    marketplace_id,report_period,start_date,end_date,
                    asin,purchased_with_asin
                ) DO UPDATE SET
                    purchased_with_rank=EXCLUDED.purchased_with_rank,
                    combination_ratio=EXCLUDED.combination_ratio,
                    source_payload_id=EXCLUDED.source_payload_id,
                    source_report_id=EXCLUDED.source_report_id,
                    fetched_at=now()
                """,
                values,
            )
        conn.commit()
    return len(rows)


def ingest_market_basket(
    client: SpApiClient | None = None, *, today: date | None = None
) -> dict[str, Any]:
    """Pull one exact completed week of co-purchase affinity evidence."""
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
            "backfill_complete": market_basket_backfill_complete(today),
        }
    finally:
        if own_client and client is not None:
            client.close()
        lock_conn.close()
