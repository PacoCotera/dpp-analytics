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


def ingest_catalog() -> dict[str, int]:
    with db.ingestion_run(SOURCE, JOB, {"marketplace": settings.marketplace_id}) as run:
        with db.connect() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT DISTINCT asin FROM core.sku WHERE asin IS NOT NULL AND asin <> '' ORDER BY asin"
            )
            asins = [row["asin"] for row in cur.fetchall()]

        if not asins:
            return {"records_read": 0, "records_written": 0}

        client = SpApiClient()
        try:
            written = 0
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
                run["records_read"] += len(items)
                with db.connect() as conn, conn.cursor() as cur:
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
                                variation_theme, variation_attributes, updated_at
                            ) VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s::jsonb,%s,%s,now())
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
            run["records_written"] = written
            return {"records_read": run["records_read"], "records_written": written}
        finally:
            client.close()
