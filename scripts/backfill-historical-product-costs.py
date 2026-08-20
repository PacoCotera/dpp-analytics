#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


POCKET_SOURCE_SKUS = (
    "PNC-001",
    "PNC-001B",
    "PNC-004",
    "PNC-004B",
    "PNC-005",
    "PNC-005B",
)
POCKET_HISTORICAL_SKUS = ("PNC-002", "PCN-003", "PNC-001-FBM")
CLOTH_SINGLE_SKUS = ("COL-ST-01", "COL-ST-02", "COL-ST-03", "SN-001")
CLOTH_BUNDLE_SKU = "CP-X19V-4AFR"
CURRENT_SINGLE_TIER_SKU = "BLC-001"


def _number(value) -> float | None:
    if isinstance(value, dict):
        value = value.get("unit_cogs", value.get("current"))
    try:
        amount = float(value)
    except (TypeError, ValueError):
        return None
    return amount if amount >= 0 else None


def _consistent_cost(costs: dict, skus: tuple[str, ...], label: str) -> float:
    values = {_number(costs.get(sku)) for sku in skus}
    values.discard(None)
    if not values:
        raise RuntimeError(f"No configured {label} COGS found in {', '.join(skus)}")
    if len(values) != 1:
        raise RuntimeError(f"Configured {label} COGS disagree: {sorted(values)}")
    return values.pop()


def backfill(path: Path) -> dict:
    raw = json.loads(path.read_text())
    if not isinstance(raw, dict):
        raise RuntimeError("Product-cost config must be a JSON object")
    costs = raw.get("costs")
    if not isinstance(costs, dict):
        raise RuntimeError("Product-cost config must contain a costs object")

    pocket = _consistent_cost(costs, POCKET_SOURCE_SKUS, "pocket 3-pack")
    cloth_single = _consistent_cost(costs, (CURRENT_SINGLE_TIER_SKU,), "single-unit tier")
    desired = {
        **{sku: pocket for sku in POCKET_HISTORICAL_SKUS},
        **{sku: cloth_single for sku in CLOTH_SINGLE_SKUS},
        CLOTH_BUNDLE_SKU: round(cloth_single * 3, 2),
    }

    added = {}
    preserved = {}
    for sku, amount in desired.items():
        if sku in costs:
            preserved[sku] = costs[sku]
        else:
            costs[sku] = amount
            added[sku] = amount

    meta = raw.setdefault("_meta", {})
    if isinstance(meta, dict):
        meta["historical_backfill"] = {
            "basis": "Legacy SKUs use the current equivalent product-tier COGS.",
            "pocket_3pack_unit_cogs": pocket,
            "cloth_single_unit_cogs": cloth_single,
            "cloth_3pack_unit_cogs": round(cloth_single * 3, 2),
        }

    mode = path.stat().st_mode & 0o777
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(raw, indent=2, ensure_ascii=False) + "\n")
    os.chmod(tmp, mode)
    os.replace(tmp, path)
    return {"path": str(path), "added": added, "preserved": preserved}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    print(json.dumps(backfill(args.path), ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
