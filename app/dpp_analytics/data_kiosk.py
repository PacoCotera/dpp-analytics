from __future__ import annotations

import datetime as dt
import json
import logging
import os
import time
from decimal import Decimal
from typing import Any, Iterable
from zoneinfo import ZoneInfo

import httpx

from . import db
from .settings import settings
from .spapi import SpApiClient, SpApiError

SOURCE = "amazon_data_kiosk"
JOB = "sales_traffic_2024_04_24"
DATASET = "analytics_salesAndTraffic_2024_04_24"
log = logging.getLogger("dpp.data_kiosk")


def _payload_root(payload: dict[str, Any]) -> dict[str, Any]:
    wrapped = payload.get("payload")
    return wrapped if isinstance(wrapped, dict) else payload


def _date(value: str) -> dt.date:
    return dt.date.fromisoformat(value)


def _money(value: dict[str, Any] | None) -> Decimal | None:
    if not isinstance(value, dict) or value.get("amount") is None:
        return None
    return Decimal(str(value["amount"]))


def _query_dates() -> tuple[dt.date, dt.date]:
    local_today = dt.datetime.now(ZoneInfo("America/Mexico_City")).date()
    end = local_today - dt.timedelta(days=1)
    cursor = db.get_cursor(SOURCE, JOB, "last_complete_date")
    if cursor:
        # Re-query recent history because refunds and traffic can mature after the
        # first observation. Upserts make this inexpensive and idempotent.
        start = _date(cursor) - dt.timedelta(days=14)
    else:
        start = _date(os.getenv("DATA_KIOSK_BACKFILL_START", "2025-10-01"))
    return start, end


