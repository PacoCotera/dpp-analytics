from __future__ import annotations

import datetime as dt
import hashlib
import json
from typing import Any

from psycopg.types.json import Jsonb

from . import db
from .settings import settings
from .spapi import SpApiClient

SOURCE = "amazon_spapi"
JOB = "fba_inventory_v1"


def _safe_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def ingest_inventory(client: SpApiClient | None = None) -> dict[str, int]:
    own_client = client is None
    client = client or SpApiClient()
    snapshot_at = dt.datetime.now(dt.timezone.utc).replace(minute=0, second=0, microsecond=0)

    totals = {"records_read": 0, "records_written": 0}
    next_token: str | None = None

    try:
        with db.ingestion_run(SOURCE, JOB, {"snapshot_at": snapshot_at.isoformat()}) as run:
            while True:
                params: list[tuple[str, Any]] = [
                    ("details", "true"),
                    ("granularityType", "Marketplace"),
                    ("granularityId", settings.marketplace_id),
                    ("marketplaceIds", settings.marketplace_id),
                ]
                if next_token:
                    params.append(("nextToken", next_token))

                payload = client.get("/fba/inventory/v1/summaries", params=params)
                items = ((payload.get("payload") or {}).get("inventorySummaries") or payload.get("inventorySummaries") or [])
                totals["records_read"] += len(items)
                run["records_read"] = totals["records_read"]

                with db.connect() as conn, conn.cursor() as cur:
                    for item in items:
                        sku = item.get("sellerSku")
                        if not sku:
                            continue

                        encoded = json.dumps(item, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
                        digest = hashlib.sha256(encoded).hexdigest()
                        cur.execute(
                            """
                            INSERT INTO raw.api_payload
                                (source, resource_type, resource_id, marketplace_id, fetched_at,
                                 payload, payload_sha256, ingestion_run_id)
                            VALUES (%s,'inventory_summary',%s,%s,now(),%s,%s,%s)
                            RETURNING id
                            """,
                            (SOURCE, sku, settings.marketplace_id, Jsonb(item), digest, run["id"]),
                        )
                        raw_id = cur.fetchone()["id"]

                        details = item.get("inventoryDetails") or {}
                        reserved = details.get("reservedQuantity") or {}
                        unfulfillable = details.get("unfulfillableQuantity") or {}
                        researching = details.get("researchingQuantity") or {}

                        cur.execute(
                            """
                            INSERT INTO core.sku (sku, asin, title, marketplace_id, updated_at)
                            VALUES (%s,%s,%s,%s,now())
                            ON CONFLICT (sku) DO UPDATE SET
                                asin=COALESCE(EXCLUDED.asin, core.sku.asin),
                                title=COALESCE(EXCLUDED.title, core.sku.title),
                                marketplace_id=COALESCE(EXCLUDED.marketplace_id, core.sku.marketplace_id),
                                updated_at=now()
                            """,
                            (sku, item.get("asin"), item.get("productName"), settings.marketplace_id),
                        )

                        cur.execute(
                            """
                            INSERT INTO core.inventory_snapshot
                                (snapshot_at, marketplace_id, seller_sku, asin, fnsku, condition,
                                 fulfillable_quantity, inbound_working_quantity, inbound_shipped_quantity,
                                 inbound_receiving_quantity, reserved_quantity, unfulfillable_quantity,
                                 researching_quantity, total_quantity, source_payload_id)
                            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                            ON CONFLICT (snapshot_at, marketplace_id, seller_sku) DO UPDATE SET
                                asin=EXCLUDED.asin, fnsku=EXCLUDED.fnsku, condition=EXCLUDED.condition,
                                fulfillable_quantity=EXCLUDED.fulfillable_quantity,
                                inbound_working_quantity=EXCLUDED.inbound_working_quantity,
                                inbound_shipped_quantity=EXCLUDED.inbound_shipped_quantity,
                                inbound_receiving_quantity=EXCLUDED.inbound_receiving_quantity,
                                reserved_quantity=EXCLUDED.reserved_quantity,
                                unfulfillable_quantity=EXCLUDED.unfulfillable_quantity,
                                researching_quantity=EXCLUDED.researching_quantity,
                                total_quantity=EXCLUDED.total_quantity,
                                source_payload_id=EXCLUDED.source_payload_id
                            """,
                            (
                                snapshot_at,
                                settings.marketplace_id,
                                sku,
                                item.get("asin"),
                                item.get("fnSku"),
                                item.get("condition"),
                                _safe_int(details.get("fulfillableQuantity")),
                                _safe_int(details.get("inboundWorkingQuantity")),
                                _safe_int(details.get("inboundShippedQuantity")),
                                _safe_int(details.get("inboundReceivingQuantity")),
                                _safe_int(reserved.get("totalReservedQuantity")),
                                _safe_int(unfulfillable.get("totalUnfulfillableQuantity")),
                                _safe_int(researching.get("totalResearchingQuantity")),
                                _safe_int(item.get("totalQuantity")),
                                raw_id,
                            ),
                        )
                        totals["records_written"] += 1

                    conn.commit()

                run["records_written"] = totals["records_written"]
                pagination = payload.get("pagination") or (payload.get("payload") or {}).get("pagination") or {}
                next_token = pagination.get("nextToken")
                if not next_token:
                    break

        return totals
    finally:
        if own_client:
            client.close()
