from __future__ import annotations

import json
import os
from itertools import combinations
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


_DEFAULT_DIMENSION_MAP = {
    "color": "design",
    "color_name": "design",
    "style": "ruling",
    "style_name": "ruling",
}


def _product_taxonomy() -> dict:
    """Seller-owned taxonomy layered over Amazon variation evidence.

    The host override lives in the already-mounted board config directory by
    default. It is optional: Amazon remains the identity source, while this
    file can rename dimensions/values or fix one known listing anomaly without
    putting seller-specific mappings in Git.
    """
    default_path = Path("/config/product_variations.json") if Path("/config").exists() else Path(__file__).with_name("product_variations.json")
    path = Path(os.getenv("PRODUCT_VARIATIONS_PATH", default_path))
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        raw = {}
    if not isinstance(raw, dict):
        raw = {}

    dimension_map = dict(_DEFAULT_DIMENSION_MAP)
    configured_map = raw.get("dimension_map", {})
    if isinstance(configured_map, dict):
        for source, target in configured_map.items():
            source_key = str(source).strip().lower()
            target_key = str(target).strip().lower()
            if source_key and target_key:
                dimension_map[source_key] = target_key

    value_map: dict[str, dict[str, str]] = {}
    configured_values = raw.get("value_map", {})
    if isinstance(configured_values, dict):
        for dimension, values in configured_values.items():
            if not isinstance(values, dict):
                continue
            dimension_key = str(dimension).strip().lower()
            if not dimension_key:
                continue
            value_map[dimension_key] = {
                str(source).strip(): str(target).strip()
                for source, target in values.items()
                if str(source).strip() and str(target).strip()
            }

    products = {}
    configured_products = raw.get("products", {})
    if isinstance(configured_products, dict):
        for sku, value in configured_products.items():
            if not isinstance(value, dict):
                continue
            attrs = value.get("attributes", {})
            attrs = {
                str(k).strip().lower(): str(v).strip()
                for k, v in attrs.items()
                if str(k).strip() and str(v).strip()
            } if isinstance(attrs, dict) else {}
            products[str(sku)] = {
                "family_name": str(value.get("family_name") or "").strip() or None,
                "attributes": attrs,
            }

    return {
        "products": products,
        "dimension_map": dimension_map,
        "value_map": value_map,
        "source_path": str(path),
        "configured": bool(products or configured_map or configured_values),
    }


def _attribute_value(attributes: dict, attribute: str):
    if not isinstance(attributes, dict):
        return None
    candidates = [attribute, attribute.lower(), attribute.upper()]
    low = attribute.lower()
    if low.endswith("_name"):
        candidates.append(low[:-5])
    for key in candidates:
        if key not in attributes:
            continue
        value = attributes.get(key)
        values = value if isinstance(value, list) else [value]
        for item in values:
            if isinstance(item, dict):
                for field in ("value", "displayValue", "name"):
                    raw = item.get(field)
                    if raw not in (None, ""):
                        return str(raw).strip()
            elif item not in (None, ""):
                return str(item).strip()
    return None


def _normalize_dimension(source: str, dimension_map: dict[str, str]) -> str:
    key = str(source or "").strip().lower()
    if not key:
        return ""
    return dimension_map.get(key, key.removesuffix("_name"))


def _amazon_variation_attributes(row: dict, taxonomy: dict) -> dict[str, str]:
    names = row.get("amazon_variation_attribute_names") or []
    if isinstance(names, str):
        names = [names]
    attributes = row.get("catalog_attributes") or {}
    if isinstance(attributes, str):
        try:
            attributes = json.loads(attributes)
        except json.JSONDecodeError:
            attributes = {}
    out = {}
    for source_name in names if isinstance(names, (list, tuple)) else []:
        value = _attribute_value(attributes, str(source_name))
        if not value:
            continue
        dimension = _normalize_dimension(str(source_name), taxonomy["dimension_map"])
        if dimension:
            value = taxonomy["value_map"].get(dimension, {}).get(value, value)
            out[dimension] = value
    return out


