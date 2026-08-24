from __future__ import annotations

import json
import os
from pathlib import Path


def _taxonomy_skus() -> set[str]:
    default_path = Path("/config/product_variations.json") if Path("/config").exists() else Path(__file__).with_name("product_variations.json")
    path = Path(os.getenv("PRODUCT_VARIATIONS_PATH", default_path))
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return set()
    products = raw.get("products", {}) if isinstance(raw, dict) else {}
    return {str(sku) for sku, value in products.items() if isinstance(value, dict)} if isinstance(products, dict) else set()


def catalog_onboarding_snapshot(connect, marketplace: str) -> dict:
    mapped_skus = _taxonomy_skus()
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT seller_sku AS sku, asin, source_state, first_seen_at,
                   listing_fetched_at, catalog_last_attempt_at, catalog_enriched_at,
                   age_seconds, is_onboarding, source_attention
            FROM mart.catalog_onboarding_state
            WHERE marketplace_id=%s
              AND lower(COALESCE(status,'')) <> 'inactive'
            ORDER BY source_attention DESC, is_onboarding DESC, first_seen_at DESC, seller_sku
            """,
            (marketplace,),
        )
        rows = [dict(row) for row in cur.fetchall()]

    for row in rows:
        sku = str(row.get("sku") or "")
        mapped = sku in mapped_skus
        source_ready = row.get("source_state") == "SOURCE_READY"
        onboarding = bool(row.get("is_onboarding")) or not source_ready
        row["seller_taxonomy_mapped"] = mapped
        row["taxonomy_state"] = (
            "MAPPED"
            if mapped
            else "ONBOARDING"
            if onboarding
            else "MAPPING_REQUIRED"
        )
        row["requires_seller_action"] = bool(row.get("source_attention")) or (
            source_ready and not onboarding and not mapped
        )

    source_attention = [row for row in rows if row.get("source_attention")]
    taxonomy_attention = [row for row in rows if row.get("taxonomy_state") == "MAPPING_REQUIRED"]
    onboarding = [row for row in rows if row.get("taxonomy_state") == "ONBOARDING"]
    source_ready = [row for row in rows if row.get("source_state") == "SOURCE_READY"]
    return {
        "summary": {
            "active_listings": len(rows),
            "source_ready": len(source_ready),
            "onboarding": len(onboarding),
            "source_attention": len(source_attention),
            "taxonomy_attention": len(taxonomy_attention),
            "seller_mapped": sum(1 for row in rows if row.get("seller_taxonomy_mapped")),
            "grace_hours": 48,
        },
        "items": rows,
        "attention": [
            row for row in rows if row.get("requires_seller_action")
        ],
    }


def apply_catalog_onboarding(payload: dict, connect, marketplace: str) -> dict:
    snapshot = catalog_onboarding_snapshot(connect, marketplace)
    by_sku = {str(row.get("sku") or ""): row for row in snapshot["items"]}

    for product in payload.get("products") or []:
        sku = str(product.get("sku") or "")
        lifecycle = by_sku.get(sku)
        if not lifecycle:
            continue
        product["catalog_source_state"] = lifecycle.get("source_state")
        product["catalog_is_onboarding"] = bool(lifecycle.get("is_onboarding")) or lifecycle.get("source_state") != "SOURCE_READY"
        product["catalog_source_attention"] = bool(lifecycle.get("source_attention"))
        product["taxonomy_state"] = lifecycle.get("taxonomy_state")
        product["catalog_first_seen_at"] = lifecycle.get("first_seen_at")
        product["catalog_enriched_at"] = lifecycle.get("catalog_enriched_at")

    summary = payload.setdefault("summary", {})
    previously_unmapped = [str(sku) for sku in (summary.get("taxonomy_unmapped_skus") or [])]
    actionable = []
    transient = []
    for sku in previously_unmapped:
        lifecycle = by_sku.get(sku)
        if lifecycle and lifecycle.get("taxonomy_state") == "MAPPING_REQUIRED":
            actionable.append(sku)
        else:
            transient.append(sku)

    # Keep the historical field as the seller-action list so existing deployment
    # QA still catches established taxonomy omissions, but not normal new-SKU
    # propagation. Transient/new items have their own explicit field.
    summary["taxonomy_unmapped_skus"] = sorted(actionable)
    summary["taxonomy_onboarding_skus"] = sorted(transient)
    summary["catalog_source_attention_skus"] = sorted(
        str(row.get("sku") or "") for row in snapshot["items"] if row.get("source_attention")
    )
    summary["catalog_onboarding_count"] = snapshot["summary"]["onboarding"]
    summary["catalog_source_attention_count"] = snapshot["summary"]["source_attention"]
    summary["taxonomy_attention_count"] = snapshot["summary"]["taxonomy_attention"]
    payload["catalog_onboarding"] = snapshot
    return payload
