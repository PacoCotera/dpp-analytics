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
JOB = "finances_v2024"
MAX_WINDOW = dt.timedelta(days=179)


def _iso(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_iso(value: str) -> dt.datetime:
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def _money(money: dict[str, Any] | None) -> tuple[Decimal | None, str | None]:
    if not isinstance(money, dict):
        return None, None
    raw = money.get("currencyAmount")
    if raw is None:
        raw = money.get("amount")
    amount = Decimal(str(raw)) if raw is not None else None
    currency = money.get("currencyCode")
    return amount, currency


def _payload_root(payload: dict[str, Any]) -> dict[str, Any]:
    # Production has returned both the documented top-level response and a
    # {payload:{transactions,nextToken}} wrapper. Accept both.
    wrapped = payload.get("payload")
    return wrapped if isinstance(wrapped, dict) else payload


def _walk_identifiers(value: Any):
    if isinstance(value, dict):
        name = value.get("relatedIdentifierName") or value.get("itemRelatedIdentifierName")
        identifier = value.get("relatedIdentifierValue") or value.get("itemRelatedIdentifierValue")
        if name and identifier:
            yield str(name), str(identifier)
        for child in value.values():
            yield from _walk_identifiers(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_identifiers(child)


def _amazon_order_id(transaction: dict[str, Any]) -> str | None:
    for name, value in _walk_identifiers(transaction.get("relatedIdentifiers") or []):
        if name.upper() in {"ORDER_ID", "AMAZON_ORDER_ID"}:
            return value
    for name, value in _walk_identifiers(transaction.get("items") or []):
        if name.upper() in {"ORDER_ID", "AMAZON_ORDER_ID"}:
            return value
    return None


def _save_transactions(
    transactions: list[dict[str, Any]],
    *,
    window_start: dt.datetime,
    window_end: dt.datetime,
    run_id: int,
) -> int:
    written = 0
    with db.connect() as conn, conn.cursor() as cur:
        for transaction in transactions:
            encoded = json.dumps(
                transaction,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            ).encode()
            digest = hashlib.sha256(encoded).hexdigest()
            transaction_id = transaction.get("transactionId") or f"synthetic:{digest}"

            marketplace = transaction.get("marketplaceDetails") or {}
            marketplace_id = marketplace.get("marketplaceId") or settings.marketplace_id
            total_amount, currency = _money(transaction.get("totalAmount"))

            cur.execute(
                """
                INSERT INTO raw.api_payload
                    (source, resource_type, resource_id, marketplace_id, fetched_at,
                     request_window_start, request_window_end, payload, payload_sha256,
                     ingestion_run_id)
                VALUES (%s,'financial_transaction',%s,%s,now(),%s,%s,%s,%s,%s)
                RETURNING id
                """,
                (
                    SOURCE,
                    transaction_id,
                    marketplace_id,
                    window_start,
                    window_end,
                    Jsonb(transaction),
                    digest,
                    run_id,
                ),
            )
            raw_id = cur.fetchone()["id"]

            cur.execute(
                """
                INSERT INTO core.financial_transaction
                    (transaction_id, transaction_type, transaction_status, posted_date,
                     marketplace_id, amazon_order_id, total_amount, currency, description,
                     related_identifiers, breakdowns, source_payload_id, last_seen_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())
                ON CONFLICT (transaction_id) DO UPDATE SET
                    transaction_type=EXCLUDED.transaction_type,
                    transaction_status=EXCLUDED.transaction_status,
                    posted_date=EXCLUDED.posted_date,
                    marketplace_id=EXCLUDED.marketplace_id,
                    amazon_order_id=COALESCE(EXCLUDED.amazon_order_id, core.financial_transaction.amazon_order_id),
                    total_amount=EXCLUDED.total_amount,
                    currency=EXCLUDED.currency,
                    description=EXCLUDED.description,
                    related_identifiers=EXCLUDED.related_identifiers,
                    breakdowns=EXCLUDED.breakdowns,
                    source_payload_id=EXCLUDED.source_payload_id,
                    last_seen_at=now()
                """,
                (
                    transaction_id,
                    transaction.get("transactionType"),
                    transaction.get("transactionStatus"),
                    transaction.get("postedDate"),
                    marketplace_id,
                    _amazon_order_id(transaction),
                    total_amount,
                    currency,
                    transaction.get("description"),
                    Jsonb(transaction.get("relatedIdentifiers") or []),
                    Jsonb(transaction.get("breakdowns") or []),
                    raw_id,
                ),
            )
            written += 1
        conn.commit()
    return written


def ingest_finances(client: SpApiClient | None = None) -> dict[str, int]:
    own_client = client is None
    client = client or SpApiClient()

    now = dt.datetime.now(dt.timezone.utc)
    # Amazon notes financial events might not include orders from the last 48h.
    safe_before = now - dt.timedelta(hours=48)
    cursor = db.get_cursor(SOURCE, JOB)
    if cursor:
        after = _parse_iso(cursor) - dt.timedelta(days=3)
    else:
        after = _parse_iso(os.getenv("FINANCES_BACKFILL_START", "2025-10-01T00:00:00Z"))

    if after >= safe_before:
        return {"records_read": 0, "records_written": 0}

    totals = {"records_read": 0, "records_written": 0}

    try:
        with db.ingestion_run(SOURCE, JOB, {"after": _iso(after), "before": _iso(safe_before)}) as run:
            window_start = after
            while window_start < safe_before:
                window_end = min(window_start + MAX_WINDOW, safe_before)
                next_token: str | None = None

                while True:
                    params: dict[str, Any] = {
                        "postedAfter": _iso(window_start),
                        "postedBefore": _iso(window_end),
                        "marketplaceId": settings.marketplace_id,
                        "pageSize": 500,
                    }
                    if next_token:
                        params["nextToken"] = next_token

                    response = client.get("/finances/2024-06-19/transactions", params=params)
                    payload = _payload_root(response)
                    transactions = payload.get("transactions") or []
                    totals["records_read"] += len(transactions)
                    totals["records_written"] += _save_transactions(
                        transactions,
                        window_start=window_start,
                        window_end=window_end,
                        run_id=run["id"],
                    )
                    run.update(totals)

                    next_token = payload.get("nextToken")
                    if not next_token:
                        break

                # Persist progress after each supported date window so a later
                # transient failure never restarts the entire historical backfill.
                db.set_cursor(SOURCE, JOB, _iso(window_end))
                window_start = window_end

        return totals
    finally:
        if own_client:
            client.close()