def _variation_taxonomy_for_row(row: dict, taxonomy: dict) -> tuple[dict[str, str], str]:
    amazon = _amazon_variation_attributes(row, taxonomy)
    local = taxonomy["products"].get(str(row.get("sku") or ""), {}).get("attributes") or {}
    normalized_local = {}
    for source, value in local.items():
        dimension = _normalize_dimension(source, taxonomy["dimension_map"])
        if not dimension:
            continue
        normalized_local[dimension] = taxonomy["value_map"].get(dimension, {}).get(value, value)
    merged = dict(amazon)
    merged.update(normalized_local)
    if amazon and normalized_local:
        source = "AMAZON_CATALOG+SELLER_OVERRIDE"
    elif normalized_local:
        source = "SELLER_OVERRIDE"
    elif amazon:
        source = "AMAZON_CATALOG"
    else:
        source = "UNAVAILABLE"
    return merged, source


def _repair_variation_taxonomy(rows: list[dict]) -> list[dict]:
    """Repair only high-confidence cross-dimension collisions.

    Amazon listing metadata can occasionally put the same value into two
    dimensions for one child. We do not silently invent taxonomy. A collision
    is repairable only when:
      1) the value is established in one dimension on more offers than the
         competing dimension, and
      2) the displaced dimension has exactly one already-observed value that
         appears verbatim in that product's title/label.

    Otherwise the questionable assignment is removed from dimensional rollups
    and exposed as a warning for a seller override.
    """
    offers = [r for r in rows if _is_offer(r)]
    counts: dict[str, dict[str, int]] = {}
    canonical: dict[str, dict[str, str]] = {}
    for row in offers:
        for dimension, value in (row.get("variation_attributes") or {}).items():
            d, text = str(dimension), str(value).strip()
            if not text:
                continue
            key = text.casefold()
            counts.setdefault(d, {})[key] = counts.setdefault(d, {}).get(key, 0) + 1
            canonical.setdefault(d, {})[key] = text

    warnings = []
    for row in offers:
        attrs = dict(row.get("variation_attributes") or {})
        by_value: dict[str, list[str]] = {}
        for dimension, value in attrs.items():
            by_value.setdefault(str(value).strip().casefold(), []).append(str(dimension))
        row_warnings = []
        for value_key, dimensions in by_value.items():
            if len(dimensions) < 2:
                continue
            ranked = sorted(dimensions, key=lambda d: counts.get(d, {}).get(value_key, 0), reverse=True)
            keeper = ranked[0]
            keeper_count = counts.get(keeper, {}).get(value_key, 0)
            for displaced in ranked[1:]:
                displaced_count = counts.get(displaced, {}).get(value_key, 0)
                if keeper_count <= displaced_count:
                    row_warnings.append(f"ambiguous value '{attrs.get(displaced)}' appears in both {keeper} and {displaced}")
                    continue
                bad_value = attrs.pop(displaced, None)
                title = str(row.get("product") or "").casefold()
                candidates = []
                for candidate_key, candidate_text in canonical.get(displaced, {}).items():
                    if candidate_key == value_key:
                        continue
                    if candidate_key and candidate_key in title:
                        candidates.append(candidate_text)
                candidates = sorted(set(candidates), key=len, reverse=True)
                if len(candidates) == 1:
                    attrs[displaced] = candidates[0]
                    row["variation_attribute_source"] = f"{row.get('variation_attribute_source') or 'AMAZON_CATALOG'}+TITLE_REPAIR"
                    row_warnings.append(f"repaired {displaced}: Amazon '{bad_value}' → '{candidates[0]}' from an observed sibling value present in the product title")
                else:
                    row_warnings.append(f"removed inconsistent {displaced}='{bad_value}'; seller override recommended")
        row["variation_attributes"] = attrs
        row["variation_taxonomy_warnings"] = row_warnings
        if row_warnings:
            warnings.append({"sku": row.get("sku"), "asin": row.get("asin"), "warnings": row_warnings})
    return warnings


def _is_active(row: dict) -> bool:
    return str(row.get("status") or "").strip().lower() != "inactive"


