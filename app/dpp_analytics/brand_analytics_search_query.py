from __future__ import annotations

import gzip
import json
import logging
import time
import unicodedata
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable
from zoneinfo import ZoneInfo

import httpx

from . import db
from .settings import settings
from .spapi import SpApiClient, SpApiError

SOURCE = "amazon_brand_analytics"
JOB = "search_query_performance"
WEEKLY_JOB = "search_query_performance_weekly"
REPORT_TYPE = "GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT"
REPORT_PERIOD = "MONTH"
WEEKLY_REPORT_PERIOD = "WEEK"
CURSOR_PREFIX = "month:"
WEEKLY_CURSOR_PREFIX = "week:"
COLLECTOR_LOCK_KEY = "dpp:brand-analytics:reports"
MAX_ASIN_OPTION_CHARACTERS = 200
BUSINESS_TIMEZONE = ZoneInfo("America/Mexico_City")
log = logging.getLogger("dpp.brand_analytics.search_query")


def _payload(value: dict[str, Any]) -> dict[str, Any]:
    nested = value.get("payload")
    return nested if isinstance(nested, dict) else value


def _integer(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _decimal(value: Any) -> Decimal | None:
    if value in (None, ""):
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None


def _money(value: Any) -> tuple[Decimal | None, str | None]:
    if not isinstance(value, dict):
        return None, None
    currency = str(value.get("currencyCode") or "").strip().upper() or None
    return _decimal(value.get("amount")), currency


def normalize_query(value: Any) -> str:
    """Build a stable join key without replacing Amazon's source query text."""
    text = unicodedata.normalize("NFKC", str(value or ""))
    return " ".join(text.split()).casefold()


def completed_month_periods(today: date, count: int) -> list[tuple[date, date]]:
    """Return completed calendar months newest first."""
    count = max(1, count)
    current_month = today.replace(day=1)
    end = current_month - timedelta(days=1)
    periods: list[tuple[date, date]] = []
    for _ in range(count):
        start = end.replace(day=1)
        periods.append((start, end))
        end = start - timedelta(days=1)
    return periods


def completed_week_periods(today: date, earliest: date) -> list[tuple[date, date]]:
    """Return complete Amazon Sunday-Saturday weeks newest first."""
    days_since_saturday = (today.weekday() - 5) % 7
    end = today - timedelta(days=days_since_saturday)
    if end >= today:
        end -= timedelta(days=7)
    periods: list[tuple[date, date]] = []
    while end >= earliest:
        periods.append((end - timedelta(days=6), end))
        end -= timedelta(days=7)
    return periods


def chunk_asins(asins: Iterable[str], limit: int = MAX_ASIN_OPTION_CHARACTERS) -> list[list[str]]:
    """Pack ASINs under Amazon's reportOptions.asin 200-character limit."""
    chunks: list[list[str]] = []
    current: list[str] = []
    current_length = 0
    for asin in sorted({str(value).strip() for value in asins if str(value).strip()}):
        if len(asin) > limit:
            raise ValueError(f"ASIN exceeds report option limit: {asin}")
        added = len(asin) + (1 if current else 0)
        if current and current_length + added > limit:
            chunks.append(current)
            current = []
            current_length = 0
            added = len(asin)
        current.append(asin)
        current_length += added
    if current:
        chunks.append(current)
    return chunks


def report_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = _payload(payload).get("dataByAsin")
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def _local_today() -> date:
    return datetime.now(BUSINESS_TIMEZONE).date()


def _current_offer_asins() -> list[str]:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT DISTINCT asin
            FROM mart.catalog_portfolio_product
            WHERE marketplace_id=%s
              AND catalog_membership='CURRENT_OFFER'
              AND product_role IN ('SELLABLE_VARIATION','SELLABLE_STANDALONE')
              AND NULLIF(btrim(asin),'') IS NOT NULL
            ORDER BY asin
            """,
            (settings.marketplace_id,),
        )
        return [str(row["asin"]) for row in cur.fetchall()]


def _completed_periods(job: str, cursor_prefix: str) -> set[str]:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT cursor_name
            FROM ops.ingestion_cursor
            WHERE source=%s AND job_name=%s AND cursor_name LIKE %s
            """,
            (SOURCE, job, f"{cursor_prefix}%"),
        )
        return {
            str(row["cursor_name"])[len(cursor_prefix) :]
            for row in cur.fetchall()
    }


