from __future__ import annotations

import json
from datetime import date
from typing import Any

from . import db
from .brand_analytics_search_query import (
    SOURCE,
    WEEKLY_REPORT_PERIOD,
    _acquire_collector_lock,
    _current_offer_asins,
    _decimal,
    _download_report,
    _integer,
    _local_today,
    _money,
    _payload,
    _wait_for_report,
    chunk_asins,
    completed_week_periods,
)
from .settings import settings
from .spapi import SpApiClient, SpApiError

JOB = "search_catalog_performance_weekly"
REPORT_TYPE = "GET_BRAND_ANALYTICS_SEARCH_CATALOG_PERFORMANCE_REPORT"
CURSOR_PREFIX = "week:"


def report_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = _payload(payload).get("dataByAsin")
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def validate_report_rows(
    rows: list[dict[str, Any]], requested_asins: list[str], start: date, end: date
) -> None:
    requested = set(requested_asins)
    seen: set[str] = set()
    for row in rows:
        asin = str(row.get("asin") or "").strip()
        if not asin or row.get("startDate") != start.isoformat() or row.get(
            "endDate"
        ) != end.isoformat():
            raise SpApiError("Search Catalog response did not match its requested period grain")
        if asin not in requested:
            raise SpApiError("Search Catalog response included an unrequested ASIN")
        if asin in seen:
            raise SpApiError("Search Catalog response duplicated its canonical ASIN grain")
        seen.add(asin)


def _periods(today: date | None = None) -> list[tuple[date, date]]:
    try:
        earliest = date.fromisoformat(
            settings.brand_analytics_search_catalog_weekly_backfill_start
        )
    except ValueError as exc:
        raise ValueError(
            "BRAND_ANALYTICS_SEARCH_CATALOG_WEEKLY_BACKFILL_START must be YYYY-MM-DD"
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
        raise RuntimeError("No completed weekly Search Catalog period is in scope")
    completed = _completed_periods()
    for start, end in periods:
        if start.isoformat() not in completed:
            return start, end, True
    start, end = periods[0]
    return start, end, False


def search_catalog_backfill_complete(today: date | None = None) -> bool:
    periods = _periods(today)
    completed = _completed_periods()
    return bool(periods) and all(start.isoformat() in completed for start, _ in periods)


def _create_report(
    client: SpApiClient, asins: list[str], start: date, end: date
) -> str:
    created = _payload(
        client.post(
            "/reports/2021-06-30/reports",
            json_body={
                "reportType": REPORT_TYPE,
                "dataStartTime": start.isoformat(),
                "dataEndTime": end.isoformat(),
                "marketplaceIds": [settings.marketplace_id],
                "reportOptions": {
                    "reportPeriod": WEEKLY_REPORT_PERIOD,
                    "asins": " ".join(asins),
                },
            },
        )
    )
    report_id = created.get("reportId")
    if not report_id:
        raise SpApiError(f"Reports API returned no reportId: {created}")
    return str(report_id)


def _row_values(
    row: dict[str, Any], raw_id: int, report_id: str
) -> tuple[list[str], list[Any]] | None:
    asin = str(row.get("asin") or "").strip()
    if not asin or not row.get("startDate") or not row.get("endDate"):
        return None
    impression = row.get("impressionData") or {}
    click = row.get("clickData") or {}
    cart = row.get("cartAddData") or {}
    purchase = row.get("purchaseData") or {}
    impression_price, impression_currency = _money(impression.get("impressionMedianPrice"))
    click_price, click_currency = _money(click.get("clickedMedianPrice"))
    cart_price, cart_currency = _money(cart.get("cartAddedMedianPrice"))
    purchase_price, purchase_currency = _money(purchase.get("purchaseMedianPrice"))
    search_sales, search_sales_currency = _money(purchase.get("searchTrafficSales"))
    columns = [
        "marketplace_id", "report_period", "start_date", "end_date", "asin",
        "impression_count", "impression_median_price", "impression_currency",
        "same_day_shipping_impression_count", "one_day_shipping_impression_count",
        "two_day_shipping_impression_count", "click_count", "click_rate",
        "clicked_median_price", "click_currency", "same_day_shipping_click_count",
        "one_day_shipping_click_count", "two_day_shipping_click_count",
        "cart_add_count", "cart_added_median_price", "cart_currency",
        "same_day_shipping_cart_add_count", "one_day_shipping_cart_add_count",
        "two_day_shipping_cart_add_count", "purchase_count", "conversion_rate",
        "purchase_median_price", "purchase_currency", "search_traffic_sales",
        "search_traffic_sales_currency", "same_day_shipping_purchase_count",
        "one_day_shipping_purchase_count", "two_day_shipping_purchase_count",
        "source_payload_id", "source_report_id",
    ]
    values = [
        settings.marketplace_id, WEEKLY_REPORT_PERIOD, row.get("startDate"),
        row.get("endDate"), asin, _integer(impression.get("impressionCount")),
        impression_price, impression_currency,
        _integer(impression.get("sameDayShippingImpressionCount")),
        _integer(impression.get("oneDayShippingImpressionCount")),
        _integer(impression.get("twoDayShippingImpressionCount")),
        _integer(click.get("clickCount")), _decimal(click.get("clickRate")),
        click_price, click_currency, _integer(click.get("sameDayShippingClickCount")),
        _integer(click.get("oneDayShippingClickCount")),
        _integer(click.get("twoDayShippingClickCount")),
        _integer(cart.get("cartAddCount")), cart_price, cart_currency,
        _integer(cart.get("sameDayShippingCartAddCount")),
        _integer(cart.get("oneDayShippingCartAddCount")),
        _integer(cart.get("twoDayShippingCartAddCount")),
        _integer(purchase.get("purchaseCount")), _decimal(purchase.get("conversionRate")),
        purchase_price, purchase_currency, search_sales, search_sales_currency,
        _integer(purchase.get("sameDayShippingPurchaseCount")),
        _integer(purchase.get("oneDayShippingPurchaseCount")),
        _integer(purchase.get("twoDayShippingPurchaseCount")), raw_id, report_id,
    ]
    return columns, values


def _persist_downloads(
    downloads: list[dict[str, Any]], start: date, end: date, run_id: int
) -> int:
    written = 0
    with db.connect() as conn, conn.cursor() as cur:
        for download in downloads:
            report_id = download["report_id"]
            requested_asins = download["asins"]
            payload = download["payload"]
            rows = report_rows(payload)
            validate_report_rows(rows, requested_asins, start, end)
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
                        "report_document_id": download["report_document_id"],
                        "report_type": REPORT_TYPE,
                        "report_period": WEEKLY_REPORT_PERIOD,
                        "start_date": start.isoformat(),
                        "end_date": end.isoformat(),
                        "requested_asins": requested_asins,
                        "document_meta": download["document_meta"],
                        "report": payload,
                    }),
                    run_id,
                ),
            )
            raw_id = cur.fetchone()["id"]
            cur.execute(
                """
                DELETE FROM brand.search_catalog_performance
                WHERE marketplace_id=%s AND report_period=%s
                  AND start_date=%s AND end_date=%s AND asin=ANY(%s::text[])
                """,
                (settings.marketplace_id, WEEKLY_REPORT_PERIOD, start, end, requested_asins),
            )
            for row in rows:
                mapped = _row_values(row, raw_id, report_id)
                if mapped is None:
                    raise SpApiError("Search Catalog response contained an incomplete canonical row")
                columns, values = mapped
                mutable = [column for column in columns if column not in {
                    "marketplace_id", "report_period", "start_date", "end_date", "asin"
                }]
                cur.execute(
                    f"""
                    INSERT INTO brand.search_catalog_performance({','.join(columns)})
                    VALUES ({','.join(['%s'] * len(values))})
                    ON CONFLICT (marketplace_id,report_period,start_date,end_date,asin)
                    DO UPDATE SET {','.join(f'{column}=EXCLUDED.{column}' for column in mutable)},
                                  fetched_at=now()
                    """,
                    values,
                )
                written += 1
        conn.commit()
    return written


