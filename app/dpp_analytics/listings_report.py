from __future__ import annotations

import csv
import io
import json
import time
from datetime import datetime
from typing import Any

import httpx

from . import db
from .settings import settings
from .spapi import SpApiClient, SpApiError

SOURCE = "amazon_reports"
JOB = "merchant_listings_all_data"
REPORT_TYPE = "GET_MERCHANT_LISTINGS_ALL_DATA"


def _payload(value: dict[str, Any]) -> dict[str, Any]:
    nested = value.get("payload")
    return nested if isinstance(nested, dict) else value


def _int(value: str | None) -> int | None:
    if value is None or value.strip() == "":
        return None
    try:
        return int(float(value.strip()))
    except ValueError:
        return None


def _money(value: str | None) -> float | None:
    if value is None or value.strip() == "":
        return None
    try:
        return float(value.strip().replace(",", ""))
    except ValueError:
        return None


def _date(value: str | None):
    if not value or not value.strip():
        return None
    text = value.strip()
    for fmt in ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S", "%m/%d/%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(text[:19], fmt).date()
        except ValueError:
            pass
    return None


def _first(row: dict[str, str], *keys: str) -> str | None:
    for key in keys:
        value = row.get(key)
        if value is not None and value.strip() != "":
            return value.strip()
    return None


def _download_document(client: SpApiClient, report_document_id: str) -> tuple[str, dict[str, Any]]:
    meta = _payload(
        client.get(
            f"/reports/2021-06-30/documents/{report_document_id}",
            params={"enableContentEncodingUrlHeader": "true"},
        )
    )
    url = meta.get("url")
    if not url:
        raise SpApiError("Reports API returned no report document URL")
    with httpx.Client(timeout=httpx.Timeout(90.0, connect=20.0), follow_redirects=True) as http:
        response = http.get(url)
        response.raise_for_status()
        # With enableContentEncodingUrlHeader=true, httpx handles gzip automatically.
        text = response.content.decode("utf-8-sig", errors="replace")
    return text, meta


