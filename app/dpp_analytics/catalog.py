from __future__ import annotations

import json

from . import db
from .settings import settings
from .spapi import SpApiClient

SOURCE = "amazon_spapi"
JOB = "catalog_items_2022_04_01"


def _marketplace_group(groups: list[dict] | None) -> dict:
    for group in groups or []:
        if group.get("marketplaceId") == settings.marketplace_id:
            return group
    return (groups or [{}])[0] if groups else {}


def _title(item: dict) -> str | None:
    summary = _marketplace_group(item.get("summaries"))
    return summary.get("itemName") or summary.get("brand")


def _main_image(item: dict) -> dict:
    group = _marketplace_group(item.get("images"))
    images = group.get("images") or []
    for image in images:
        if image.get("variant") == "MAIN":
            return image
    return images[0] if images else {}


def _variation_theme(item: dict) -> tuple[str | None, list[str]]:
    group = _marketplace_group(item.get("relationships"))
    for relationship in group.get("relationships") or []:
        if str(relationship.get("type") or "").upper() != "VARIATION":
            continue
        theme = relationship.get("variationTheme") or {}
        return theme.get("theme"), [str(x) for x in (theme.get("attributes") or []) if x]
    return None, []


def _parent_asins(item: dict) -> list[str]:
    group = _marketplace_group(item.get("relationships"))
    parents: list[str] = []
    for relationship in group.get("relationships") or []:
        if str(relationship.get("type") or "").upper() != "VARIATION":
            continue
        parents.extend(
            str(value).strip()
            for value in (relationship.get("parentAsins") or [])
            if str(value).strip()
        )
    return list(dict.fromkeys(parents))


def _parent_asin(item: dict) -> str | None:
    parents = _parent_asins(item)
    return parents[0] if parents else None


def _child_asins(item: dict) -> list[str]:
    group = _marketplace_group(item.get("relationships"))
    children: list[str] = []
    for relationship in group.get("relationships") or []:
        if str(relationship.get("type") or "").upper() != "VARIATION":
            continue
        children.extend(
            str(value).strip()
            for value in (relationship.get("childAsins") or [])
            if str(value).strip()
        )
    return list(dict.fromkeys(children))


def _resolved_parent_relationships(items: list[dict]) -> dict[str, str | None]:
    """Resolve one Amazon-owned parent value for every returned Catalog item.

    Catalog Items may put variation evidence on the child (``parentAsins``),
    the parent (``childAsins``), or both. Resolve the complete response before
    touching ``core.sku`` so API item/batch order cannot decide parentage. A
    returned ASIN with no relationship resolves to ``None`` and therefore
    clears stale local evidence.
    """
    returned_asins: set[str] = set()
    evidence: dict[str, set[str]] = {}

    for item in items:
        asin = str(item.get("asin") or "").strip()
        if not asin:
            continue
        returned_asins.add(asin)

        for parent_asin in _parent_asins(item):
            if parent_asin == asin:
                raise RuntimeError(f"Amazon Catalog returned a self-parent relationship for {asin}")
            evidence.setdefault(asin, set()).add(parent_asin)

        for child_asin in _child_asins(item):
            if child_asin == asin:
                raise RuntimeError(f"Amazon Catalog returned a self-parent relationship for {asin}")
            evidence.setdefault(child_asin, set()).add(asin)

    conflicts = {
        child_asin: sorted(parent_asins)
        for child_asin, parent_asins in evidence.items()
        if len(parent_asins) > 1
    }
    if conflicts:
        detail = ", ".join(
            f"{child_asin}=>{'/'.join(parent_asins)}"
            for child_asin, parent_asins in sorted(conflicts.items())
        )
        raise RuntimeError(f"Amazon Catalog returned conflicting variation parents: {detail}")

    resolved_asins = returned_asins | set(evidence)
    return {
        asin: next(iter(evidence[asin])) if evidence.get(asin) else None
        for asin in sorted(resolved_asins)
    }


