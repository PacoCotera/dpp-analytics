from __future__ import annotations

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
                        "includedData": "images,summaries",
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
                        cur.execute(
                            """
                            INSERT INTO core.catalog_item(
                                marketplace_id, asin, title, image_url, image_width, image_height, updated_at
                            ) VALUES (%s,%s,%s,%s,%s,%s,now())
                            ON CONFLICT (marketplace_id, asin) DO UPDATE SET
                                title=EXCLUDED.title,
                                image_url=EXCLUDED.image_url,
                                image_width=EXCLUDED.image_width,
                                image_height=EXCLUDED.image_height,
                                updated_at=now()
                            """,
                            (
                                settings.marketplace_id,
                                asin,
                                _title(item),
                                image.get("link"),
                                image.get("width"),
                                image.get("height"),
                            ),
                        )
                        written += 1
                    conn.commit()
            run["records_written"] = written
            return {"records_read": run["records_read"], "records_written": written}
        finally:
            client.close()