def _is_offer(row: dict) -> bool:
    return row.get("product_role") in {"SELLABLE_VARIATION", "SELLABLE_STANDALONE"}


def _apply_canonical_identity(row: dict) -> dict:
    """Attach one role/relationship identity derived from the canonical portfolio row."""
    role = str(row.get("product_role") or "").strip()
    asin = str(row.get("asin") or "").strip() or None
    parent_asin = str(row.get("parent_asin") or "").strip() or None
    family_asin = str(row.get("family_asin") or "").strip() or None

    # Amazon sometimes echoes an offer's own ASIN as its parent. The canonical
    # portfolio role already treats that evidence as standalone; normalize the
    # public relationship while retaining the source value for auditability.
    if role == "SELLABLE_STANDALONE" and parent_asin == asin:
        row["source_parent_asin"] = parent_asin
        parent_asin = None
        row["parent_asin"] = None

    conflicts = []
    if role == "SELLABLE_VARIATION":
        kind = "CHILD_VARIATION"
        family_label = row.get("family_name") or "Variation family"
        if not parent_asin or parent_asin == asin:
            conflicts.append("child variation requires a distinct parent ASIN")
        if not family_asin or family_asin != parent_asin:
            conflicts.append("child variation family ASIN must equal parent ASIN")
    elif role == "SELLABLE_STANDALONE":
        kind = "STANDALONE_OFFER"
        family_label = row.get("family_name") or "Standalone product"
        if parent_asin:
            conflicts.append("standalone offer cannot carry a distinct parent ASIN")
        if not asin or family_asin != asin:
            conflicts.append("standalone family ASIN must equal offer ASIN")
    elif role == "STRUCTURAL_PARENT":
        kind = "VARIATION_CONTAINER"
        family_label = row.get("family_name") or row.get("product") or "Variation family"
    elif role == "SELLER_SKU_ALIAS":
        kind = "OFFER_ALIAS"
        family_label = row.get("family_name") or "SKU alias"
    else:
        kind = "UNKNOWN"
        family_label = row.get("family_name") or "Identity unavailable"
        conflicts.append("unknown product role")

    if not asin:
        conflicts.append("identity requires an ASIN")
    row["identity"] = {
        "kind": kind,
        "role": role,
        "family_label": str(family_label),
        "asin": asin,
        "parent_asin": parent_asin,
        "family_asin": family_asin,
        "is_sellable": role in {"SELLABLE_VARIATION", "SELLABLE_STANDALONE"},
        "consistent": not conflicts,
        "conflicts": conflicts,
    }
    return row


def _identity_violations(rows: list[dict]) -> list[dict]:
    violations = []
    for row in rows:
        if not _is_offer(row):
            continue
        identity = row.get("identity") or {}
        conflicts = list(identity.get("conflicts") or [])
        if not identity.get("consistent") or conflicts:
            violations.append(
                {
                    "sku": row.get("sku"),
                    "asin": row.get("asin"),
                    "role": row.get("product_role"),
                    "conflicts": conflicts or ["canonical identity missing"],
                }
            )
    return violations


def _commercial_state(row: dict, traffic_median: float, conversion_median: float) -> tuple[str, str]:
    role = row.get("product_role")
    if role == "STRUCTURAL_PARENT":
        return "STRUCTURAL_PARENT", "Variation container · family metrics come from sellable children"
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
    if sessions <= max(5.0, traffic_median * 0.25) and sales <= 0:
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