def ingest_listings_report() -> dict[str, int | str]:
    with db.ingestion_run(SOURCE, JOB, {"marketplace": settings.marketplace_id, "report_type": REPORT_TYPE}) as run:
        client = SpApiClient()
        try:
            created = _payload(
                client.post(
                    "/reports/2021-06-30/reports",
                    json_body={
                        "reportType": REPORT_TYPE,
                        "marketplaceIds": [settings.marketplace_id],
                        "reportOptions": {"preferredReportDocumentLocale": "en_US"},
                    },
                )
            )
            report_id = created.get("reportId")
            if not report_id:
                raise SpApiError(f"Reports API returned no reportId: {created}")

            deadline = time.monotonic() + settings.reports_poll_timeout_seconds
            report: dict[str, Any] = {}
            while time.monotonic() < deadline:
                report = _payload(client.get(f"/reports/2021-06-30/reports/{report_id}"))
                status = report.get("processingStatus")
                if status == "DONE":
                    break
                if status in {"CANCELLED", "FATAL"}:
                    raise SpApiError(f"Report {report_id} ended with status={status}")
                time.sleep(settings.reports_poll_seconds)
            else:
                raise TimeoutError(f"Report {report_id} did not finish within {settings.reports_poll_timeout_seconds}s")

            document_id = report.get("reportDocumentId")
            if not document_id:
                raise SpApiError(f"Completed report {report_id} has no reportDocumentId")

            text, document_meta = _download_document(client, document_id)
            reader = csv.DictReader(io.StringIO(text), delimiter="\t")
            rows = [dict(row) for row in reader]
            run["records_read"] = len(rows)

            raw_payload = {
                "report_id": report_id,
                "report_document_id": document_id,
                "report_type": REPORT_TYPE,
                "document_meta": {k: v for k, v in document_meta.items() if k != "url"},
                "headers": reader.fieldnames or [],
                "rows": rows,
            }

            with db.connect() as conn, conn.cursor() as cur:
                cur.execute(
                    "SELECT seller_sku FROM core.seller_listing WHERE marketplace_id=%s",
                    (settings.marketplace_id,),
                )
                known_skus = {str(row["seller_sku"]) for row in cur.fetchall()}

                cur.execute(
                    """
                    INSERT INTO raw.api_payload(source,resource_type,resource_id,marketplace_id,payload,ingestion_run_id)
                    VALUES (%s,%s,%s,%s,%s::jsonb,%s)
                    RETURNING id
                    """,
                    (SOURCE, REPORT_TYPE, report_id, settings.marketplace_id, json.dumps(raw_payload), run["id"]),
                )
                raw_id = cur.fetchone()["id"]

                seen: set[str] = set()
                written = 0
                for row in rows:
                    sku = _first(row, "seller-sku", "sku")
                    if not sku:
                        continue
                    seen.add(sku)
                    asin = _first(row, "asin1", "asin", "product-id")
                    title = _first(row, "item-name")
                    image_url = _first(row, "image-url")
                    status = _first(row, "status")
                    cur.execute(
                        """
                        INSERT INTO core.seller_listing(
                            marketplace_id,seller_sku,asin,listing_id,item_name,item_description,
                            price,quantity,pending_quantity,image_url,open_date,item_condition,
                            fulfillment_channel,merchant_shipping_group,status,source_payload_id,fetched_at,first_seen_at
                        ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now(),now())
                        ON CONFLICT (marketplace_id,seller_sku) DO UPDATE SET
                            asin=EXCLUDED.asin,
                            listing_id=EXCLUDED.listing_id,
                            item_name=EXCLUDED.item_name,
                            item_description=EXCLUDED.item_description,
                            price=EXCLUDED.price,
                            quantity=EXCLUDED.quantity,
                            pending_quantity=EXCLUDED.pending_quantity,
                            image_url=EXCLUDED.image_url,
                            open_date=EXCLUDED.open_date,
                            item_condition=EXCLUDED.item_condition,
                            fulfillment_channel=EXCLUDED.fulfillment_channel,
                            merchant_shipping_group=EXCLUDED.merchant_shipping_group,
                            status=EXCLUDED.status,
                            source_payload_id=EXCLUDED.source_payload_id,
                            fetched_at=now()
                        """,
                        (
                            settings.marketplace_id,
                            sku,
                            asin,
                            _first(row, "listing-id"),
                            title,
                            _first(row, "item-description"),
                            _money(_first(row, "price")),
                            _int(_first(row, "quantity")),
                            _int(_first(row, "pending-quantity")),
                            image_url,
                            _date(_first(row, "open-date")),
                            _first(row, "item-condition"),
                            _first(row, "fulfillment-channel"),
                            _first(row, "merchant-shipping-group"),
                            status,
                            raw_id,
                        ),
                    )
                    cur.execute(
                        """
                        INSERT INTO core.sku(sku,asin,title,marketplace_id,list_price,currency,active,updated_at)
                        VALUES (%s,%s,%s,%s,%s,'MXN',%s,now())
                        ON CONFLICT (sku) DO UPDATE SET
                            asin=COALESCE(EXCLUDED.asin,core.sku.asin),
                            title=COALESCE(EXCLUDED.title,core.sku.title),
                            marketplace_id=EXCLUDED.marketplace_id,
                            list_price=COALESCE(EXCLUDED.list_price,core.sku.list_price),
                            active=EXCLUDED.active,
                            updated_at=now()
                        """,
                        (sku, asin, title, settings.marketplace_id, _money(_first(row, "price")), status != "Inactive"),
                    )
                    if asin and (title or image_url):
                        cur.execute(
                            """
                            INSERT INTO core.catalog_item(marketplace_id,asin,title,image_url,updated_at)
                            VALUES (%s,%s,%s,%s,now())
                            ON CONFLICT (marketplace_id,asin) DO UPDATE SET
                                title=COALESCE(EXCLUDED.title,core.catalog_item.title),
                                image_url=COALESCE(EXCLUDED.image_url,core.catalog_item.image_url),
                                updated_at=now()
                            """,
                            (settings.marketplace_id, asin, title, image_url),
                        )
                    written += 1

                # The report is authoritative for seller listings. Do not delete local SKU metadata;
                # only mark previously known seller listings not present in this snapshot inactive.
                if seen:
                    cur.execute(
                        """
                        UPDATE core.sku
                        SET active=false, updated_at=now()
                        WHERE marketplace_id=%s
                          AND sku IN (SELECT seller_sku FROM core.seller_listing WHERE marketplace_id=%s)
                          AND NOT (sku = ANY(%s))
                        """,
                        (settings.marketplace_id, settings.marketplace_id, list(seen)),
                    )
                conn.commit()

            discovered = sorted(seen - known_skus)
            run["records_written"] = written
            return {
                "records_read": len(rows),
                "records_written": written,
                "report_id": report_id,
                "new_skus": len(discovered),
                "new_sku_ids": discovered[:20],
            }
        finally:
            client.close()
