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
RETENTION_BASIS = "OWNED_CLICKED_ASIN_OR_OBSERVED_DPP_QUERY"


def report_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = _payload(payload).get("dataByDepartmentAndSearchTerm")
    # Amazon's Mexico-store report is roughly twelve million rows. Returning
    # the source list avoids allocating another list of twelve million object
    # references before relevance selection.
    return rows if isinstance(rows, list) else []


def _relevance_scope() -> tuple[set[str], set[str]]:
    """Return owned ASINs and normalized queries already observed for DPP."""
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT DISTINCT asin
            FROM mart.catalog_portfolio_product
            WHERE marketplace_id=%s
              AND catalog_membership='CURRENT_OFFER'
              AND product_role IN ('SELLABLE_VARIATION','SELLABLE_STANDALONE')
              AND NULLIF(btrim(asin),'') IS NOT NULL
            """,
            (settings.marketplace_id,),
        )
        owned_asins = {str(row["asin"]).strip() for row in cur.fetchall()}
        cur.execute(
            """
            SELECT search_query_key AS query_key
            FROM brand.search_query_performance
            WHERE marketplace_id=%s AND NULLIF(btrim(search_query_key),'') IS NOT NULL
            UNION
            SELECT search_term AS query_key
            FROM mart.ads_search_term_daily
            WHERE marketplace_id=%s AND NULLIF(btrim(search_term),'') IS NOT NULL
            """,
            (settings.marketplace_id, settings.marketplace_id),
        )
        tracked_queries = {
            normalize_query(row["query_key"])
            for row in cur.fetchall()
            if normalize_query(row["query_key"])
        }
    return owned_asins, tracked_queries


def select_relevant_rows(
    payload: dict[str, Any],
    start: date,
    end: date,
    owned_asins: set[str],
    tracked_queries: set[str],
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Validate the full source identity and retain its DPP decision slice."""
    rows = validate_report_payload(payload, start, end, check_duplicates=False)
    retained: list[dict[str, Any]] = []
    retained_keys: set[tuple[str, str, str]] = set()
    owned_clicked_rows = 0
    tracked_query_rows = 0
    for row in rows:
        department = str(row.get("departmentName") or "").strip()
        term = str(row.get("searchTerm") or "").strip()
        asin = str(row.get("clickedAsin") or "").strip()
        query_key = normalize_query(term)
        matches_owned = asin in owned_asins
        matches_query = query_key in tracked_queries
        if not (matches_owned or matches_query):
            continue
        key = (department, term, asin)
        if key in retained_keys:
            raise SpApiError(
                "Amazon Search Terms response duplicated its retained canonical grain"
            )
        retained_keys.add(key)
        selected = dict(row)
        selected["_matchesOwnedClickedAsin"] = matches_owned
        selected["_matchesTrackedQuery"] = matches_query
        retained.append(selected)
        owned_clicked_rows += int(matches_owned)
        tracked_query_rows += int(matches_query)
    return retained, {
        "source_rows": len(rows),
        "retained_rows": len(retained),
        "owned_clicked_rows": owned_clicked_rows,
        "tracked_query_rows": tracked_query_rows,
    }


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
    payload: dict[str, Any], start: date, end: date, *, check_duplicates: bool = True
) -> list[dict[str, Any]]:
    unwrapped = _payload(payload)
    specification = unwrapped.get("reportSpecification")
    if not isinstance(specification, dict):
        raise SpApiError("Amazon Search Terms response omitted its report specification")
    if specification.get("reportType") != REPORT_TYPE or specification.get(
        "marketplaceIds"
    ) != [settings.marketplace_id]:
        raise SpApiError("Amazon Search Terms response did not match its source contract")
    if not str(specification.get("dataStartTime") or "").startswith(
        start.isoformat()
    ) or not str(specification.get("dataEndTime") or "").startswith(end.isoformat()):
        raise SpApiError("Amazon Search Terms response did not match its requested period grain")
    options = specification.get("reportOptions") or {}
    if options.get("reportPeriod") != WEEKLY_REPORT_PERIOD:
        raise SpApiError("Amazon Search Terms response did not preserve its weekly grain")
    rows = report_rows(payload)
    seen: set[tuple[str, str, str]] = set()
    for row in rows:
        if not isinstance(row, dict):
            raise SpApiError("Amazon Search Terms response contained a non-object row")
        department = str(row.get("departmentName") or "").strip()
        term = str(row.get("searchTerm") or "").strip()
        asin = str(row.get("clickedAsin") or "").strip()
        if not department or not term or not asin:
            raise SpApiError("Amazon Search Terms response contained an incomplete identity")
        key = (department, term, asin)
        if check_duplicates and key in seen:
            raise SpApiError("Amazon Search Terms response duplicated its canonical grain")
        if check_duplicates:
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
        "matches_owned_clicked_asin", "matches_tracked_query",
    ]
    values = [
        settings.marketplace_id, WEEKLY_REPORT_PERIOD, start, end,
        str(row.get("departmentName") or "").strip(), term, normalize_query(term),
        _integer(row.get("searchFrequencyRank")),
        str(row.get("clickedAsin") or "").strip(),
        str(row.get("clickedItemName") or "").strip() or None,
        _integer(row.get("clickShareRank")), _decimal(row.get("clickShare")),
        _decimal(row.get("conversionShare")), raw_id, report_id,
        bool(row.get("_matchesOwnedClickedAsin")),
        bool(row.get("_matchesTrackedQuery")),
    ]
    return columns, values


