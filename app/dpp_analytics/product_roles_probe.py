from __future__ import annotations

from . import db
from .settings import settings
from .spapi import SpApiClient


def _marketplace_group(groups: list[dict] | None) -> dict:
    for group in groups or []:
        if group.get("marketplaceId") == settings.marketplace_id:
            return group
    return (groups or [{}])[0] if groups else {}


def _variation_evidence(catalog: dict) -> dict[str, object]:
    relation_group = _marketplace_group(catalog.get("relationships"))
    relationships = relation_group.get("relationships") or []
    variation = next((r for r in relationships if str(r.get("type") or "").upper() == "VARIATION"), {})
    theme = variation.get("variationTheme") or {}
    attribute_names = [str(x) for x in (theme.get("attributes") or []) if x]
    attrs = catalog.get("attributes") or {}
    values: dict[str, list[str]] = {}
    for name in attribute_names:
        raw = attrs.get(name)
        if not isinstance(raw, list):
            continue
        found = []
        for item in raw:
            if isinstance(item, dict):
                value = item.get("value")
                if value not in (None, ""):
                    found.append(str(value))
        if found:
            values[name] = sorted(set(found))[:8]
    return {
        "relationship_count": len(relationships),
        "parent_asins": variation.get("parentAsins") or [],
        "child_asins_count": len(variation.get("childAsins") or []),
        "variation_theme": theme.get("theme"),
        "variation_attributes": attribute_names,
        "variation_values": values,
    }


def probe() -> dict[str, object]:
    """Smoke-test Catalog/Listing semantics and Pricing against one owned ASIN."""
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
                    "includedData": "attributes,images,productTypes,relationships,summaries",
                },
            )
            result["product_listing"] = {
                "status": "ok",
                "has_images": bool(catalog.get("images")),
                "has_summary": bool(catalog.get("summaries")),
                "has_attributes": bool(catalog.get("attributes")),
                **_variation_evidence(catalog),
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
