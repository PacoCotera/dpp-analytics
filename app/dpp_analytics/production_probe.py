from __future__ import annotations

import datetime as dt
import json

from . import db
from .settings import settings
from .spapi import SpApiClient, SpApiError


def _iso(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _attempt(name: str, fn):
    try:
        payload = fn()
        return {"status": "ok", **payload}
    except SpApiError as exc:
        return {"status": "error", "error": str(exc)[:700]}
    except Exception as exc:
        return {"status": "error", "error": f"{type(exc).__name__}: {str(exc)[:700]}"}


def _json_value(value):
    if isinstance(value, (dt.datetime, dt.date)):
        return value.isoformat()
    return value


def probe() -> dict[str, object]:
    if not settings.is_production:
        raise RuntimeError(f"production probe refused in environment={settings.spapi_environment}")
    if not settings.spapi_credentials_present:
        raise RuntimeError("SP-API production credentials are not present")

    client = SpApiClient()
    try:
        now = dt.datetime.now(dt.timezone.utc)
        before = now - dt.timedelta(minutes=5)
        after = before - dt.timedelta(days=7)

        orders = _attempt(
            "orders",
            lambda: _orders_probe(client, after, before),
        )
        inventory = _attempt(
            "inventory",
            lambda: _inventory_probe(client),
        )
        finances = _attempt(
            "finances",
            lambda: _finances_probe(client, after, before),
        )
        data_kiosk = _attempt(
            "data_kiosk",
            lambda: _data_kiosk_probe(client),
        )
        warehouse = _attempt("warehouse", _warehouse_probe)

        checks = {
            "orders": orders,
            "inventory": inventory,
            "finances": finances,
            "data_kiosk": data_kiosk,
        }
        return {
            "environment": settings.spapi_environment,
            "endpoint": settings.spapi_endpoint,
            "marketplace": settings.marketplace_id,
            "production_ingestion_enabled": settings.production_ingestion_enabled,
            "checks": checks,
            "warehouse": warehouse,
            "all_authorized": all(v.get("status") == "ok" for v in checks.values()),
        }
    finally:
        client.close()


def _orders_probe(client: SpApiClient, after: dt.datetime, before: dt.datetime) -> dict[str, object]:
    # Request only the data sets our warehouse requires; intentionally no BUYER or
    # RECIPIENT PII. A 200 validates Orders access plus PROCEEDS/FULFILLMENT rights.
    payload = client.get(
        "/orders/2026-01-01/orders",
        params={
            "lastUpdatedAfter": _iso(after),
            "lastUpdatedBefore": _iso(before),
            "marketplaceIds": settings.marketplace_id,
            "maxResultsPerPage": 1,
            "includedData": "PROCEEDS,FULFILLMENT,PROMOTION",
        },
    )
    return {
        "operation": "orders.searchOrders.v2026-01-01",
        "sample_count": len(payload.get("orders") or []),
        "has_next_page": bool((payload.get("pagination") or {}).get("nextToken")),
    }


def _inventory_probe(client: SpApiClient) -> dict[str, object]:
    payload = client.get(
        "/fba/inventory/v1/summaries",
        params={
            "details": "true",
            "granularityType": "Marketplace",
            "granularityId": settings.marketplace_id,
            "marketplaceIds": settings.marketplace_id,
        },
    )
    body = payload.get("payload") if isinstance(payload.get("payload"), dict) else payload
    summaries = body.get("inventorySummaries") or []
    return {
        "operation": "fbaInventory.getInventorySummaries.v1",
        "summary_count": len(summaries),
    }


def _finances_probe(client: SpApiClient, after: dt.datetime, before: dt.datetime) -> dict[str, object]:
    payload = client.get(
        "/finances/2024-06-19/transactions",
        params={
            "postedAfter": _iso(after),
            "postedBefore": _iso(before),
            "marketplaceId": settings.marketplace_id,
        },
    )
    # Production responses can expose the transaction payload either directly or
    # under a payload object. Accept both shapes so the probe matches the collector.
    body = payload.get("payload") if isinstance(payload.get("payload"), dict) else payload
    transactions = body.get("transactions") or []
    next_token = body.get("nextToken") or payload.get("nextToken")
    return {
        "operation": "finances.listTransactions.v2024-06-19",
        "sample_count": len(transactions),
        "has_next_page": bool(next_token),
    }


def _data_kiosk_probe(client: SpApiClient) -> dict[str, object]:
    payload = client.get("/dataKiosk/2023-11-15/queries")
    body = payload.get("payload") if isinstance(payload.get("payload"), dict) else payload
    queries = body.get("queries") or []
    return {
        "operation": "dataKiosk.getQueries.v2023-11-15",
        "visible_query_count": len(queries),
    }


def _warehouse_probe() -> dict[str, object]:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                count(*) AS order_count,
                min(created_time) AS first_order,
                max(created_time) AS last_order
            FROM core.amazon_order
            """
        )
        orders = cur.fetchone()

        cur.execute("SELECT count(*) AS item_count FROM core.amazon_order_item")
        items = cur.fetchone()
        cur.execute("SELECT count(*) AS sku_count FROM core.sku")
        skus = cur.fetchone()
        cur.execute(
            """
            SELECT count(*) AS snapshot_count, max(snapshot_at) AS latest_snapshot
            FROM core.inventory_snapshot
            """
        )
        inventory = cur.fetchone()
        cur.execute(
            """
            SELECT cursor_value, updated_at
            FROM ops.ingestion_cursor
            WHERE source='amazon_spapi' AND job_name='orders_v2026' AND cursor_name='default'
            """
        )
        cursor = cur.fetchone()
        cur.execute(
            """
            SELECT status, records_read, records_written, started_at, finished_at, error_message
            FROM ops.ingestion_runs
            WHERE source='amazon_spapi' AND job_name='orders_v2026'
            ORDER BY started_at DESC
            LIMIT 1
            """
        )
        latest_orders_run = cur.fetchone()

    return {
        "orders": int(orders["order_count"] or 0),
        "order_items": int(items["item_count"] or 0),
        "skus": int(skus["sku_count"] or 0),
        "inventory_snapshots": int(inventory["snapshot_count"] or 0),
        "first_order": _json_value(orders["first_order"]),
        "last_order": _json_value(orders["last_order"]),
        "latest_inventory_snapshot": _json_value(inventory["latest_snapshot"]),
        "orders_cursor": cursor["cursor_value"] if cursor else None,
        "orders_cursor_updated_at": _json_value(cursor["updated_at"]) if cursor else None,
        "latest_orders_run": {
            key: _json_value(value)
            for key, value in (latest_orders_run or {}).items()
        },
    }


def main() -> None:
    result = probe()
    print(json.dumps(result, sort_keys=True))
    if not result["all_authorized"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
