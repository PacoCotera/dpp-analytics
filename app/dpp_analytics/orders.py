from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
from decimal import Decimal
from typing import Any

from psycopg.types.json import Jsonb

from . import db
from .settings import settings
from .spapi import SpApiClient

SOURCE = "amazon_spapi"
JOB = "orders_v2026"
GEOGRAPHY_JOB = "orders_geography_v2026"
FULFILLMENT_BACKFILL_CURSOR = "fulfillment_csv_v1_complete"


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


def _recipient_geography(order: dict[str, Any]) -> tuple[str | None, str | None, str | None]:
    recipient = order.get("recipient") or {}
    address = recipient.get("deliveryAddress") or {}
    state = address.get("stateOrRegion")
    country = address.get("countryCode")
    postal = address.get("postalCode")

    if isinstance(state, str):
        state = state.strip() or None
    else:
        state = None
    if isinstance(country, str):
        country = country.strip().upper()[:2] or None
    else:
        country = None
    if isinstance(postal, str):
        postal = postal.strip().upper() or None
    elif postal is not None:
        postal = str(postal).strip().upper() or None
    else:
        postal = None
    return state, country, postal


def ingest_orders(client: SpApiClient | None = None) -> dict[str, int]:
    """Canonical Orders ingestion without recipient PII.

    Recipient geography is intentionally handled by a separate enrichment job so
    a missing restricted role can never interrupt sales/order ingestion.

    The first successful run with the corrected includedData serialization
    deliberately replays the configured order history once. Earlier requests sent
    repeated includedData keys, which Amazon accepted but did not populate the
    FULFILLMENT dataset for our stored rows. The named cursor makes this repair
    durable and prevents repeated historical sweeps.
    """
    own_client = client is None
    client = client or SpApiClient()

    now = dt.datetime.now(dt.timezone.utc)
    safe_before = now - dt.timedelta(minutes=3)
    configured = os.getenv("ORDERS_BACKFILL_START", "2025-10-01T00:00:00Z")
    configured_after = _parse_iso(configured)
    cursor = db.get_cursor(SOURCE, JOB)
    fulfillment_backfill_complete = db.get_cursor(SOURCE, JOB, FULFILLMENT_BACKFILL_CURSOR)
    repair_fulfillment_history = fulfillment_backfill_complete is None

    if repair_fulfillment_history:
        after = configured_after
    elif cursor:
        after = _parse_iso(cursor) - dt.timedelta(minutes=5)
    else:
        after = configured_after

    if after >= safe_before:
        return {"records_read": 0, "records_written": 0}

    # Orders v2026 defines includedData as one array query parameter. Swagger 2
    # array query parameters use CSV serialization by default. Sending the same
    # key repeatedly caused Amazon to return PROCEEDS while omitting FULFILLMENT,
    # leaving every stored fulfillment_status blank even though Seller Central
    # had current Pending orders.
    base_params: list[tuple[str, Any]] = [
        ("lastUpdatedAfter", _iso(after)),
        ("lastUpdatedBefore", _iso(safe_before)),
        ("marketplaceIds", settings.marketplace_id),
        ("maxResultsPerPage", 100),
        ("includedData", "PROCEEDS,FULFILLMENT,PROMOTION"),
    ]

    totals = {"records_read": 0, "records_written": 0}
    token: str | None = None

    try:
        with db.ingestion_run(
            SOURCE,
            JOB,
            {
                "after": _iso(after),
                "before": _iso(safe_before),
                "fulfillment_history_repair": repair_fulfillment_history,
                "included_data": ["PROCEEDS", "FULFILLMENT", "PROMOTION"],
            },
        ) as run:
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
            if repair_fulfillment_history:
                db.set_cursor(SOURCE, JOB, _iso(safe_before), FULFILLMENT_BACKFILL_CURSOR)

        return totals
    finally:
        if own_client:
            client.close()


def backfill_order_geography(client: SpApiClient | None = None) -> dict[str, int]:
    """Backfill state/country/postal only; never persist the recipient payload."""
    own_client = client is None
    client = client or SpApiClient()
    safe_before = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=3)
    configured = os.getenv("ORDERS_BACKFILL_START", "2025-10-01T00:00:00Z")
    created_after = _parse_iso(configured)
    params_base: list[tuple[str, Any]] = [
        ("createdAfter", _iso(created_after)),
        ("createdBefore", _iso(safe_before)),
        ("marketplaceIds", settings.marketplace_id),
        ("maxResultsPerPage", 100),
        ("includedData", "RECIPIENT"),
    ]
    totals = {"records_read": 0, "records_written": 0}
    token: str | None = None

    try:
        with db.ingestion_run(
            SOURCE,
            GEOGRAPHY_JOB,
            {
                "after": _iso(created_after),
                "before": _iso(safe_before),
                "retained": ["stateOrRegion", "countryCode", "postalCode"],
                "recipient_payload_persisted": False,
            },
        ) as run:
            while True:
                params = list(params_base)
                if token:
                    params.append(("paginationToken", token))
                payload = client.get("/orders/2026-01-01/orders", params=params)
                orders = payload.get("orders") or []
                totals["records_read"] += len(orders)
                run["records_read"] = totals["records_read"]

                with db.connect() as conn, conn.cursor() as cur:
                    for order in orders:
                        order_id = order.get("orderId")
                        if not order_id:
                            continue
                        state_or_region, country, postal_code = _recipient_geography(order)
                        if state_or_region is None and country is None and postal_code is None:
                            continue
                        cur.execute(
                            """
                            UPDATE core.amazon_order
                            SET destination_state_or_region=COALESCE(%s,destination_state_or_region),
                                destination_country_code=COALESCE(%s,destination_country_code),
                                destination_postal_code=COALESCE(%s,destination_postal_code)
                            WHERE amazon_order_id=%s AND marketplace_id=%s
                            """,
                            (state_or_region, country, postal_code, order_id, settings.marketplace_id),
                        )
                        totals["records_written"] += cur.rowcount
                    conn.commit()

                run["records_written"] = totals["records_written"]
                token = (payload.get("pagination") or {}).get("nextToken")
                if not token:
                    break
        return totals
    finally:
        if own_client:
            client.close()