def _family_state(family: dict, traffic_median: float, conversion_median: float) -> tuple[str, str]:
    members = family.get("members") or []
    if not members:
        return "STRUCTURAL_PARENT", "Variation family container · no sellable child facts available"
    if int(family.get("active_sellable_count") or 0) <= 0:
        return "INACTIVE", "No active sellable variations"
    units = float(family.get("units_t28") or 0)
    sessions = float(family.get("sessions_t28") or 0)
    cvr = family.get("conversion_t28_pct")
    cvr = float(cvr) if cvr is not None else None
    stock = int(family.get("available") or 0) + int(family.get("inbound") or 0)
    active = [m for m in members if _is_active(m)]
    constrained = [m for m in active if m.get("commercial_state") == "INVENTORY_RISK"]
    if constrained:
        return "INVENTORY_RISK", f"{len(constrained)} sellable variation{'s' if len(constrained) != 1 else ''} at inventory risk"
    if sessions >= max(20.0, traffic_median * 1.15) and cvr is not None and conversion_median > 0 and cvr < conversion_median * 0.72:
        return "TRAFFIC_NOT_CONVERTING", "Family traffic is healthy relative to the portfolio; rolled-up conversion is weak"
    if sessions > 0 and sessions <= max(12.0, traffic_median * 0.65) and cvr is not None and conversion_median > 0 and cvr > conversion_median * 1.25 and units > 0:
        return "CONVERTS_NEEDS_TRAFFIC", "Family conversion is strong; rolled-up traffic is light relative to the portfolio"
    if units > 0:
        selling = sum(1 for m in active if float(m.get("units_t28") or 0) > 0)
        return "HEALTHY", f"Selling across {selling} variation{'s' if selling != 1 else ''} · {stock} units available/inbound"
    if sessions > 0:
        return "WATCH", "Family is receiving traffic but has no recent units"
    return "DORMANT", "Active family with no meaningful recent demand signal"


def _pooled_days_cover(available, inbound, units_t28):
    """Return 28-day pooled cover from the same operands shown for a family.

    Zero or unavailable velocity has no finite cover value.  A child with zero
    velocity still contributes its stock to the family pool when other children
    are selling; child-level inventory risk remains a separate family signal.
    """
    units = float(units_t28 or 0)
    if units <= 0:
        return None
    stock = float(available or 0) + float(inbound or 0)
    return round(stock / (units / 28.0), 1)


def _rollup_bucket(bucket: dict, row: dict):
    bucket["sales_t28"] += float(row.get("sales_t28") or 0)
    bucket["units_t28"] += int(row.get("units_t28") or 0)
    bucket["orders_t28"] += int(row.get("orders_t28") or 0)
    bucket["sessions_t28"] += int(row.get("sessions_t28") or 0)
    bucket["available"] += int(row.get("available") or 0)
    bucket["inbound"] += int(row.get("inbound") or 0)
    bucket["sku_count"] += 1
    bucket["active_sku_count"] += int(_is_active(row))
    bucket["family_asins"].add(str(row.get("family_asin") or row.get("asin") or ""))
    if row.get("estimated_cogs_t28") is not None:
        bucket["estimated_cogs_t28"] += float(row["estimated_cogs_t28"])
        bucket["known_cogs_units"] += int(row.get("units_t28") or 0)


def _new_dimension_bucket(**identity):
    return {
        **identity,
        "sales_t28": 0.0, "units_t28": 0, "orders_t28": 0, "sessions_t28": 0,
        "available": 0, "inbound": 0, "estimated_cogs_t28": 0.0,
        "known_cogs_units": 0, "sku_count": 0, "family_asins": set(), "active_sku_count": 0,
    }


def _finish_bucket(bucket: dict) -> dict:
    bucket["family_count"] = len({x for x in bucket.pop("family_asins") if x})
    bucket["conversion_t28_pct"] = round(100.0 * bucket["units_t28"] / bucket["sessions_t28"], 2) if bucket["sessions_t28"] else None
    bucket["estimated_cogs_t28"] = round(bucket["estimated_cogs_t28"], 2) if bucket["known_cogs_units"] else None
    bucket["sales_t28"] = round(bucket["sales_t28"], 2)
    return bucket


def _dimension_rollups(rows: list[dict]) -> dict[str, list[dict]]:
    grouped: dict[str, dict[str, dict]] = {}
    for row in rows:
        if not _is_offer(row):
            continue
        attrs = row.get("variation_attributes") or {}
        if not isinstance(attrs, dict):
            continue
        for dimension, value in attrs.items():
            bucket = grouped.setdefault(str(dimension), {}).setdefault(str(value), _new_dimension_bucket(dimension=str(dimension), value=str(value)))
            _rollup_bucket(bucket, row)
    return {
        dimension: sorted((_finish_bucket(bucket) for bucket in values.values()), key=lambda x: (-x["sales_t28"], x["value"]))
        for dimension, values in grouped.items()
    }