def ingest_catalog() -> dict[str, int]:
    with db.ingestion_run(SOURCE, JOB, {"marketplace": settings.marketplace_id}) as run:
        with db.connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT asin FROM (
                    SELECT asin FROM core.sku WHERE asin IS NOT NULL AND asin <> ''
                    UNION
                    SELECT parent_asin FROM core.sku
                    WHERE parent_asin IS NOT NULL AND parent_asin <> ''
                ) catalog_asins
                ORDER BY asin
                """
            )
            asins = [row["asin"] for row in cur.fetchall()]

        if not asins:
            return {"records_read": 0, "records_written": 0}

        client = SpApiClient()
        try:
            written = 0
            missing = 0
            relationship_items: list[dict] = []
            for start in range(0, len(asins), 20):
                batch = asins[start:start + 20]
                payload = client.get(
                    "/catalog/2022-04-01/items",
                    params={
                        "identifiers": ",".join(batch),
                        "identifiersType": "ASIN",
                        "marketplaceIds": settings.marketplace_id,
                        # Relationships provide Amazon's actual variation family and
                        # theme. Attributes provide the values for those dimensions.
                        # Keep both raw because seller-defined taxonomy can refine the
                        # commercial labels without losing Amazon source evidence.
                        "includedData": "attributes,images,productTypes,relationships,summaries",
                        "pageSize": min(20, len(batch)),
                    },
                )
                items = payload.get("items") or []
                relationship_items.extend(items)
                returned_asins = {str(item.get("asin")) for item in items if item.get("asin")}
                missing += len(set(batch) - returned_asins)
                run["records_read"] += len(items)
                with db.connect() as conn, conn.cursor() as cur:
                    # Attempt state belongs in ops. Never create a core.catalog_item
                    # placeholder for an ASIN Amazon did not return: existing marts
                    # correctly use catalog-item existence as evidence of enrichment.
                    cur.execute(
                        """
                        INSERT INTO ops.catalog_item_attempt(
                            marketplace_id, asin, last_attempt_at, last_returned_at
                        )
                        SELECT %s,
                               requested_asin,
                               now(),
                               CASE WHEN requested_asin = ANY(%s::text[]) THEN now() END
                        FROM unnest(%s::text[]) AS requested(requested_asin)
                        ON CONFLICT (marketplace_id, asin) DO UPDATE SET
                            last_attempt_at=now(),
                            last_returned_at=COALESCE(
                                EXCLUDED.last_returned_at,
                                ops.catalog_item_attempt.last_returned_at
                            )
                        """,
                        (settings.marketplace_id, list(returned_asins), batch),
                    )
                    for item in items:
                        asin = item.get("asin")
                        if not asin:
                            continue
                        image = _main_image(item)
                        variation_theme, variation_attributes = _variation_theme(item)
                        cur.execute(
                            """
                            INSERT INTO core.catalog_item(
                                marketplace_id, asin, title, image_url, image_width, image_height,
                                attributes, relationships, product_types,
                                variation_theme, variation_attributes,
                                catalog_last_attempt_at, catalog_enriched_at, updated_at
                            ) VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s::jsonb,%s,%s,now(),now(),now())
                            ON CONFLICT (marketplace_id, asin) DO UPDATE SET
                                title=EXCLUDED.title,
                                image_url=EXCLUDED.image_url,
                                image_width=EXCLUDED.image_width,
                                image_height=EXCLUDED.image_height,
                                attributes=EXCLUDED.attributes,
                                relationships=EXCLUDED.relationships,
                                product_types=EXCLUDED.product_types,
                                variation_theme=EXCLUDED.variation_theme,
                                variation_attributes=EXCLUDED.variation_attributes,
                                catalog_last_attempt_at=now(),
                                catalog_enriched_at=now(),
                                updated_at=now()
                            """,
                            (
                                settings.marketplace_id,
                                asin,
                                _title(item),
                                image.get("link"),
                                image.get("width"),
                                image.get("height"),
                                json.dumps(item.get("attributes") or {}, separators=(",", ":")),
                                json.dumps(item.get("relationships") or [], separators=(",", ":")),
                                json.dumps(item.get("productTypes") or [], separators=(",", ":")),
                                variation_theme,
                                variation_attributes,
                            ),
                        )
                        written += 1
                    conn.commit()

            parent_relationships = _resolved_parent_relationships(relationship_items)
            with db.connect() as conn, conn.cursor() as cur:
                for asin, parent_asin in parent_relationships.items():
                    cur.execute(
                        """
                        UPDATE core.sku
                        SET parent_asin=%s,updated_at=now()
                        WHERE marketplace_id=%s AND asin=%s
                          AND parent_asin IS DISTINCT FROM %s
                        """,
                        (parent_asin, settings.marketplace_id, asin, parent_asin),
                    )
                conn.commit()
            run["records_written"] = written
            return {
                "records_read": run["records_read"],
                "records_written": written,
                "requested_asins": len(asins),
                "missing_asins": missing,
                "relationships_resolved": len(parent_relationships),
            }
        finally:
            client.close()