def _completed_months() -> set[str]:
    return _completed_periods(JOB, CURSOR_PREFIX)


def _period_key(start: date) -> str:
    return start.strftime("%Y-%m")


def _weekly_period_key(start: date) -> str:
    return start.isoformat()


def _weekly_periods(today: date | None = None) -> list[tuple[date, date]]:
    try:
        earliest = date.fromisoformat(
            settings.brand_analytics_search_query_weekly_backfill_start
        )
    except ValueError as exc:
        raise ValueError(
            "BRAND_ANALYTICS_SEARCH_QUERY_WEEKLY_BACKFILL_START must be YYYY-MM-DD"
        ) from exc
    return completed_week_periods(today or _local_today(), earliest)


def next_weekly_period(today: date | None = None) -> tuple[date, date, bool]:
    periods = _weekly_periods(today)
    if not periods:
        raise RuntimeError("No completed weekly Search Query period is in scope")
    completed = _completed_periods(WEEKLY_JOB, WEEKLY_CURSOR_PREFIX)
    for start, end in periods:
        if _weekly_period_key(start) not in completed:
            return start, end, True
    start, end = periods[0]
    return start, end, False


def weekly_search_query_backfill_complete(today: date | None = None) -> bool:
    periods = _weekly_periods(today)
    completed = _completed_periods(WEEKLY_JOB, WEEKLY_CURSOR_PREFIX)
    return bool(periods) and all(
        _weekly_period_key(start) in completed for start, _ in periods
    )


def search_query_source_backfill_complete(today: date | None = None) -> bool:
    return search_query_backfill_complete(today) and weekly_search_query_backfill_complete(
        today
    )


def next_period(today: date | None = None) -> tuple[date, date, bool]:
    periods = completed_month_periods(
        today or _local_today(), settings.brand_analytics_search_query_backfill_months
    )
    completed = _completed_months()
    for start, end in periods:
        if _period_key(start) not in completed:
            return start, end, True
    start, end = periods[0]
    return start, end, False


def search_query_backfill_complete(today: date | None = None) -> bool:
    periods = completed_month_periods(
        today or _local_today(), settings.brand_analytics_search_query_backfill_months
    )
    completed = _completed_months()
    return all(_period_key(start) in completed for start, _ in periods)


def _create_report(
    client: SpApiClient, asins: list[str], start: date, end: date,
    report_period: str = REPORT_PERIOD,
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
                    "reportPeriod": report_period,
                    "asin": " ".join(asins),
                },
            },
        )
    )
    report_id = created.get("reportId")
    if not report_id:
        raise SpApiError(f"Reports API returned no reportId: {created}")
    return str(report_id)


def _wait_for_report(client: SpApiClient, report_id: str) -> dict[str, Any]:
    timeout_seconds = settings.brand_analytics_search_query_poll_timeout_seconds
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        report = _payload(client.get(f"/reports/2021-06-30/reports/{report_id}"))
        status = str(report.get("processingStatus") or "").upper()
        if status == "DONE":
            return report
        if status in {"CANCELLED", "FATAL"}:
            detail = ""
            document_id = report.get("reportDocumentId")
            if document_id:
                try:
                    failure_payload, _ = _download_report(client, str(document_id))
                    detail = str(failure_payload.get("errorDetails") or failure_payload)
                except Exception as exc:
                    detail = f"failure document unavailable: {exc}"
            suffix = f" detail={detail}" if detail else ""
            raise SpApiError(
                f"Brand Analytics report {report_id} ended with status={status}{suffix}"
            )
        time.sleep(settings.reports_poll_seconds)
    raise TimeoutError(
        f"Brand Analytics report {report_id} did not finish within "
        f"{timeout_seconds}s"
    )


