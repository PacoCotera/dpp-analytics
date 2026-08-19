from __future__ import annotations

import json

from .settings import settings
from .spapi import SpApiClient


# Orders v2026-01-01 currently exposes only a static sandbox. The static sandbox
# requires request arguments to match one of the x-amzn-api-sandbox examples in
# Amazon's published Swagger model exactly. This probe deliberately uses the JP
# example against the FE sandbox endpoint and NEVER writes the returned mock data
# to the DPP warehouse.
STATIC_ORDERS_ENDPOINT = "https://sandbox.sellingpartnerapi-fe.amazon.com"
STATIC_ORDERS_PATH = "/orders/2026-01-01/orders"
STATIC_ORDERS_PARAMS = {
    "createdAfter": "2024-12-25T00:00:00Z",
    "marketplaceIds": "A1VC38T7YXB528",
    "includedData": "BUYER,RECIPIENT,PROCEEDS,EXPENSE,PROMOTION,CANCELLATION,FULFILLMENT,PACKAGES",
}


def probe() -> dict[str, object]:
    if not settings.spapi_credentials_present:
        raise RuntimeError("SP-API credentials are not present")

    client = SpApiClient()
    try:
        # Token exchange is performed lazily by get(). A successful response here
        # therefore validates both the sandbox LWA credentials and an authenticated
        # SP-API request.
        payload = client.get(
            STATIC_ORDERS_PATH,
            params=STATIC_ORDERS_PARAMS,
            endpoint=STATIC_ORDERS_ENDPOINT,
        )
        orders = payload.get("orders") or []
        return {
            "environment": settings.spapi_environment,
            "token_exchange": "ok",
            "spapi_static_sandbox": "ok",
            "operation": "orders.searchOrders.v2026-01-01",
            "mock_orders": len(orders),
            "first_mock_order_id": orders[0].get("orderId") if orders else None,
        }
    finally:
        client.close()


def main() -> None:
    print(json.dumps(probe(), sort_keys=True))


if __name__ == "__main__":
    main()
