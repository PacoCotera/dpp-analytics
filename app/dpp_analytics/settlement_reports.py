from __future__ import annotations

import csv
import io
import json
from datetime import datetime
from typing import Any

import httpx

from . import db
from .settings import settings
from .spapi import SpApiClient, SpApiError

SOURCE = "amazon_reports"
JOB = "settlement_reports_v2"
REPORT_TYPE = "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2"


def _payload(value: dict[str, Any]) -> dict[str, Any]:
    nested = value.get("payload")
    return nested if isinstance(nested, dict) else value


def _first(row: dict[str, str], *keys: str) -> str | None:
    lowered = {str(k).strip().lower(): v for k, v in row.items()}
    for key in keys:
        value = row.get(key)
        if value is None:
            value = lowered.get(key.lower())
        if value is not None and str(value).strip() != "":
            return str(value).strip()
    return None


def _money(value: str | None) -> float | None:
    if value is None or value.strip() == "":
        return None
    try:
        return float(value.replace(",", ""))
    except ValueError:
        return None


def _number(value: str | None) -> float | None:
    return _money(value)


def _ts(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S %Z", "%Y-%m-%d %H:%M:%S", "%m/%d/%Y %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            pass
    return None


def _download_document(client: SpApiClient, document_id: str) -> tuple[str, dict[str, Any]]:
    meta = _payload(client.get(f"/reports/2021-06-30/documents/{document_id}", params={"enableContentEncodingUrlHeader": "true"}))
    url = meta.get("url")
    if not url:
        raise SpApiError("Settlement report document URL missing")
    with httpx.Client(timeout=httpx.Timeout(90.0, connect=20.0), follow_redirects=True) as http:
        response = http.get(url)
        response.raise_for_status()
        return response.content.decode("utf-8-sig", errors="replace"), {k: v for k, v in meta.items() if k != "url"}


def _already_ingested(report_id: str) -> bool:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM core.settlement_report WHERE report_id=%s", (report_id,))
        return cur.fetchone() is not None


def _store_report(report: dict[str, Any], rows: list[dict[str, str]], document_meta: dict[str, Any]) -> int:
    report_id = str(report["reportId"])
    document_id = str(report["reportDocumentId"])
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO raw.api_payload(source,resource_type,resource_id,marketplace_id,payload)
            VALUES (%s,%s,%s,%s,%s::jsonb)
            """,
            (
                SOURCE,
                REPORT_TYPE,
                report_id,
                settings.marketplace_id,
                json.dumps({
                    "report": report,
                    "document_meta": document_meta,
                    "headers": list(rows[0].keys()) if rows else [],
                    "row_count": len(rows),
                }),
            ),
        )
        cur.execute(
            """
            INSERT INTO core.settlement_report(
                report_id,marketplace_id,report_document_id,created_time,
                processing_start_time,processing_end_time,row_count,fetched_at
            ) VALUES (%s,%s,%s,%s,%s,%s,%s,now())
            ON CONFLICT (report_id) DO UPDATE SET
                report_document_id=EXCLUDED.report_document_id,
                created_time=EXCLUDED.created_time,
                processing_start_time=EXCLUDED.processing_start_time,
                processing_end_time=EXCLUDED.processing_end_time,
                row_count=EXCLUDED.row_count,
                fetched_at=now()
            """,
            (
                report_id,
                settings.marketplace_id,
                document_id,
                _ts(report.get("createdTime")),
                _ts(report.get("processingStartTime")),
                _ts(report.get("processingEndTime")),
                len(rows),
            ),
        )
        cur.execute("DELETE FROM core.settlement_line WHERE report_id=%s", (report_id,))
        for i, row in enumerate(rows, start=1):
            cur.execute(
                """
                INSERT INTO core.settlement_line(
                    report_id,row_number,marketplace_id,settlement_id,settlement_start_date,
                    settlement_end_date,deposit_date,total_amount,currency,transaction_type,
                    order_id,merchant_order_id,adjustment_id,shipment_id,marketplace_name,
                    amount_type,amount_description,amount,fulfillment_id,posted_date_time,
                    sku,quantity_purchased,raw_row
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
                """,
                (
                    report_id,
                    i,
                    settings.marketplace_id,
                    _first(row, "settlement-id", "settlement_id"),
                    _ts(_first(row, "settlement-start-date", "settlement_start_date")),
                    _ts(_first(row, "settlement-end-date", "settlement_end_date")),
                    _ts(_first(row, "deposit-date", "deposit_date")),
                    _money(_first(row, "total-amount", "total_amount")),
                    _first(row, "currency"),
                    _first(row, "transaction-type", "transaction_type"),
                    _first(row, "order-id", "order_id"),
                    _first(row, "merchant-order-id", "merchant_order_id"),
                    _first(row, "adjustment-id", "adjustment_id"),
                    _first(row, "shipment-id", "shipment_id"),
                    _first(row, "marketplace-name", "marketplace_name"),
                    _first(row, "amount-type", "amount_type"),
                    _first(row, "amount-description", "amount_description"),
                    _money(_first(row, "amount")),
                    _first(row, "fulfillment-id", "fulfillment_id"),
                    _ts(_first(row, "posted-date-time", "posted-date", "posted_date_time")),
                    _first(row, "sku"),
                    _number(_first(row, "quantity-purchased", "quantity_purchased")),
                    json.dumps(row),
                ),
            )
        conn.commit()
    return len(rows)


def ingest_settlement_reports() -> dict[str, int]:
    """Discover Amazon-generated settlement reports and ingest any unseen reports."""
    with db.ingestion_run(SOURCE, JOB, {"marketplace": settings.marketplace_id, "report_type": REPORT_TYPE}) as run:
        client = SpApiClient()
        reports: list[dict[str, Any]] = []
        try:
            params: list[tuple[str, Any]] = [
                ("reportTypes", REPORT_TYPE),
                ("processingStatuses", "DONE"),
                ("pageSize", 100),
            ]
            while True:
                payload = _payload(client.get("/reports/2021-06-30/reports", params=params))
                reports.extend(payload.get("reports") or [])
                token = payload.get("nextToken")
                if not token:
                    break
                params = [("nextToken", token), ("pageSize", 100)]

            reports.sort(key=lambda x: x.get("createdTime") or "")
            read = 0
            written = 0
            for report in reports:
                report_id = report.get("reportId")
                document_id = report.get("reportDocumentId")
                if not report_id or not document_id or _already_ingested(str(report_id)):
                    continue
                text, meta = _download_document(client, str(document_id))
                reader = csv.DictReader(io.StringIO(text), delimiter="\t")
                rows = [dict(r) for r in reader]
                read += len(rows)
                written += _store_report(report, rows, meta)

            run["records_read"] = read
            run["records_written"] = written
            return {"reports_seen": len(reports), "records_read": read, "records_written": written}
        finally:
            client.close()
