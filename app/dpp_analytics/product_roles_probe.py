from __future__ import annotations

from . import db
from .settings import settings
from .spapi import SpApiClient


def probe() -> dict[str, object]:
    """Smoke-test Product Listing and Pricing roles against one owned catalog ASIN."""
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT asin FROM core.sku WHERE asin IS NOT NULL AND asin <> '' ORDER BY updated_at DESC LIMIT 1"
        )
        row = cur.fetchone()
    if not row:
        return {"status": "skipped", "reason": "no ASIN available"}

    asin = row["asin"]
    client = SpApiClient()
    try:
        catalog = client.get(
            f"/catalog/2022-04-01/items/{asin}",
            params={
                "marketplaceIds": settings.marketplace_id,
                "includedData": "images,summaries",
            },
        )
        pricing = client.post(
            "/batches/products/pricing/2022-05-01/items/competitiveSummary",
            json_body={
                "requests": [
                    {
                        "asin": asin,
                        "marketplaceId": settings.marketplace_id,
                        "includedData": ["featuredBuyingOptions", "referencePrices"],
                        "uri": "/products/pricing/2022-05-01/items/competitiveSummary",
                        "method": "GET",
                    }
                ]
            },
        )
        responses = pricing.get("responses") or []
        pricing_status = None
        if responses:
            pricing_status = (responses[0].get("status") or {}).get("statusCode")
        return {
            "status": "ok",
            "asin": asin,
            "catalog_has_images": bool(catalog.get("images")),
            "catalog_has_summary": bool(catalog.get("summaries")),
            "pricing_response_count": len(responses),
            "pricing_status": pricing_status,
        }
    finally:
        client.close()


if __name__ == "__main__":
    import json
    print(json.dumps(probe(), sort_keys=True))
