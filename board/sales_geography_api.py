from __future__ import annotations

import re
import unicodedata
from decimal import Decimal, ROUND_HALF_UP

from geo_reference import postal_dictionary


MONEY_QUANTUM = Decimal("0.01")


def _all(cur, sql: str, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def _postal(value: object) -> str:
    raw = str(value or "").strip()
    return raw.zfill(5) if raw.isdigit() and len(raw) <= 5 else raw


def _normalized_label(value: object) -> str:
    text = unicodedata.normalize("NFD", str(value or ""))
    text = "".join(character for character in text if unicodedata.category(character) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def _decimal(value: object) -> Decimal:
    return Decimal(str(value or 0))


def _canonicalize_rows(
    rows: list[dict],
    references: list[dict],
    *,
    dimensions: tuple[str, ...] = (),
) -> tuple[list[dict], dict]:
    """Resolve postal demand to SEPOMEX federal-entity keys before aggregation."""
    reference_by_postal = {
        _postal(item.get("postal_code")): item
        for item in references
        if item.get("postal_code") and item.get("state_code") and item.get("state_name")
    }
    grouped: dict[tuple, dict] = {}
    unresolved_orders = 0
    alias_resolved_orders = 0

    for source in rows:
        orders = int(source.get("orders") or 0)
        postal_code = _postal(source.get("postal_code"))
        reference = reference_by_postal.get(postal_code)
        if not reference:
            unresolved_orders += orders
            continue

        state_code = str(reference["state_code"]).strip().zfill(2)
        state_name = str(reference["state_name"]).strip()
        source_label = str(source.get("state_or_region") or "").strip()
        if _normalized_label(source_label) != _normalized_label(state_name):
            alias_resolved_orders += orders

        key = (
            source.get("business_date"),
            source.get("country_code"),
            state_code,
            postal_code,
            *(source.get(dimension) for dimension in dimensions),
        )
        item = grouped.setdefault(
            key,
            {
                "business_date": source.get("business_date"),
                "country_code": source.get("country_code"),
                "state_code": state_code,
                "state_name": state_name,
                "state_or_region": state_name,
                "postal_code": postal_code,
                **{dimension: source.get(dimension) for dimension in dimensions},
                "sales": Decimal("0"),
                "orders": 0,
                "units": 0,
            },
        )
        item["sales"] += _decimal(source.get("sales"))
        item["orders"] += orders
        item["units"] += int(source.get("units") or 0)

    canonical = []
    for item in grouped.values():
        item["sales"] = item["sales"].quantize(MONEY_QUANTUM, rounding=ROUND_HALF_UP)
        if not dimensions:
            item["aov"] = (
                (item["sales"] / item["orders"]).quantize(MONEY_QUANTUM, rounding=ROUND_HALF_UP)
                if item["orders"]
                else Decimal("0.00")
            )
        canonical.append(item)
    canonical.sort(
        key=lambda item: (
            item.get("business_date"),
            item.get("state_code"),
            item.get("postal_code"),
            *(str(item.get(dimension) or "") for dimension in dimensions),
        )
    )
    return canonical, {
        "resolved_orders": sum(int(item.get("orders") or 0) for item in canonical),
        "unresolved_orders": unresolved_orders,
        "alias_resolved_orders": alias_resolved_orders,
        "canonical_states": len({item["state_code"] for item in canonical}),
    }


def _canonical_coverage(
    coverage: dict,
    resolution: dict,
    canonical_rows: list[dict] | None = None,
) -> dict:
    result = dict(coverage)
    total_orders = int(result.get("orders_total") or 0)
    postal_orders = int(result.get("orders_with_postal") or 0)
    resolved_orders = int(resolution.get("resolved_orders") or 0)
    result["raw_state_labels"] = int(result.get("states", 0) or 0)
    result["canonical_states"] = int(resolution.get("canonical_states") or 0)
    result["states"] = result["canonical_states"]
    result["resolved_state_orders"] = resolved_orders
    result["unmapped_orders"] = max(0, total_orders - resolved_orders)
    result["unmapped_postal_orders"] = int(resolution.get("unresolved_orders") or 0)
    result["alias_resolved_orders"] = int(resolution.get("alias_resolved_orders") or 0)
    result["alias_resolution_pct"] = (
        round(100.0 * resolved_orders / postal_orders, 1) if postal_orders else None
    )
    result["alias_resolution_basis"] = "SEPOMEX postal code → federal entity"
    dates = sorted(
        {
            row.get("business_date")
            for row in canonical_rows or []
            if row.get("business_date") is not None
        }
    )
    result["geography_first_date"] = dates[0] if dates else None
    result["geography_last_date"] = dates[-1] if dates else None
    result["geography_date_basis"] = "resolved SEPOMEX postal-order history"
    return result


def _canonical_product_analysis(
    sku_daily: list[dict],
    current_products: list[dict],
    source_products: list[dict],
) -> tuple[list[dict], list[dict], dict]:
    """Attach historical order evidence to the current Amazon catalog identity.

    Current offer membership comes from the latest complete merchant-listings
    snapshot. Historical seller SKUs remain on each fact row as ``source_sku``;
    when their ASIN has a current canonical offer they roll into that offer's
    ``analysis_sku`` instead of becoming another product option.
    """
    current = []
    current_by_sku: dict[str, dict] = {}
    current_by_asin: dict[str, dict] = {}
    duplicate_current_asins: set[str] = set()
    for source in current_products:
        sku = str(source.get("sku") or "").strip()
        if not sku:
            continue
        item = {
            **source,
            "sku": sku,
            "analysis_sku": sku,
            "catalog_membership": "CURRENT_OFFER",
            "is_current_offer": True,
            "is_active_offer": str(source.get("status") or "").strip().lower() == "active",
        }
        current.append(item)
        current_by_sku[sku] = item
        asin = str(item.get("asin") or "").strip()
        if asin:
            if asin in current_by_asin:
                duplicate_current_asins.add(asin)
            else:
                current_by_asin[asin] = item
    for asin in duplicate_current_asins:
        current_by_asin.pop(asin, None)

    source_by_sku = {
        str(item.get("sku") or "").strip(): item
        for item in source_products
        if str(item.get("sku") or "").strip()
    }
    evidence_skus: dict[str, set[str]] = {item["sku"]: set() for item in current}
    historical_skus: set[str] = set()
    alias_skus: set[str] = set()
    for source_sku, source in source_by_sku.items():
        asin = str(source.get("asin") or "").strip()
        target = current_by_sku.get(source_sku) or (current_by_asin.get(asin) if asin else None)
        if not target:
            historical_skus.add(source_sku)
            continue
        evidence_skus[target["sku"]].add(source_sku)
        if source_sku != target["sku"]:
            alias_skus.add(source_sku)

    analyzed_rows = []
    for source in sku_daily:
        row = dict(source)
        source_sku = str(row.get("seller_sku") or "").strip()
        asin = str(row.get("asin") or "").strip()
        target = current_by_sku.get(source_sku)
        if target is None and asin:
            target = current_by_asin.get(asin)
        analysis_sku = target["sku"] if target else source_sku
        is_alias = bool(target and source_sku and source_sku != analysis_sku)
        row.update(
            {
                "source_sku": source_sku,
                "analysis_sku": analysis_sku,
                "is_alias": is_alias,
                "catalog_membership": "CURRENT_OFFER" if target else "HISTORICAL_RECORD",
                "is_current_offer": bool(target),
            }
        )
        analyzed_rows.append(row)
        if target:
            if source_sku:
                evidence_skus[analysis_sku].add(source_sku)
            if is_alias:
                alias_skus.add(source_sku)
        elif source_sku:
            historical_skus.add(source_sku)

    products = []
    for item in current:
        sources = evidence_skus.get(item["sku"], set())
        products.append({**item, "source_skus": sorted(sources)})

    for sku in sorted(historical_skus | set(source_by_sku)):
        source = source_by_sku.get(sku, {"sku": sku, "product": sku})
        asin = str(source.get("asin") or "").strip()
        if sku in current_by_sku or (asin and asin in current_by_asin):
            continue
        products.append(
            {
                **source,
                "sku": sku,
                "analysis_sku": sku,
                "product_role": "HISTORICAL_RECORD",
                "catalog_membership": "HISTORICAL_RECORD",
                "is_current_offer": False,
                "is_active_offer": False,
                "source_skus": [sku],
            }
        )

    contract = {
        "mode": "CANONICAL_PRODUCT",
        "current_offers": len(current),
        "active_current_offers": sum(bool(item["is_active_offer"]) for item in current),
        "historical_products": sum(not item["is_current_offer"] for item in products),
        "collapsed_alias_source_skus": len(alias_skus),
        "ambiguous_current_asins": sorted(duplicate_current_asins),
        "window_anchor": "geography.coverage.geography_last_date",
        "definition": (
            "Current Amazon seller-catalog offers own product identity; historical seller SKUs "
            "remain transaction history and aliases sharing a current offer ASIN roll into that "
            "offer's analysis_sku."
        ),
    }
    return analyzed_rows, products, contract


def sales_geography_payload(connect, decorate_products, marketplace: str) -> dict:
    """Return the Sales geography workspace payload only.

    Geography is intentionally separate from the default Sales snapshot because
    postal and SKU-postal history is comparatively large and only needed when the
    user opens the Geography workspace. The privacy boundary remains state/country/
    postal dimensions already reduced during Orders ingestion; no recipient PII is
    queried or returned here.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT min(s.business_date) AS first_date,max(s.business_date) AS last_date,
                   count(DISTINCT s.amazon_order_id)::bigint AS orders_total,
                   count(DISTINCT s.amazon_order_id) FILTER (
                     WHERE nullif(btrim(o.destination_postal_code),'') IS NOT NULL
                   )::bigint AS orders_with_postal,
                   count(DISTINCT nullif(btrim(o.destination_postal_code),''))::int AS postal_codes,
                   count(DISTINCT nullif(btrim(o.destination_state_or_region),''))::int AS states
            FROM mart.order_customer_spend s
            JOIN core.amazon_order o USING (marketplace_id,amazon_order_id)
            WHERE s.marketplace_id=%s
            """,
            (marketplace,),
        )
        coverage = cur.fetchone() or {}
        total_orders = int(coverage.get("orders_total") or 0)
        geocoded_orders = int(coverage.get("orders_with_postal") or 0)
        coverage["coverage_pct"] = (
            round(100.0 * geocoded_orders / total_orders, 1) if total_orders else None
        )
        coverage["status"] = "ready" if geocoded_orders else "backfill_pending"
        coverage["source"] = "Orders v2026 RECIPIENT · state/country/postal only"
        coverage["privacy"] = (
            "No recipient name, street address, city, phone or recipient payload retained"
        )

        daily = _all(
            cur,
            """
            SELECT business_date,country_code,state_or_region,postal_code,sales,orders,units,aov
            FROM mart.order_geography_postal_daily
            WHERE marketplace_id=%s
            ORDER BY business_date,state_or_region,postal_code
            """,
            (marketplace,),
        )
        sku_daily = _all(
            cur,
            """
            SELECT business_date,country_code,state_or_region,postal_code,seller_sku,asin,sales,orders,units
            FROM mart.order_geography_postal_sku_daily
            WHERE marketplace_id=%s
            ORDER BY business_date,state_or_region,postal_code,seller_sku
            """,
            (marketplace,),
        )
        source_products = _all(
            cur,
            """
            SELECT DISTINCT g.seller_sku AS sku,COALESCE(g.asin,s.asin) AS asin,
                   COALESCE(sl.item_name,ci.title,s.title,g.seller_sku) AS product,
                   COALESCE(sl.image_url,ci.image_url) AS image_url
            FROM mart.order_geography_postal_sku_daily g
            LEFT JOIN core.sku s ON s.sku=g.seller_sku
            LEFT JOIN core.seller_listing sl
              ON sl.marketplace_id=g.marketplace_id AND sl.seller_sku=g.seller_sku
            LEFT JOIN core.catalog_item ci
              ON ci.marketplace_id=g.marketplace_id AND ci.asin=COALESCE(g.asin,s.asin)
            WHERE g.marketplace_id=%s
            ORDER BY g.seller_sku
            """,
            (marketplace,),
        )
        current_products = _all(
            cur,
            """
            SELECT p.seller_sku AS sku,p.asin,p.parent_asin,p.family_asin,p.product_role,
                   p.title AS product,p.image_url,p.status,p.catalog_membership
            FROM mart.catalog_portfolio_product p
            WHERE p.marketplace_id=%s
              AND p.is_offer_owner
              AND p.product_role IN ('SELLABLE_VARIATION','SELLABLE_STANDALONE')
              AND p.catalog_membership='CURRENT_OFFER'
            ORDER BY p.seller_sku
            """,
            (marketplace,),
        )

    codes = {
        str(row.get("postal_code") or "").strip().zfill(5)
        for row in daily
        if row.get("postal_code")
    }
    references = postal_dictionary(codes)
    daily, resolution = _canonicalize_rows(daily, references)
    sku_daily, _ = _canonicalize_rows(
        sku_daily,
        references,
        dimensions=("seller_sku", "asin"),
    )
    sku_daily, products, product_analysis = _canonical_product_analysis(
        sku_daily,
        decorate_products(current_products),
        decorate_products(source_products),
    )
    coverage = _canonical_coverage(coverage, resolution, daily)
    return {
        "geography": {
            "coverage": coverage,
            "daily": daily,
            "sku_daily": sku_daily,
            "products": products,
            "product_analysis": product_analysis,
            "postal_reference": references,
            "reference_source": "SEPOMEX textual catalog · open-mexico db_postal v1.2.0",
        }
    }
