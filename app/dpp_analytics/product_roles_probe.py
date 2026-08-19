from __future__ import annotations

from . import db
from .settings import settings
from .spapi import SpApiClient


def probe() -> dict[str, object]:
    """Smoke-test Product Listing and Pricing independently against one owned ASIN."""
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT asin FROM core.sku WHERE asin IS NOT NULL AND asin <> '' ORDER BY updated_at DESC LIMIT 1"
        )
        row = cur.fetchone()
    if not row:
        return {"status": "skipped", "reason": "no ASIN available"}

    asin = row["asin"]
    result: dict[str, object] = {"asin": asin}
    client = SpApiClient()
    try:
        try:
            catalog = client.get(
                f"/catalog/2022-04-01/items/{asin}",
                params={
                    "marketplaceIds": settings.marketplace_id,
                    "includedData": "images,summaries",
                },
            )
            result["product_listing"] = {
                "status": "ok",
                "has_images": bool(catalog.get("images")),
                "has_summary": bool(catalog.get("summaries")),
            }
        except Exception as exc:
            result["product_listing"] = {"status": "error", "error": str(exc)[:500]}

        try:
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
            status_code = (responses[0].get("status") or {}).get("statusCode") if responses else None
            result["pricing"] = {
                "status": "ok" if status_code in (None, 200) else "response_error",
                "response_count": len(responses),
                "status_code": status_code,
            }
        except Exception as exc:
            result["pricing"] = {"status": "error", "error": str(exc)[:500]}

        result["status"] = (
            "ok"
            if all(isinstance(result.get(k), dict) and result[k].get("status") == "ok" for k in ("product_listing", "pricing"))
            else "partial"
        )
        return result
    finally:
        client.close()


if __name__ == "__main__":
    import json
    print(json.dumps(probe(), sort_keys=True))
