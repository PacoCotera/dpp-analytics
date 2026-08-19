from __future__ import annotations

import datetime as dt
import hashlib
import json
from decimal import Decimal
from typing import Any

from psycopg.types.json import Jsonb

from . import db
from .settings import settings
from .spapi import SpApiClient

SOURCE = "amazon_spapi"
JOB = "orders_v2026"


def _decimal(money: dict[str, Any] | None) -> Decimal | None:
    if not money or money.get("amount") is None:
        return None
    return Decimal(str(money["amount"]))


def _currency(money: dict[str, Any] | None) -> str | None:
    return money.get("currencyCode") if money else None


def _breakdown_amount(proceeds: dict[str, Any] | None, kind: str) -> Decimal | None:
    if not proceeds:
        return None
    values: list[Decimal] = []
    for item in proceeds.get("breakdowns") or []:
        if item.get("type") != kind:
            continue
        subtotal = item.get("subtotal") or {}
        if subtotal.get("amount") is not None:
            values.append(Decimal(str(subtotal["amount"])))
    return sum(values, Decimal("0")) if values else None


def _iso(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_iso(value: str) -> dt.datetime:
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def ingest_orders(client: SpApiClient | None = None) -> dict[str, int]:
    own_client = client is None
    client = client or SpApiClient()

    now = dt.datetime.now(dt.timezone.utc)
    safe_before = now - dt.timedelta(minutes=3)
    cursor = db.get_cursor(SOURCE, JOB)
    if cursor:
        after = _parse_iso(cursor) - dt.timedelta(minutes=5)
    else:
        configured = __import__("os").getenv("ORDERS_BACKFILL_START", "2025-10-01T00:00:00Z")
        after = _parse_iso(configured)

    if after >= safe_before:
        return {"records_read": 0, "records_written": 0}

    base_params: list[tuple[str, Any]] = [
        ("lastUpdatedAfter", _iso(after)),
        ("lastUpdatedBefore", _iso(safe_before)),
        ("marketplaceIds", settings.marketplace_id),
        ("maxResultsPerPage", 100),
        ("includedData", "PROCEEDS"),
        ("includedData", "FULFILLMENT"),
        ("includedData", "PROMOTION"),
    ]

    totals = {"records_read": 0, "records_written": 0}
    token: str | None = None

    try:
        with db.ingestion_run(SOURCE, JOB, {"after": _iso(after), "before": _iso(safe_before)}) as run:
            while True:
                params = list(base_params)
                if token:
                    params.append(("paginationToken", token))

                payload = client.get("/orders/2026-01-01/orders", params=params)
                orders = payload.get("orders") or []
                totals["records_read"] += len(orders)
                run["records_read"] = totals["records_read"]

                with db.connect() as conn, conn.cursor() as cur:
                    for order in orders:
                        encoded = json.dumps(order, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
                        digest = hashlib.sha256(encoded).hexdigest()
                        order_id = order.get("orderId")
                        channel = order.get("salesChannel") or {}
                        marketplace_id = channel.get("marketplaceId") or settings.marketplace_id

                        cur.execute(
                            """
                            INSERT INTO raw.api_payload
                                (source, resource_type, resource_id, marketplace_id, fetched_at,
                                 request_window_start, request_window_end, payload, payload_sha256, ingestion_run_id)
                            VALUES (%s,'order',%s,%s,now(),%s,%s,%s,%s,%s)
                            RETURNING id
                            """,
                            (SOURCE, order_id, marketplace_id, after, safe_before, Jsonb(order), digest, run["id"]),
                        )
                        raw_id = cur.fetchone()["id"]

                        proceeds = order.get("proceeds") or {}
                        grand_total = proceeds.get("grandTotal") or {}
                        fulfillment = order.get("fulfillment") or {}

                        cur.execute(
                            """
                            INSERT INTO core.amazon_order
                                (amazon_order_id, marketplace_id, created_time, last_updated_time,
                                 fulfillment_status, fulfilled_by, channel_name, programs,
                                 grand_total_amount, currency, quantity_fulfilled, quantity_unfulfilled,
                                 last_seen_at, source_payload_id)
                            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now(),%s)
                            ON CONFLICT (amazon_order_id) DO UPDATE SET
                                marketplace_id=EXCLUDED.marketplace_id,
                                created_time=EXCLUDED.created_time,
                                last_updated_time=EXCLUDED.last_updated_time,
                                fulfillment_status=EXCLUDED.fulfillment_status,
                                fulfilled_by=EXCLUDED.fulfilled_by,
                                channel_name=EXCLUDED.channel_name,
                                programs=EXCLUDED.programs,
                                grand_total_amount=EXCLUDED.grand_total_amount,
                                currency=EXCLUDED.currency,
                                quantity_fulfilled=EXCLUDED.quantity_fulfilled,
                                quantity_unfulfilled=EXCLUDED.quantity_unfulfilled,
                                last_seen_at=now(), source_payload_id=EXCLUDED.source_payload_id
                            """,
                            (
                                order_id,
                                marketplace_id,
                                order.get("createdTime"),
                                order.get("lastUpdatedTime"),
                                fulfillment.get("fulfillmentStatus"),
                                fulfillment.get("fulfilledBy"),
                                channel.get("channelName"),
                                order.get("programs") or [],
                                _decimal(grand_total),
                                _currency(grand_total),
                                fulfillment.get("quantityFulfilled"),
                                fulfillment.get("quantityUnfulfilled"),
                                raw_id,
                            ),
                        )

                        for item in order.get("orderItems") or []:
                            product = item.get("product") or {}
                            price = product.get("price") or {}
                            unit_price = price.get("unitPrice") or {}
                            item_proceeds = item.get("proceeds") or {}
                            proceeds_total = item_proceeds.get("proceedsTotal") or {}
                            item_fulfillment = item.get("fulfillment") or {}
                            sku = product.get("sellerSku")
                            asin = product.get("asin")

                            if sku:
                                cur.execute(
                                    """
                                    INSERT INTO core.sku (sku, asin, title, marketplace_id, currency, updated_at)
                                    VALUES (%s,%s,%s,%s,%s,now())
                                    ON CONFLICT (sku) DO UPDATE SET
                                        asin=COALESCE(EXCLUDED.asin, core.sku.asin),
                                        title=COALESCE(EXCLUDED.title, core.sku.title),
                                        marketplace_id=COALESCE(EXCLUDED.marketplace_id, core.sku.marketplace_id),
                                        currency=COALESCE(EXCLUDED.currency, core.sku.currency),
                                        updated_at=now()
                                    """,
                                    (sku, asin, product.get("title"), marketplace_id, _currency(unit_price) or _currency(proceeds_total) or "MXN"),
                                )

                            cur.execute(
                                """
                                INSERT INTO core.amazon_order_item
                                    (amazon_order_id, order_item_id, seller_sku, asin, title,
                                     quantity_ordered, quantity_fulfilled, quantity_unfulfilled,
                                     unit_price_amount, proceeds_item_amount, proceeds_shipping_amount,
                                     proceeds_tax_amount, proceeds_total_amount, currency,
                                     last_seen_at, source_payload_id)
                                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now(),%s)
                                ON CONFLICT (amazon_order_id, order_item_id) DO UPDATE SET
                                    seller_sku=EXCLUDED.seller_sku, asin=EXCLUDED.asin, title=EXCLUDED.title,
                                    quantity_ordered=EXCLUDED.quantity_ordered,
                                    quantity_fulfilled=EXCLUDED.quantity_fulfilled,
                                    quantity_unfulfilled=EXCLUDED.quantity_unfulfilled,
                                    unit_price_amount=EXCLUDED.unit_price_amount,
                                    proceeds_item_amount=EXCLUDED.proceeds_item_amount,
                                    proceeds_shipping_amount=EXCLUDED.proceeds_shipping_amount,
                                    proceeds_tax_amount=EXCLUDED.proceeds_tax_amount,
                                    proceeds_total_amount=EXCLUDED.proceeds_total_amount,
                                    currency=EXCLUDED.currency, last_seen_at=now(),
                                    source_payload_id=EXCLUDED.source_payload_id
                                """,
                                (
                                    order_id,
                                    item.get("orderItemId"),
                                    sku,
                                    asin,
                                    product.get("title"),
                                    item.get("quantityOrdered") or 0,
                                    item_fulfillment.get("quantityFulfilled"),
                                    item_fulfillment.get("quantityUnfulfilled"),
                                    _decimal(unit_price),
                                    _breakdown_amount(item_proceeds, "ITEM"),
                                    _breakdown_amount(item_proceeds, "SHIPPING"),
                                    _breakdown_amount(item_proceeds, "TAX"),
                                    _decimal(proceeds_total),
                                    _currency(proceeds_total) or _currency(unit_price),
                                    raw_id,
                                ),
                            )

                        totals["records_written"] += 1

                    conn.commit()

                run["records_written"] = totals["records_written"]
                token = (payload.get("pagination") or {}).get("nextToken")
                if not token:
                    break

            db.set_cursor(SOURCE, JOB, _iso(safe_before))

        return totals
    finally:
        if own_client:
            client.close()
