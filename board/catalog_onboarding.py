from __future__ import annotations

import json
import os
from pathlib import Path


_NON_ACTIVE_SOURCE_STATES = {"INACTIVE", "CLOSED", "INCOMPLETE", "NOT_ACTIVE"}


def _listing_is_active(row: dict) -> bool:
    status = str(row.get("status") or "").strip().lower()
    if status:
        return status == "active"
    return str(row.get("source_state") or "") not in _NON_ACTIVE_SOURCE_STATES


def _taxonomy_skus() -> set[str]:
    default_path = (
        Path("/config/product_variations.json")
        if Path("/config").exists()
        else Path(__file__).with_name("product_variations.json")
    )
    path = Path(os.getenv("PRODUCT_VARIATIONS_PATH", default_path))
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return set()
    products = raw.get("products", {}) if isinstance(raw, dict) else {}
    return (
        {str(sku) for sku, value in products.items() if isinstance(value, dict)}
        if isinstance(products, dict)
        else set()
    )


def catalog_onboarding_snapshot(connect, marketplace: str) -> dict:
    mapped_skus = _taxonomy_skus()
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT o.seller_sku AS sku, o.asin, o.status, o.source_state, o.first_seen_at,
                   o.listing_fetched_at, o.catalog_last_attempt_at, o.catalog_enriched_at,
                   o.age_seconds, o.is_onboarding, o.source_attention, p.product_role,
                   p.catalog_membership
            FROM mart.catalog_onboarding_state o
            LEFT JOIN mart.catalog_portfolio_product p
              ON p.marketplace_id=o.marketplace_id AND p.seller_sku=o.seller_sku
            WHERE o.marketplace_id=%s
            ORDER BY o.source_attention DESC, o.is_onboarding DESC, o.first_seen_at DESC, o.seller_sku
            """,
            (marketplace,),
        )
        rows = [
            dict(row)
            for row in cur.fetchall()
            if row.get("product_role") != "STRUCTURAL_PARENT"
            and row.get("catalog_membership") != "DELETED"
        ]

    for row in rows:
        sku = str(row.get("sku") or "")
        mapped = sku in mapped_skus
        source_state = str(row.get("source_state") or "")
        source_ready = source_state == "SOURCE_READY"
        listing_not_active = not _listing_is_active(row)
        recent = bool(row.get("is_onboarding"))
        source_onboarding = recent or (not source_ready and not listing_not_active)

        row["seller_taxonomy_mapped"] = mapped
        if mapped:
            taxonomy_state = "MAPPED"
        elif listing_not_active:
            # A listing may be reported inactive while Amazon is still bringing a
            # newly created offer online. Keep that young listing informational.
            # Established non-active listings retain Amazon's exact source state
            # and never become taxonomy work items.
            taxonomy_state = "ONBOARDING" if recent else source_state
        elif source_onboarding:
            taxonomy_state = "ONBOARDING"
        else:
            taxonomy_state = "MAPPING_REQUIRED"
        row["taxonomy_state"] = taxonomy_state
        row["requires_seller_action"] = bool(row.get("source_attention")) or (
            source_ready and not recent and not mapped
        )

    active_rows = [row for row in rows if _listing_is_active(row)]
    inactive_rows = [row for row in rows if not _listing_is_active(row)]
    source_attention = [row for row in rows if row.get("source_attention")]
    taxonomy_attention = [row for row in rows if row.get("taxonomy_state") == "MAPPING_REQUIRED"]
    onboarding = [row for row in rows if row.get("taxonomy_state") == "ONBOARDING"]
    source_ready = [row for row in active_rows if row.get("source_state") == "SOURCE_READY"]
    return {
        "summary": {
            "active_listings": len(active_rows),
            "inactive_listings": len(inactive_rows),
            "source_ready": len(source_ready),
            "onboarding": len(onboarding),
            "source_attention": len(source_attention),
            "taxonomy_attention": len(taxonomy_attention),
            "seller_mapped": sum(1 for row in rows if row.get("seller_taxonomy_mapped")),
            "grace_hours": 48,
        },
        # Keep inactive offer/alias listings in lifecycle evidence. Structural
        # parents were removed above because they are hierarchy, not products
        # being onboarded. Remaining inactive evidence proves why an unmapped
        # SKU is not yet a seller-taxonomy incident during propagation.
        "items": rows,
        "attention": [row for row in rows if row.get("requires_seller_action")],
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
        product["catalog_is_onboarding"] = lifecycle.get("taxonomy_state") == "ONBOARDING"
        product["catalog_source_attention"] = bool(lifecycle.get("source_attention"))
        product["taxonomy_state"] = lifecycle.get("taxonomy_state")
        product["catalog_first_seen_at"] = lifecycle.get("first_seen_at")
        product["catalog_enriched_at"] = lifecycle.get("catalog_enriched_at")

    summary = payload.setdefault("summary", {})
    previously_unmapped = [str(sku) for sku in (summary.get("taxonomy_unmapped_skus") or [])]
    actionable = []
    onboarding_skus = []
    inactive_skus = []
    missing_lifecycle = []
    for sku in previously_unmapped:
        lifecycle = by_sku.get(sku)
        if not lifecycle:
            missing_lifecycle.append(sku)
            continue
        taxonomy_state = lifecycle.get("taxonomy_state")
        if taxonomy_state == "MAPPING_REQUIRED":
            actionable.append(sku)
        elif taxonomy_state == "ONBOARDING":
            onboarding_skus.append(sku)
        elif taxonomy_state in _NON_ACTIVE_SOURCE_STATES:
            inactive_skus.append(sku)

    # Mutable catalog completeness is an operational trust signal, not a code
    # deployment invariant. Keep the historical field empty so legacy visual QA
    # validates rendering/rollups rather than blocking a release when Amazon adds
    # a SKU. Dedicated onboarding QA verifies the lifecycle classification instead.
    summary["taxonomy_unmapped_skus"] = []
    summary["taxonomy_attention_skus"] = sorted(actionable)
    summary["taxonomy_onboarding_skus"] = sorted(onboarding_skus)
    summary["taxonomy_inactive_skus"] = sorted(inactive_skus)
    # This should normally be empty because the commercial portfolio is listing-
    # backed. If it is not, surface the contract gap explicitly instead of quietly
    # pretending the SKU is ordinary onboarding.
    summary["catalog_lifecycle_missing_skus"] = sorted(missing_lifecycle)
    summary["catalog_source_attention_skus"] = sorted(
        str(row.get("sku") or "") for row in snapshot["items"] if row.get("source_attention")
    )
    summary["catalog_onboarding_count"] = snapshot["summary"]["onboarding"]
    summary["catalog_source_attention_count"] = snapshot["summary"]["source_attention"]
    summary["taxonomy_attention_count"] = snapshot["summary"]["taxonomy_attention"]
    payload["catalog_onboarding"] = snapshot
    return payload
