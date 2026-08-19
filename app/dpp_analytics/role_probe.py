from __future__ import annotations

import json

from . import db
from .settings import settings
from .spapi import SpApiClient, SpApiError


def _sample_identifiers() -> tuple[str | None, str | None]:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT sku, asin
            FROM core.sku
            WHERE active AND asin IS NOT NULL AND asin <> ''
            ORDER BY updated_at DESC NULLS LAST, sku
            LIMIT 1
            """
        )
        row = cur.fetchone() or {}
    return row.get("sku"), row.get("asin")


def probe() -> dict[str, object]:
    sku, asin = _sample_identifiers()
    if not sku or not asin:
        raise RuntimeError("No SKU/ASIN is available for catalog/pricing role probe")

    client = SpApiClient()
    checks: dict[str, object] = {}
    try:
        try:
            payload = client.get(
                f"/catalog/2022-04-01/items/{asin}",
                params={
                    "marketplaceIds": settings.marketplace_id,
                    "includedData": "images,summaries",
                },
            )
            images = payload.get("images") or []
            summaries = payload.get("summaries") or []
            checks["product_listing"] = {
                "status": "ok",
                "operation": "catalogItems.getCatalogItem.v2022-04-01",
                "asin": asin,
                "image_groups": len(images),
                "summary_groups": len(summaries),
            }
        except SpApiError as exc:
            checks["product_listing"] = {"status": "error", "error": str(exc)[:700]}

        try:
            payload = client.get(
                "/products/pricing/v0/price",
                params=[
                    ("MarketplaceId", settings.marketplace_id),
                    ("ItemType", "Sku"),
                    ("Skus", sku),
                    ("ItemCondition", "New"),
                ],
            )
            body = payload.get("payload") if isinstance(payload.get("payload"), list) else payload.get("payload")
            if isinstance(body, list):
                count = len(body)
            elif isinstance(payload, dict):
                count = len(payload.get("payload") or []) if isinstance(payload.get("payload"), list) else 0
            else:
                count = 0
            checks["pricing"] = {
                "status": "ok",
                "operation": "productPricing.getPricing.v0",
                "sku": sku,
                "result_count": count,
            }
        except SpApiError as exc:
            checks["pricing"] = {"status": "error", "error": str(exc)[:700]}
    finally:
        client.close()

    return {
        "marketplace": settings.marketplace_id,
        "checks": checks,
        "all_authorized": all(
            isinstance(v, dict) and v.get("status") == "ok" for v in checks.values()
        ),
    }


def main() -> None:
    result = probe()
    print(json.dumps(result, sort_keys=True))
    if not result["all_authorized"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