def ingest_search_catalog_performance(
    client: SpApiClient | None = None, *, today: date | None = None
) -> dict[str, Any]:
    """Pull one exact completed Sunday-Saturday ASIN search-funnel period."""
    lock_conn = _acquire_collector_lock()
    if lock_conn is None:
        return {"status": "already_running", "records_read": 0, "records_written": 0}
    own_client = client is None
    try:
        start, end, backfill = next_period(today)
        asins = _current_offer_asins()
        if not asins:
            raise RuntimeError("No canonical current sellable ASIN is available for Brand Analytics")
        chunks = chunk_asins(asins)
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
                "asins": len(asins),
                "chunks": len(chunks),
                "backfill": backfill,
            },
        ) as run:
            downloads: list[dict[str, Any]] = []
            records_read = 0
            for chunk in chunks:
                report_id = _create_report(client, chunk, start, end)
                report = _wait_for_report(client, report_id)
                document_id = report.get("reportDocumentId")
                if not document_id:
                    raise SpApiError(f"Completed Brand Analytics report {report_id} has no reportDocumentId")
                payload, document_meta = _download_report(client, str(document_id))
                records_read += len(report_rows(payload))
                downloads.append({
                    "report_id": report_id,
                    "report_document_id": str(document_id),
                    "asins": chunk,
                    "payload": payload,
                    "document_meta": document_meta,
                })
            run["records_read"] = records_read
            run["records_written"] = _persist_downloads(downloads, start, end, int(run["id"]))
        db.set_cursor(SOURCE, JOB, end.isoformat(), f"{CURSOR_PREFIX}{start.isoformat()}")
        return {
            "status": "success",
            "report_period": WEEKLY_REPORT_PERIOD,
            "period": start.isoformat(),
            "period_start": start.isoformat(),
            "period_end": end.isoformat(),
            "asins_requested": len(asins),
            "report_chunks": len(chunks),
            "records_read": records_read,
            "records_written": run["records_written"],
            "backfill_complete": search_catalog_backfill_complete(today),
        }
    finally:
        if own_client and client is not None:
            client.close()
        lock_conn.close()
