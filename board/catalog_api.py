from __future__ import annotations

import json
import os
from pathlib import Path
from statistics import median


def _one(cur, sql: str, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _all(cur, sql: str, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def _number(value):
    if isinstance(value, dict):
        value = value.get("unit_cogs", value.get("current"))
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None


def _product_costs() -> dict[str, float]:
    path = Path(os.getenv("PRODUCT_COSTS_PATH", Path(__file__).with_name("product_costs.json")))
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    values = raw.get("costs", {}) if isinstance(raw, dict) else {}
    if not isinstance(values, dict):
        return {}
    out = {}
    for sku, value in values.items():
        amount = _number(value)
        if amount is not None:
            out[str(sku)] = amount
    return out


def _is_active(row: dict) -> bool:
    return str(row.get("status") or "").strip().lower() != "inactive"


def _is_offer(row: dict) -> bool:
    return row.get("product_role") in {"SELLABLE_VARIATION", "SELLABLE_STANDALONE"}


def _commercial_state(row: dict, traffic_median: float, conversion_median: float) -> tuple[str, str]:
    role = row.get("product_role")
    if role == "STRUCTURAL_PARENT":
        return "STRUCTURAL_PARENT", "Variation container · not independently sellable"
    if role == "SELLER_SKU_ALIAS":
        owner = row.get("offer_owner_sku") or "canonical offer"
        return "SKU_ALIAS", f"Operational SKU alias · demand belongs to {owner}"
    if not _is_active(row):
        return "INACTIVE", "Listing is inactive"

    sales = float(row.get("sales_t28") or 0)
    units = float(row.get("units_t28") or 0)
    sessions = float(row.get("sessions_t28") or 0)
    cvr = row.get("conversion_t28_pct")
    cvr = float(cvr) if cvr is not None else None
    delta = row.get("sales_delta28_pct")
    delta = float(delta) if delta is not None else None
    action = str(row.get("inventory_action") or "")
    cover = row.get("days_cover_with_inbound")
    cover = float(cover) if cover is not None else None

    if action == "STOCKOUT" or (action == "PRODUCE" and units > 0):
        return "INVENTORY_RISK", f"Demand is active · {cover:.0f} days cover" if cover is not None else "Demand is active · stock is constrained"
    if sessions >= max(20.0, traffic_median * 1.15) and cvr is not None and conversion_median > 0 and cvr < conversion_median * 0.72:
        return "TRAFFIC_NOT_CONVERTING", "Traffic is healthy relative to the portfolio, conversion is weak"
    if sessions > 0 and sessions <= max(12.0, traffic_median * 0.65) and cvr is not None and conversion_median > 0 and cvr > conversion_median * 1.25 and units > 0:
        return "CONVERTS_NEEDS_TRAFFIC", "Conversion is strong; traffic is light relative to the portfolio"
    if sales <= 0 and sessions <= max(5.0, traffic_median * 0.25):
        return "DORMANT", "Active offer with little recent traffic or demand"
    if delta is not None and delta >= 20:
        return "ACCELERATING", "28-day sales are materially above the prior 28 days"
    if delta is not None and delta <= -20:
        return "DECLINING", "28-day sales are materially below the prior 28 days"
    if units > 0:
        return "HEALTHY", "Selling with no major funnel or availability exception"
    if sessions > 0:
        return "WATCH", "Receiving traffic but no recent units"
    return "DORMANT", "No meaningful recent demand signal"


def _family_rollup(rows: list[dict]) -> list[dict]:
    families: dict[str, dict] = {}
    for row in rows:
        key = str(row.get("family_asin") or row.get("asin") or row.get("sku"))
        family = families.setdefault(key, {
            "family_asin": key,
            "members": [],
            "aliases": [],
            "sales_t28": 0.0,
            "units_t28": 0,
            "orders_t28": 0,
            "sessions_t28": 0,
            "available": 0,
            "inbound": 0,
            "estimated_cogs_t28": 0.0,
            "cogs_known_units": 0,
            "sellable_count": 0,
            "active_sellable_count": 0,
        })
        role = row.get("product_role")
        if role == "STRUCTURAL_PARENT":
            family["parent"] = row
            continue
        if role == "SELLER_SKU_ALIAS":
            family["aliases"].append(row)
            continue
        if not _is_offer(row):
            continue
        family["members"].append(row)
        family["sellable_count"] += 1
        if _is_active(row):
            family["active_sellable_count"] += 1
        family["sales_t28"] += float(row.get("sales_t28") or 0)
        family["units_t28"] += int(row.get("units_t28") or 0)
        family["orders_t28"] += int(row.get("orders_t28") or 0)
        family["sessions_t28"] += int(row.get("sessions_t28") or 0)
        family["available"] += int(row.get("available") or 0)
        family["inbound"] += int(row.get("inbound") or 0)
        if row.get("estimated_cogs_t28") is not None:
            family["estimated_cogs_t28"] += float(row["estimated_cogs_t28"])
            family["cogs_known_units"] += int(row.get("units_t28") or 0)

    out = []
    priority = {"INVENTORY_RISK": 0, "TRAFFIC_NOT_CONVERTING": 1, "CONVERTS_NEEDS_TRAFFIC": 2, "DECLINING": 3, "ACCELERATING": 4, "WATCH": 5, "DORMANT": 6, "INACTIVE": 7, "HEALTHY": 8, "STRUCTURAL_PARENT": 9, "SKU_ALIAS": 10}
    for family in families.values():
        sellable = family["members"]
        candidates = sellable or ([family["parent"]] if family.get("parent") else family["aliases"])
        if not candidates:
            continue
        lead = max(candidates, key=lambda r: float(r.get("sales_t28") or 0))
        parent = family.get("parent")
        family["name"] = (parent or lead).get("product") or lead.get("sku")
        # Commercial-family imagery follows the best-selling sellable child. A
        # structural parent is a container and must not replace the child image.
        family["image_url"] = lead.get("image_url")
        family["image_source"] = lead.get("image_source")
        family["conversion_t28_pct"] = round(100.0 * family["units_t28"] / family["sessions_t28"], 2) if family["sessions_t28"] > 0 else None
        family["states"] = sorted({m.get("commercial_state") for m in sellable if m.get("commercial_state")}, key=lambda x: priority.get(x, 99))
        family["primary_state"] = family["states"][0] if family["states"] else "STRUCTURAL_PARENT"
        family["needs_attention"] = any(priority.get(s, 99) <= 3 for s in family["states"])
        family["members"] = sorted(family["members"], key=lambda r: (-float(r.get("sales_t28") or 0), str(r.get("sku") or "")))
        family["aliases"] = sorted(family["aliases"], key=lambda r: str(r.get("sku") or ""))
        out.append(family)
    return sorted(out, key=lambda f: (not f["needs_attention"], -f["sales_t28"], f["name"] or ""))


def catalog_payload(connect, decorate_products, marketplace: str) -> dict:
    with connect() as conn, conn.cursor() as cur:
        summary = _one(cur, """
            SELECT
              count(*)::int AS listing_records,
              count(*) FILTER (WHERE product_role IN ('SELLABLE_VARIATION','SELLABLE_STANDALONE'))::int AS sellable_offers,
              count(*) FILTER (WHERE product_role = 'STRUCTURAL_PARENT')::int AS structural_parents,
              count(*) FILTER (WHERE product_role = 'SELLER_SKU_ALIAS')::int AS sku_aliases,
              count(*) FILTER (WHERE product_role IN ('SELLABLE_VARIATION','SELLABLE_STANDALONE') AND lower(COALESCE(status,'')) <> 'inactive')::int AS active_sellable,
              count(*) FILTER (WHERE product_role IN ('SELLABLE_VARIATION','SELLABLE_STANDALONE') AND lower(COALESCE(status,'')) = 'inactive')::int AS inactive_sellable,
              count(DISTINCT family_asin)::int AS families,
              max(fetched_at) AS listings_fetched_at,
              max(traffic_through_date) AS traffic_through_date
            FROM mart.catalog_portfolio_product WHERE marketplace_id=%s
        """, (marketplace,))
        rows = _all(cur, """
            SELECT marketplace_id, seller_sku AS sku, asin, parent_asin, family_asin, product_role,
                   offer_rank, offer_owner_sku, is_offer_owner,
                   title AS product, image_url, image_source, price AS listing_price, status, fulfillment_channel,
                   open_date, fetched_at, available, inbound, days_cover_on_hand, days_cover_with_inbound,
                   inventory_action, sales_t28, units_t28, orders_t28, sessions_t28, page_views_t28,
                   conversion_t28_pct, sales_delta28_pct, sessions_delta28_pct, conversion_delta28_pp,
                   traffic_through_date, catalog_enriched
            FROM mart.catalog_portfolio_product
            WHERE marketplace_id=%s
            ORDER BY is_offer_owner DESC, sales_t28 DESC, seller_sku
        """, (marketplace,))
        local_clock = _one(cur, "SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'America/Mexico_City','HH24:MI') local_time")

    rows = decorate_products(rows)
    costs = _product_costs()
    active_offers = [r for r in rows if _is_offer(r) and _is_active(r)]
    traffic_values = [float(r.get("sessions_t28") or 0) for r in active_offers if float(r.get("sessions_t28") or 0) > 0]
    conversion_values = [float(r["conversion_t28_pct"]) for r in active_offers if r.get("conversion_t28_pct") is not None]
    traffic_median = median(traffic_values) if traffic_values else 0.0
    conversion_median = median(conversion_values) if conversion_values else 0.0

    for row in rows:
        sku = str(row.get("sku") or "")
        unit_cogs = costs.get(sku)
        row["unit_cogs"] = unit_cogs
        row["estimated_cogs_t28"] = round(unit_cogs * int(row.get("units_t28") or 0), 2) if unit_cogs is not None and _is_offer(row) else None
        state, explanation = _commercial_state(row, traffic_median, conversion_median)
        row["commercial_state"] = state
        row["commercial_explanation"] = explanation

    families = _family_rollup(rows)
    active = [r for r in rows if _is_offer(r) and _is_active(r)]
    attention = [r for r in active if r.get("commercial_state") in {"INVENTORY_RISK", "TRAFFIC_NOT_CONVERTING", "CONVERTS_NEEDS_TRAFFIC", "DECLINING"}]
    drivers = sorted(active, key=lambda r: float(r.get("sales_t28") or 0), reverse=True)
    summary.update({
        "selling_now": sum(1 for r in active if float(r.get("units_t28") or 0) > 0),
        "attention_count": len(attention),
        "traffic_median_t28": round(traffic_median, 1),
        "conversion_median_t28_pct": round(conversion_median, 2),
        "sales_t28": round(sum(float(r.get("sales_t28") or 0) for r in active), 2),
        "sessions_t28": sum(int(r.get("sessions_t28") or 0) for r in active),
        "units_t28": sum(int(r.get("units_t28") or 0) for r in active),
    })
    summary["conversion_t28_pct"] = round(100.0 * summary["units_t28"] / summary["sessions_t28"], 2) if summary["sessions_t28"] else None

    return {
        "summary": summary,
        "families": families,
        "products": rows,
        "attention": sorted(attention, key=lambda r: (-float(r.get("sales_t28") or 0), r.get("sku") or "")),
        "drivers": drivers[:5],
        "diagnostic_basis": {
            "period": "28D",
            "traffic_grain": "child ASIN from Data Kiosk; one canonical seller SKU owns each customer-facing offer",
            "traffic_median_t28": round(traffic_median, 1),
            "conversion_median_t28_pct": round(conversion_median, 2),
            "notes": "Commercial states are diagnostic signals, not causal claims. Structural parents and seller-SKU aliases are excluded from sellable demand metrics.",
        },
        "local_time": local_clock.get("local_time"),
    }