def _catalog_asins() -> list[str]:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT DISTINCT asin
            FROM core.sku
            WHERE marketplace_id=%s AND asin IS NOT NULL
            ORDER BY asin
            """,
            (settings.marketplace_id,),
        )
        return [row["asin"] for row in cur.fetchall()]


def _graphql_by_date(start: dt.date, end: dt.date) -> str:
    return (
        "{analytics_salesAndTraffic_2024_04_24{"
        f"salesAndTrafficByDate(startDate:\"{start.isoformat()}\" "
        f"endDate:\"{end.isoformat()}\" aggregateBy:DAY "
        f"marketplaceIds:[\"{settings.marketplace_id}\"]){{"
        "startDate endDate marketplaceId "
        "sales{orderedProductSales{amount currencyCode} unitsOrdered totalOrderItems unitsRefunded} "
        "traffic{sessions pageViews browserSessions browserPageViews unitSessionPercentage}"
        "}}}"
    )


def _graphql_trends(start: dt.date, end: dt.date, asins: list[str]) -> str:
    asin_values = ",".join(json.dumps(asin) for asin in asins)
    return (
        "{analytics_salesAndTraffic_2024_04_24{"
        f"salesAndTrafficTrends(startDate:\"{start.isoformat()}\" "
        f"endDate:\"{end.isoformat()}\" asinAggregation:CHILD dateAggregation:DAY "
        f"filters:[{{marketplaceId:\"{settings.marketplace_id}\" asins:[{asin_values}]}}]){{"
        "startDate endDate marketplaceId parentAsin childAsin "
        "sales{orderedProductSales{amount currencyCode} unitsOrdered totalOrderItems unitsRefunded} "
        "traffic{sessions pageViews browserSessions browserPageViews unitSessionPercentage sessionPercentage}"
        "}}}"
    )


def _extract_records(line: Any, field: str) -> list[dict[str, Any]]:
    if isinstance(line, dict):
        value = line.get(field)
        if isinstance(value, list):
            return [x for x in value if isinstance(x, dict)]

        dataset = line.get(DATASET)
        if isinstance(dataset, dict):
            value = dataset.get(field)
            if isinstance(value, list):
                return [x for x in value if isinstance(x, dict)]

        data = line.get("data")
        if isinstance(data, dict):
            return _extract_records(data, field)

        # Data Kiosk JSONL can also emit one result object per line.
        if line.get("marketplaceId") and line.get("startDate"):
            return [line]
    return []


def _download_document(url: str) -> list[Any]:
    # Never persist the query result document to disk. Amazon explicitly requires
    # encryption at rest; streaming/in-memory parsing avoids an unencrypted temp file.
    with httpx.Client(timeout=httpx.Timeout(120.0, connect=20.0)) as http:
        response = http.get(url)
        response.raise_for_status()
        records: list[Any] = []
        for raw_line in response.text.splitlines():
            raw_line = raw_line.strip()
            if raw_line:
                records.append(json.loads(raw_line))
        return records


def _wait_for_query(client: SpApiClient, query_id: str) -> dict[str, Any]:
    deadline = time.monotonic() + settings.data_kiosk_poll_timeout_seconds
    while True:
        status = _payload_root(client.get(f"/dataKiosk/2023-11-15/queries/{query_id}"))
        processing = status.get("processingStatus")
        if processing in {"DONE", "FATAL", "CANCELLED"}:
            return status
        if time.monotonic() >= deadline:
            raise TimeoutError(f"Data Kiosk query {query_id} did not finish within timeout")
        time.sleep(settings.data_kiosk_poll_seconds)


def _fetch_document(client: SpApiClient, document_id: str) -> list[Any]:
    document = _payload_root(
        client.get(f"/dataKiosk/2023-11-15/documents/{document_id}")
    )
    url = document.get("documentUrl")
    if not url:
        raise SpApiError(f"Data Kiosk document {document_id} did not return documentUrl")
    return _download_document(url)


def _run_query(client: SpApiClient, query: str) -> list[Any]:
    all_lines: list[Any] = []
    pagination_token: str | None = None

    while True:
        body: dict[str, Any] = {"query": query}
        if pagination_token:
            body["paginationToken"] = pagination_token

        created = _payload_root(
            client.post("/dataKiosk/2023-11-15/queries", json_body=body)
        )
        query_id = created.get("queryId")
        if not query_id:
            raise SpApiError(f"Data Kiosk createQuery returned no queryId: {created}")

        log.info("query_created id=%s pagination=%s", query_id, bool(pagination_token))
        status = _wait_for_query(client, str(query_id))
        processing = status.get("processingStatus")

        if processing == "FATAL":
            error_id = status.get("errorDocumentId")
            if error_id:
                error_lines = _fetch_document(client, error_id)
                raise SpApiError(f"Data Kiosk query fatal: {json.dumps(error_lines)[:1500]}")
            raise SpApiError(f"Data Kiosk query {query_id} failed with FATAL and no error document")
        if processing == "CANCELLED":
            raise SpApiError(f"Data Kiosk query {query_id} was cancelled")

        document_id = status.get("dataDocumentId")
        if document_id:
            all_lines.extend(_fetch_document(client, document_id))

        pagination_token = (status.get("pagination") or {}).get("nextToken")
        if not pagination_token:
            break

    return all_lines


def _save_by_date(lines: Iterable[Any], run_id: int) -> tuple[int, int]:
    read = 0
    written = 0
    with db.connect() as conn, conn.cursor() as cur:
        for line in lines:
            for record in _extract_records(line, "salesAndTrafficByDate"):
                read += 1
                sales = record.get("sales") or {}
                traffic = record.get("traffic") or {}
                cur.execute(
                    """
                    INSERT INTO core.sales_traffic_daily
                        (business_date, marketplace_id, ordered_product_sales, units_ordered,
                         total_order_items, sessions, page_views, unit_session_percentage, updated_at)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,now())
                    ON CONFLICT (business_date, marketplace_id) DO UPDATE SET
                        ordered_product_sales=EXCLUDED.ordered_product_sales,
                        units_ordered=EXCLUDED.units_ordered,
                        total_order_items=EXCLUDED.total_order_items,
                        sessions=EXCLUDED.sessions,
                        page_views=EXCLUDED.page_views,
                        unit_session_percentage=EXCLUDED.unit_session_percentage,
                        updated_at=now()
                    """,
                    (
                        record.get("startDate"),
                        record.get("marketplaceId") or settings.marketplace_id,
                        _money(sales.get("orderedProductSales")),
                        sales.get("unitsOrdered"),
                        sales.get("totalOrderItems"),
                        traffic.get("sessions"),
                        traffic.get("pageViews"),
                        traffic.get("unitSessionPercentage"),
                    ),
                )
                written += 1
        conn.commit()
    return read, written


def _save_trends(lines: Iterable[Any], run_id: int) -> tuple[int, int]:
    read = 0
    written = 0
    with db.connect() as conn, conn.cursor() as cur:
        for line in lines:
            for record in _extract_records(line, "salesAndTrafficTrends"):
                read += 1
                asin = record.get("childAsin")
                if not asin:
                    continue
                sales = record.get("sales") or {}
                traffic = record.get("traffic") or {}
                cur.execute(
                    """
                    INSERT INTO core.asin_sales_traffic_daily
                        (business_date, marketplace_id, asin, parent_asin,
                         ordered_product_sales, units_ordered, total_order_items, units_refunded,
                         sessions, page_views, browser_sessions, browser_page_views,
                         unit_session_percentage, session_percentage, updated_at)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())
                    ON CONFLICT (business_date, marketplace_id, asin) DO UPDATE SET
                        parent_asin=EXCLUDED.parent_asin,
                        ordered_product_sales=EXCLUDED.ordered_product_sales,
                        units_ordered=EXCLUDED.units_ordered,
                        total_order_items=EXCLUDED.total_order_items,
                        units_refunded=EXCLUDED.units_refunded,
                        sessions=EXCLUDED.sessions,
                        page_views=EXCLUDED.page_views,
                        browser_sessions=EXCLUDED.browser_sessions,
                        browser_page_views=EXCLUDED.browser_page_views,
                        unit_session_percentage=EXCLUDED.unit_session_percentage,
                        session_percentage=EXCLUDED.session_percentage,
                        updated_at=now()
                    """,
                    (
                        record.get("startDate"),
                        record.get("marketplaceId") or settings.marketplace_id,
                        asin,
                        record.get("parentAsin"),
                        _money(sales.get("orderedProductSales")),
                        sales.get("unitsOrdered"),
                        sales.get("totalOrderItems"),
                        sales.get("unitsRefunded"),
                        traffic.get("sessions"),
                        traffic.get("pageViews"),
                        traffic.get("browserSessions"),
                        traffic.get("browserPageViews"),
                        traffic.get("unitSessionPercentage"),
                        traffic.get("sessionPercentage"),
                    ),
                )
                written += 1
        conn.commit()
    return read, written


def ingest_sales_traffic(client: SpApiClient | None = None) -> dict[str, int]:
    start, end = _query_dates()
    if start > end:
        return {"records_read": 0, "records_written": 0}

    asins = _catalog_asins()
    own_client = client is None
    client = client or SpApiClient()
    totals = {"records_read": 0, "records_written": 0}

    try:
        with db.ingestion_run(
            SOURCE,
            JOB,
            {"start": start.isoformat(), "end": end.isoformat(), "asins": len(asins)},
        ) as run:
            by_date_lines = _run_query(client, _graphql_by_date(start, end))
            read, written = _save_by_date(by_date_lines, run["id"])
            totals["records_read"] += read
            totals["records_written"] += written
            run.update(totals)

            if asins:
                # One marketplace filter supports up to 30 child ASINs. DPP is below
                # that today; chunking keeps the collector correct as the catalog grows.
                for i in range(0, len(asins), 30):
                    chunk = asins[i : i + 30]
                    trend_lines = _run_query(client, _graphql_trends(start, end, chunk))
                    read, written = _save_trends(trend_lines, run["id"])
                    totals["records_read"] += read
                    totals["records_written"] += written
                    run.update(totals)

            db.set_cursor(SOURCE, JOB, end.isoformat(), "last_complete_date")

        return totals
    finally:
        if own_client:
            client.close()