def _persist_report(
    payload: dict[str, Any], document_meta: dict[str, Any], report_id: str,
    document_id: str, start: date, end: date, run_id: int,
) -> dict[str, int]:
    owned_asins, tracked_queries = _relevance_scope()
    rows, selection = select_relevant_rows(
        payload, start, end, owned_asins, tracked_queries
    )
    retained_report = dict(_payload(payload))
    retained_report["dataByDepartmentAndSearchTerm"] = rows
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
                    "retention_contract": {
                        "basis": RETENTION_BASIS,
                        **selection,
                        "current_owned_asin_count": len(owned_asins),
                        "tracked_query_count": len(tracked_queries),
                    },
                    "report": retained_report,
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
        cur.execute(
            """
            INSERT INTO brand.amazon_search_term_report(
                marketplace_id,report_period,start_date,end_date,
                source_report_id,source_document_id,source_row_count,
                retained_row_count,owned_clicked_row_count,tracked_query_row_count,
                current_owned_asin_count,tracked_query_count,retention_basis,
                source_content_sha256,source_uncompressed_bytes,
                source_compressed_bytes,source_payload_id
            ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (marketplace_id,report_period,start_date,end_date)
            DO UPDATE SET
                source_report_id=EXCLUDED.source_report_id,
                source_document_id=EXCLUDED.source_document_id,
                source_row_count=EXCLUDED.source_row_count,
                retained_row_count=EXCLUDED.retained_row_count,
                owned_clicked_row_count=EXCLUDED.owned_clicked_row_count,
                tracked_query_row_count=EXCLUDED.tracked_query_row_count,
                current_owned_asin_count=EXCLUDED.current_owned_asin_count,
                tracked_query_count=EXCLUDED.tracked_query_count,
                retention_basis=EXCLUDED.retention_basis,
                source_content_sha256=EXCLUDED.source_content_sha256,
                source_uncompressed_bytes=EXCLUDED.source_uncompressed_bytes,
                source_compressed_bytes=EXCLUDED.source_compressed_bytes,
                source_payload_id=EXCLUDED.source_payload_id,
                fetched_at=now()
            """,
            (
                settings.marketplace_id, WEEKLY_REPORT_PERIOD, start, end,
                report_id, document_id, selection["source_rows"],
                selection["retained_rows"], selection["owned_clicked_rows"],
                selection["tracked_query_rows"], len(owned_asins),
                len(tracked_queries), RETENTION_BASIS,
                document_meta.get("content_sha256"),
                document_meta.get("uncompressed_bytes"),
                document_meta.get("compressed_bytes"), raw_id,
            ),
        )
        conn.commit()
    return selection


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
            selection = _persist_report(
                payload, document_meta, report_id, str(document_id), start, end, int(run["id"])
            )
            run["records_read"] = selection["source_rows"]
            run["records_written"] = selection["retained_rows"]
        db.set_cursor(SOURCE, JOB, end.isoformat(), f"{CURSOR_PREFIX}{start.isoformat()}")
        return {
            "status": "success",
            "report_period": WEEKLY_REPORT_PERIOD,
            "period": start.isoformat(),
            "period_start": start.isoformat(),
            "period_end": end.isoformat(),
            "records_read": run["records_read"],
            "records_written": run["records_written"],
            "retention_basis": RETENTION_BASIS,
            "source_rows": selection["source_rows"],
            "retained_rows": selection["retained_rows"],
            "owned_clicked_rows": selection["owned_clicked_rows"],
            "tracked_query_rows": selection["tracked_query_rows"],
            "backfill_complete": search_terms_backfill_complete(today),
        }
    finally:
        if own_client and client is not None:
            client.close()
        lock_conn.close()