def _download_report(
    client: SpApiClient, report_document_id: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    document = _payload(
        client.get(
            f"/reports/2021-06-30/documents/{report_document_id}",
            params={"enableContentEncodingUrlHeader": "true"},
        )
    )
    url = document.get("url")
    if not url:
        raise SpApiError("Brand Analytics report document returned no URL")
    with httpx.Client(
        timeout=httpx.Timeout(120.0, connect=20.0), follow_redirects=True
    ) as http:
        response = http.get(str(url))
        response.raise_for_status()
        raw = response.content
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    payload = json.loads(raw.decode("utf-8-sig"))
    if not isinstance(payload, dict):
        raise SpApiError("Brand Analytics report document is not a JSON object")
    return payload, {key: value for key, value in document.items() if key != "url"}


def _row_values(
    row: dict[str, Any], raw_id: int, report_id: str,
    report_period: str = REPORT_PERIOD,
) -> tuple[list[str], list[Any]] | None:
    asin = str(row.get("asin") or "").strip()
    search = row.get("searchQueryData") or {}
    query = str(search.get("searchQuery") or "").strip()
    if not asin or not query or not row.get("startDate") or not row.get("endDate"):
        return None

    impression = row.get("impressionData") or {}
    click = row.get("clickData") or {}
    cart = row.get("cartAddData") or {}
    purchase = row.get("purchaseData") or {}
    click_total_price, click_total_currency = _money(click.get("totalMedianClickPrice"))
    click_asin_price, click_asin_currency = _money(click.get("asinMedianClickPrice"))
    cart_total_price, cart_total_currency = _money(cart.get("totalMedianCartAddPrice"))
    cart_asin_price, cart_asin_currency = _money(cart.get("asinMedianCartAddPrice"))
    purchase_total_price, purchase_total_currency = _money(purchase.get("totalMedianPurchasePrice"))
    purchase_asin_price, purchase_asin_currency = _money(purchase.get("asinMedianPurchasePrice"))

    columns = [
        "marketplace_id", "report_period", "start_date", "end_date", "asin",
        "search_query", "search_query_key", "search_query_score", "search_query_volume",
        "total_query_impression_count", "asin_impression_count", "asin_impression_share",
        "total_click_count", "total_click_rate", "asin_click_count", "asin_click_share",
        "total_median_click_price", "asin_median_click_price", "click_total_currency",
        "click_asin_currency", "total_same_day_shipping_click_count",
        "total_one_day_shipping_click_count", "total_two_day_shipping_click_count",
        "total_cart_add_count", "total_cart_add_rate", "asin_cart_add_count",
        "asin_cart_add_share", "total_median_cart_add_price", "asin_median_cart_add_price",
        "cart_total_currency", "cart_asin_currency", "total_same_day_shipping_cart_add_count",
        "total_one_day_shipping_cart_add_count", "total_two_day_shipping_cart_add_count",
        "total_purchase_count", "total_purchase_rate", "asin_purchase_count",
        "asin_purchase_share", "total_median_purchase_price", "asin_median_purchase_price",
        "purchase_total_currency", "purchase_asin_currency",
        "total_same_day_shipping_purchase_count", "total_one_day_shipping_purchase_count",
        "total_two_day_shipping_purchase_count", "source_payload_id", "source_report_id",
    ]
    values = [
        settings.marketplace_id, report_period, row.get("startDate"), row.get("endDate"), asin,
        query, normalize_query(query), _integer(search.get("searchQueryScore")),
        _integer(search.get("searchQueryVolume")),
        _integer(impression.get("totalQueryImpressionCount")),
        _integer(impression.get("asinImpressionCount")),
        _decimal(impression.get("asinImpressionShare")),
        _integer(click.get("totalClickCount")), _decimal(click.get("totalClickRate")),
        _integer(click.get("asinClickCount")), _decimal(click.get("asinClickShare")),
        click_total_price, click_asin_price, click_total_currency, click_asin_currency,
        _integer(click.get("totalSameDayShippingClickCount")),
        _integer(click.get("totalOneDayShippingClickCount")),
        _integer(click.get("totalTwoDayShippingClickCount")),
        _integer(cart.get("totalCartAddCount")), _decimal(cart.get("totalCartAddRate")),
        _integer(cart.get("asinCartAddCount")), _decimal(cart.get("asinCartAddShare")),
        cart_total_price, cart_asin_price, cart_total_currency, cart_asin_currency,
        _integer(cart.get("totalSameDayShippingCartAddCount")),
        _integer(cart.get("totalOneDayShippingCartAddCount")),
        _integer(cart.get("totalTwoDayShippingCartAddCount")),
        _integer(purchase.get("totalPurchaseCount")),
        _decimal(purchase.get("totalPurchaseRate")),
        _integer(purchase.get("asinPurchaseCount")),
        _decimal(purchase.get("asinPurchaseShare")),
        purchase_total_price, purchase_asin_price, purchase_total_currency,
        purchase_asin_currency,
        _integer(purchase.get("totalSameDayShippingPurchaseCount")),
        _integer(purchase.get("totalOneDayShippingPurchaseCount")),
        _integer(purchase.get("totalTwoDayShippingPurchaseCount")), raw_id, report_id,
    ]
    return columns, values


def _persist_downloads(
    downloads: list[dict[str, Any]], start: date, end: date, run_id: int,
    report_period: str = REPORT_PERIOD,
) -> int:
    written = 0
    with db.connect() as conn, conn.cursor() as cur:
        for download in downloads:
            report_id = download["report_id"]
            requested_asins = download["asins"]
            payload = download["payload"]
            raw_payload = {
                "report_id": report_id,
                "report_document_id": download["report_document_id"],
                "report_type": REPORT_TYPE,
                "report_period": report_period,
                "start_date": start.isoformat(),
                "end_date": end.isoformat(),
                "requested_asins": requested_asins,
                "document_meta": download["document_meta"],
                "report": payload,
            }
            cur.execute(
                """
                INSERT INTO raw.api_payload(
                    source,resource_type,resource_id,marketplace_id,payload,ingestion_run_id
                ) VALUES (%s,%s,%s,%s,%s::jsonb,%s)
                RETURNING id
                """,
                (
                    SOURCE, REPORT_TYPE, report_id, settings.marketplace_id,
                    json.dumps(raw_payload), run_id,
                ),
            )
            raw_id = cur.fetchone()["id"]
            cur.execute(
                """
                DELETE FROM brand.search_query_performance
                WHERE marketplace_id=%s AND report_period=%s
                  AND start_date=%s AND end_date=%s AND asin=ANY(%s::text[])
                """,
                (
                    settings.marketplace_id, report_period, start, end, requested_asins,
                ),
            )
            for row in report_rows(payload):
                mapped = _row_values(row, raw_id, report_id, report_period)
                if mapped is None:
                    continue
                columns, values = mapped
                mutable = [
                    column for column in columns
                    if column not in {
                        "marketplace_id", "report_period", "start_date", "end_date",
                        "asin", "search_query",
                    }
                ]
                placeholders = ",".join(["%s"] * len(values))
                assignments = ",".join(
                    f"{column}=EXCLUDED.{column}" for column in mutable
                )
                cur.execute(
                    f"""
                    INSERT INTO brand.search_query_performance({','.join(columns)})
                    VALUES ({placeholders})
                    ON CONFLICT (
                        marketplace_id,report_period,start_date,end_date,asin,search_query
                    ) DO UPDATE SET {assignments}, fetched_at=now()
                    """,
                    values,
                )
                written += 1
        conn.commit()
    return written


def _acquire_collector_lock():
    conn = db.connect()
    with conn.cursor() as cur:
        cur.execute(
            "SELECT pg_try_advisory_lock(hashtext(%s)) AS acquired",
            (COLLECTOR_LOCK_KEY,),
        )
        acquired = bool((cur.fetchone() or {}).get("acquired"))
    if not acquired:
        conn.close()
        return None
    return conn


def ingest_search_query_performance(
    client: SpApiClient | None = None, *, today: date | None = None,
    report_period: str = REPORT_PERIOD,
) -> dict[str, Any]:
    """Pull one complete month or week. Missing history is newest first."""
    lock_conn = _acquire_collector_lock()
    if lock_conn is None:
        return {"status": "already_running", "records_read": 0, "records_written": 0}
    own_client = False
    try:
        if report_period == WEEKLY_REPORT_PERIOD:
            start, end, backfill = next_weekly_period(today)
            job = WEEKLY_JOB
            cursor_prefix = WEEKLY_CURSOR_PREFIX
            period_key = _weekly_period_key(start)
        elif report_period == REPORT_PERIOD:
            start, end, backfill = next_period(today)
            job = JOB
            cursor_prefix = CURSOR_PREFIX
            period_key = _period_key(start)
        else:
            raise ValueError(f"unsupported Search Query report period: {report_period}")
        asins = _current_offer_asins()
        if not asins:
            raise RuntimeError(
                "No canonical current sellable ASIN is available for Brand Analytics"
            )
        chunks = chunk_asins(asins)
        own_client = client is None
        client = client or SpApiClient()
        with db.ingestion_run(
            SOURCE,
            job,
            {
                "marketplace": settings.marketplace_id,
                "report_type": REPORT_TYPE,
                "report_period": report_period,
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
                report_id = _create_report(
                    client, chunk, start, end, report_period
                )
                report = _wait_for_report(client, report_id)
                document_id = report.get("reportDocumentId")
                if not document_id:
                    raise SpApiError(
                        f"Completed Brand Analytics report {report_id} has no reportDocumentId"
                    )
                payload, document_meta = _download_report(client, str(document_id))
                records_read += len(report_rows(payload))
                downloads.append(
                    {
                        "report_id": report_id,
                        "report_document_id": str(document_id),
                        "asins": chunk,
                        "payload": payload,
                        "document_meta": document_meta,
                    }
                )
            run["records_read"] = records_read
            run["records_written"] = _persist_downloads(
                downloads, start, end, int(run["id"]), report_period
            )

        db.set_cursor(
            SOURCE, job, end.isoformat(), f"{cursor_prefix}{period_key}"
        )
        complete = (
            weekly_search_query_backfill_complete(today)
            if report_period == WEEKLY_REPORT_PERIOD
            else search_query_backfill_complete(today)
        )
        return {
            "status": "success",
            "report_period": report_period,
            "period": period_key,
            "period_start": start.isoformat(),
            "period_end": end.isoformat(),
            "asins_requested": len(asins),
            "report_chunks": len(chunks),
            "records_read": records_read,
            "records_written": run["records_written"],
            "backfill_complete": complete,
        }
    finally:
        if own_client and client is not None:
            client.close()
        lock_conn.close()


def ingest_weekly_search_query_performance(
    client: SpApiClient | None = None, *, today: date | None = None
) -> dict[str, Any]:
    return ingest_search_query_performance(
        client, today=today, report_period=WEEKLY_REPORT_PERIOD
    )


def ingest_scheduled_search_query_performance() -> dict[str, Any]:
    """Backfill weekly evidence first, then continue the monthly contract."""
    if not weekly_search_query_backfill_complete():
        result = ingest_weekly_search_query_performance()
    else:
        result = ingest_search_query_performance()
    result["backfill_complete"] = search_query_source_backfill_complete()
    return result


def main() -> None:
    print(json.dumps(ingest_search_query_performance(), sort_keys=True, default=str))


if __name__ == "__main__":
    main()