def _dimension_pair_rollups(rows: list[dict]) -> list[dict]:
    grouped: dict[tuple[str, str, str, str], dict] = {}
    for row in rows:
        if not _is_offer(row):
            continue
        attrs = row.get("variation_attributes") or {}
        if not isinstance(attrs, dict) or len(attrs) < 2:
            continue
        for left, right in combinations(sorted(attrs), 2):
            key = (left, str(attrs[left]), right, str(attrs[right]))
            bucket = grouped.setdefault(key, _new_dimension_bucket(dimensions=[left, right], values={left: str(attrs[left]), right: str(attrs[right])}, label=f"{attrs[left]} · {attrs[right]}"))
            _rollup_bucket(bucket, row)
    return sorted((_finish_bucket(bucket) for bucket in grouped.values()), key=lambda x: (-x["sales_t28"], x["label"]))


def _family_rollup(rows: list[dict], traffic_median: float, conversion_median: float) -> list[dict]:
    families: dict[str, dict] = {}
    for row in rows:
        key = str(row.get("family_asin") or row.get("asin") or row.get("sku"))
        family = families.setdefault(key, {"family_asin": key, "members": [], "aliases": [], "sales_t28": 0.0, "units_t28": 0, "orders_t28": 0, "sessions_t28": 0, "available": 0, "inbound": 0, "estimated_cogs_t28": 0.0, "cogs_known_units": 0, "sellable_count": 0, "active_sellable_count": 0, "ad_spend_t28": 0.0, "ad_attributed_sales_t28": 0.0, "ad_impressions_t28": 0, "ad_clicks_t28": 0, "ad_observed_days": 0, "ad_mature_days": 0, "variation_dimensions": {}})
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
        if _is_active(row): family["active_sellable_count"] += 1
        family["sales_t28"] += float(row.get("sales_t28") or 0)
        family["units_t28"] += int(row.get("units_t28") or 0)
        family["orders_t28"] += int(row.get("orders_t28") or 0)
        family["sessions_t28"] += int(row.get("sessions_t28") or 0)
        family["available"] += int(row.get("available") or 0)
        family["inbound"] += int(row.get("inbound") or 0)
        family["ad_spend_t28"] += float(row.get("ad_spend_t28") or 0)
        family["ad_attributed_sales_t28"] += float(row.get("ad_attributed_sales_t28") or 0)
        family["ad_impressions_t28"] += int(row.get("ad_impressions_t28") or 0)
        family["ad_clicks_t28"] += int(row.get("ad_clicks_t28") or 0)
        family["ad_observed_days"] = max(family["ad_observed_days"], int(row.get("ad_observed_days") or 0))
        family["ad_mature_days"] = max(family["ad_mature_days"], int(row.get("ad_mature_days") or 0))
        if row.get("estimated_cogs_t28") is not None:
            family["estimated_cogs_t28"] += float(row["estimated_cogs_t28"])
            family["cogs_known_units"] += int(row.get("units_t28") or 0)
        for dimension, value in (row.get("variation_attributes") or {}).items():
            family["variation_dimensions"].setdefault(str(dimension), set()).add(str(value))

    out = []
    priority = {"INVENTORY_RISK": 0, "TRAFFIC_NOT_CONVERTING": 1, "CONVERTS_NEEDS_TRAFFIC": 2, "WATCH": 3, "DORMANT": 4, "INACTIVE": 5, "HEALTHY": 6, "STRUCTURAL_PARENT": 7}
    for family in families.values():
        sellable = family["members"]
        # A parent is hierarchy evidence, never a commercial family on its own.
        # Retain it only when at least one sellable child gives the family a
        # demand/inventory context.
        if not sellable:
            continue
        candidates = sellable
        lead = max(candidates, key=lambda r: float(r.get("sales_t28") or 0))
        parent = family.get("parent")
        configured_family_names = [m.get("family_name") for m in sellable if m.get("family_name")]
        family["name"] = configured_family_names[0] if configured_family_names else ((parent or lead).get("product") or lead.get("sku"))
        family["image_url"] = lead.get("image_url")
        family["image_source"] = lead.get("image_source")
        family["conversion_t28_pct"] = round(100.0 * family["units_t28"] / family["sessions_t28"], 2) if family["sessions_t28"] > 0 else None
        family["days_cover_with_inbound"] = _pooled_days_cover(
            family["available"], family["inbound"], family["units_t28"]
        )
        family["cover_basis"] = {
            "method": "POOLED_28D",
            "stock_units": family["available"] + family["inbound"],
            "velocity_units_t28": family["units_t28"],
            "period_days": 28,
        }
        family["ad_tacos_t28"] = family["ad_spend_t28"] / family["sales_t28"] if family["sales_t28"] > 0 and family["ad_spend_t28"] > 0 else None
        family["ad_roas_t28"] = family["ad_attributed_sales_t28"] / family["ad_spend_t28"] if family["ad_spend_t28"] > 0 else None
        family["ad_attribution_state"] = "PROVISIONAL" if family["ad_observed_days"] > family["ad_mature_days"] else ("MATURE" if family["ad_observed_days"] else "UNAVAILABLE")
        family["child_states"] = sorted({m.get("commercial_state") for m in sellable if m.get("commercial_state")}, key=lambda x: priority.get(x, 99))
        family["child_exception_count"] = sum(1 for m in sellable if m.get("commercial_state") in {"INVENTORY_RISK", "TRAFFIC_NOT_CONVERTING", "CONVERTS_NEEDS_TRAFFIC", "DECLINING"})
        family["primary_state"], family["commercial_explanation"] = _family_state(family, traffic_median, conversion_median)
        family["needs_attention"] = family["primary_state"] in {"INVENTORY_RISK", "TRAFFIC_NOT_CONVERTING", "CONVERTS_NEEDS_TRAFFIC", "WATCH"} or family["child_exception_count"] > 0
        family["variation_dimensions"] = {k: sorted(v) for k, v in family["variation_dimensions"].items()}
        family["members"] = sorted(family["members"], key=lambda r: (-float(r.get("sales_t28") or 0), str(r.get("sku") or "")))
        family["aliases"] = sorted(family["aliases"], key=lambda r: str(r.get("sku") or ""))
        out.append(family)
    return sorted(out, key=lambda f: (not f["needs_attention"], -f["sales_t28"], f["name"] or ""))


def _catalog_summary(rows: list[dict]) -> dict:
    """Derive Catalog identity counts from the canonical product rowset.

    The payload already fetches every portfolio row immediately after the old
    summary query. Computing these small aggregates in memory avoids evaluating
    mart.catalog_portfolio_product twice during each cold response while keeping
    the public summary contract unchanged.
    """
    sellable_roles = {"SELLABLE_VARIATION", "SELLABLE_STANDALONE"}
    sellable = [row for row in rows if row.get("product_role") in sellable_roles]
    active_sellable = [
        row
        for row in sellable
        if str(row.get("status") or "").lower() != "inactive"
    ]

    fetched_at = [row.get("fetched_at") for row in rows if row.get("fetched_at")]
    traffic_dates = [
        row.get("traffic_through_date")
        for row in rows
        if row.get("traffic_through_date")
    ]
    families = {
        row.get("family_asin")
        for row in sellable
        if row.get("family_asin") is not None
    }

    return {
        "listing_records": len(rows),
        "sellable_offers": len(sellable),
        "structural_parents": sum(
            row.get("product_role") == "STRUCTURAL_PARENT" for row in rows
        ),
        "sku_aliases": sum(
            row.get("product_role") == "SELLER_SKU_ALIAS" for row in rows
        ),
        "active_sellable": len(active_sellable),
        "inactive_sellable": len(sellable) - len(active_sellable),
        "families": len(families),
        "listings_fetched_at": max(fetched_at, default=None),
        "traffic_through_date": max(traffic_dates, default=None),
    }


def catalog_payload(connect, decorate_products, marketplace: str) -> dict:
    with connect() as conn, conn.cursor() as cur:
        rows = _all(cur, """
            SELECT p.marketplace_id, p.seller_sku AS sku, p.asin, p.parent_asin, p.family_asin, p.product_role,
                   p.offer_rank, p.offer_owner_sku, p.is_offer_owner, p.title AS product, p.image_url, p.image_source,
                   p.price AS listing_price, p.status, p.fulfillment_channel, p.open_date, p.fetched_at,
                   p.available, p.inbound, p.days_cover_on_hand, p.days_cover_with_inbound, p.inventory_action,
                   p.sales_t28, p.units_t28, p.orders_t28, p.sessions_t28, p.page_views_t28,
                   p.conversion_t28_pct, p.sales_delta28_pct, p.sessions_delta28_pct, p.conversion_delta28_pp,
                   p.traffic_through_date, p.catalog_enriched,
                   ci.attributes AS catalog_attributes, ci.variation_theme AS amazon_variation_theme,
                   ci.variation_attributes AS amazon_variation_attribute_names,
                   a.spend AS ad_spend_t28, a.attributed_sales AS ad_attributed_sales_t28,
                   a.impressions AS ad_impressions_t28, a.clicks AS ad_clicks_t28,
                   a.attributed_purchases AS ad_attributed_purchases_t28, a.attributed_units AS ad_attributed_units_t28,
                   a.ctr AS ad_ctr_t28, a.cpc AS ad_cpc_t28, a.roas AS ad_roas_t28, a.acos AS ad_acos_t28,
                   CASE WHEN p.sales_t28 > 0 AND a.spend IS NOT NULL THEN a.spend / p.sales_t28 END AS ad_tacos_t28,
                   a.attributed_sales_share AS ad_attributed_sales_share_t28,
                   a.observed_ads_days AS ad_observed_days, a.mature_ads_days AS ad_mature_days,
                   a.through_date AS ads_through_date, a.ads_source_generated_at, a.ads_ingested_at
            FROM mart.catalog_portfolio_product p
            LEFT JOIN core.catalog_item ci ON ci.marketplace_id=p.marketplace_id AND ci.asin=p.asin
            LEFT JOIN mart.ads_product_business_t28 a ON a.marketplace_id=p.marketplace_id AND p.is_offer_owner AND (a.sku=p.seller_sku OR (a.sku IS NULL AND a.asin=p.asin))
            WHERE p.marketplace_id=%s
            ORDER BY p.is_offer_owner DESC, p.sales_t28 DESC, p.seller_sku
        """, (marketplace,))
        local_clock = _one(cur, "SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'America/Mexico_City','HH24:MI') local_time")

    summary = _catalog_summary(rows)
    rows = decorate_products(rows)
    costs = _product_costs()
    taxonomy = _product_taxonomy()
    for row in rows:
        sku = str(row.get("sku") or "")
        unit_cogs = costs.get(sku)
        local_taxonomy = taxonomy["products"].get(sku, {})
        row["family_name"] = local_taxonomy.get("family_name")
        row["variation_attributes"], row["variation_attribute_source"] = _variation_taxonomy_for_row(row, taxonomy)
        _apply_canonical_identity(row)
        row["unit_cogs"] = unit_cogs
        row["estimated_cogs_t28"] = round(unit_cogs * int(row.get("units_t28") or 0), 2) if unit_cogs is not None and _is_offer(row) else None
        observed, mature = int(row.get("ad_observed_days") or 0), int(row.get("ad_mature_days") or 0)
        row["ad_attribution_state"] = "PROVISIONAL" if observed > mature else ("MATURE" if observed else "UNAVAILABLE")
        row.pop("catalog_attributes", None)

    taxonomy_warnings = _repair_variation_taxonomy(rows)
    identity_violations = _identity_violations(rows)
    active_offers = [r for r in rows if _is_offer(r) and _is_active(r)]
    traffic_values = [float(r.get("sessions_t28") or 0) for r in active_offers if float(r.get("sessions_t28") or 0) > 0]
    conversion_values = [float(r["conversion_t28_pct"]) for r in active_offers if r.get("conversion_t28_pct") is not None]
    traffic_median = median(traffic_values) if traffic_values else 0.0
    conversion_median = median(conversion_values) if conversion_values else 0.0
    for row in rows:
        state, explanation = _commercial_state(row, traffic_median, conversion_median)
        row["commercial_state"], row["commercial_explanation"] = state, explanation

    families = _family_rollup(rows, traffic_median, conversion_median)
    dimensions = _dimension_rollups(rows)
    dimension_pairs = _dimension_pair_rollups(rows)
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
        "ad_spend_t28": round(sum(float(r.get("ad_spend_t28") or 0) for r in active), 2),
        "ad_attributed_sales_t28": round(sum(float(r.get("ad_attributed_sales_t28") or 0) for r in active), 2),
        "ads_through_date": max((r.get("ads_through_date") for r in active if r.get("ads_through_date")), default=None),
        "variation_dimensions": sorted(dimensions),
        "dimension_pair_count": len(dimension_pairs),
        "amazon_dimension_coverage": sum(1 for r in active if str(r.get("variation_attribute_source") or "").startswith("AMAZON_CATALOG")),
        "taxonomy_warning_count": len(taxonomy_warnings),
        "taxonomy_override_configured": taxonomy["configured"],
        "taxonomy_mapped_skus": sum(1 for r in rows if _is_offer(r) and str(r.get("sku") or "") in taxonomy["products"]),
        "taxonomy_unmapped_skus": sorted({str(r.get("sku") or "") for r in rows if _is_offer(r) and str(r.get("sku") or "") not in taxonomy["products"]}),
        "identity_invariant_checked_skus": sum(1 for row in rows if _is_offer(row)),
        "identity_invariant_violation_count": len(identity_violations),
    })
    summary["conversion_t28_pct"] = round(100.0 * summary["units_t28"] / summary["sessions_t28"], 2) if summary["sessions_t28"] else None
    summary["ad_tacos_t28"] = summary["ad_spend_t28"] / summary["sales_t28"] if summary["sales_t28"] > 0 and summary["ad_spend_t28"] > 0 else None
    summary["ad_roas_t28"] = summary["ad_attributed_sales_t28"] / summary["ad_spend_t28"] if summary["ad_spend_t28"] > 0 else None

    return {
        "summary": summary,
        "families": families,
        "products": rows,
        "dimensions": dimensions,
        "dimension_pairs": dimension_pairs,
        "taxonomy_warnings": taxonomy_warnings,
        "identity_violations": identity_violations,
        "attention": sorted(attention, key=lambda r: (-float(r.get("sales_t28") or 0), r.get("sku") or "")),
        "drivers": drivers[:5],
        "diagnostic_basis": {
            "period": "28D",
            "traffic_grain": "child ASIN from Data Kiosk; one canonical seller SKU owns each customer-facing offer",
            "family_grain": "structural parent is a non-sellable container; family metrics are recomputed from sellable child facts",
            "variation_grain": "Amazon Catalog variation dimensions/values by child ASIN, normalized to seller-facing dimensions; optional host-side product_variations.json overrides names/values without replacing Amazon identity",
            "identity_invariant": "every sellable variation has a distinct parent and matching family ASIN; every standalone offer has no canonical parent and uses its own ASIN as family",
            "dimension_semantics": "dimension rollups recompute additive facts and conversion from total units / total sessions; pair rollups support design × ruling analysis without averaging conversion percentages",
            "taxonomy_repair": "cross-dimension collisions are repaired only when one dimension is clearly established and exactly one observed sibling value is present in the product title; all repairs/removals remain auditable in taxonomy_warnings",
            "traffic_median_t28": round(traffic_median, 1),
            "conversion_median_t28_pct": round(conversion_median, 2),
            "ads_basis": "Amazon-attributed Ads performance; TACOS uses independent total seller sales. Attributed sales are not incremental sales and the residual is not exact organic sales.",
            "notes": "Commercial states and dimensional comparisons are diagnostic signals, not causal claims. Structural parents and seller-SKU aliases are excluded from sellable demand metrics.",
        },
        "local_time": local_clock.get("local_time"),
    }
