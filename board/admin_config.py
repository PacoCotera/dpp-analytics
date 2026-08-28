from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse


WRITE_LOCK = threading.RLock()
SELLABLE_ROLES = {"SELLABLE_STANDALONE", "SELLABLE_VARIATION"}


class AdminConfigError(ValueError):
    pass


class RevisionConflict(AdminConfigError):
    pass


def config_paths() -> dict[str, Path]:
    root = Path(__file__).parent
    return {
        "labels": Path(os.getenv("PRODUCT_LABELS_PATH", root / "product_labels.json")),
        "taxonomy": Path(os.getenv("PRODUCT_VARIATIONS_PATH", root / "product_variations.json")),
        "cogs": Path(os.getenv("PRODUCT_COSTS_PATH", root / "product_costs.json")),
    }


def _read_document(path: Path) -> tuple[dict, bytes]:
    try:
        raw = path.read_bytes()
        value = json.loads(raw)
    except (OSError, json.JSONDecodeError) as exc:
        raise AdminConfigError(f"Configuration is unavailable: {path.name}") from exc
    if not isinstance(value, dict):
        raise AdminConfigError(f"Configuration root must be an object: {path.name}")
    return value, raw


def _revision(raw_documents: dict[str, bytes]) -> str:
    digest = hashlib.sha256()
    for name in sorted(raw_documents):
        digest.update(name.encode())
        digest.update(b"\0")
        digest.update(raw_documents[name])
        digest.update(b"\0")
    return digest.hexdigest()


def _current_cogs(value):
    if isinstance(value, dict):
        value = value.get("unit_cogs", value.get("current"))
    try:
        amount = float(value)
    except (TypeError, ValueError):
        return None
    return amount if amount >= 0 else None


def load_config_snapshot(paths: dict[str, Path] | None = None) -> dict:
    selected = paths or config_paths()
    documents: dict[str, dict] = {}
    raw_documents: dict[str, bytes] = {}
    for name, path in selected.items():
        documents[name], raw_documents[name] = _read_document(path)
    return {
        "revision": _revision(raw_documents),
        "documents": documents,
        "raw_documents": raw_documents,
        "paths": selected,
    }


def seller_config_for_sku(documents: dict[str, dict], sku: str) -> dict:
    label = documents["labels"].get(sku, {})
    if not isinstance(label, dict):
        label = {}
    products = documents["taxonomy"].get("products", {})
    taxonomy = products.get(sku, {}) if isinstance(products, dict) else {}
    if not isinstance(taxonomy, dict):
        taxonomy = {}
    attributes = taxonomy.get("attributes", {})
    if not isinstance(attributes, dict):
        attributes = {}
    costs = documents["cogs"].get("costs", {})
    raw_cost = costs.get(sku) if isinstance(costs, dict) else None
    return {
        "label": {
            "name": label.get("name") if isinstance(label.get("name"), str) else None,
            "image_url": label.get("image_url") if isinstance(label.get("image_url"), str) else None,
            "amazon_url": label.get("amazon_url") if isinstance(label.get("amazon_url"), str) else None,
        },
        "taxonomy": {
            "family_name": taxonomy.get("family_name") if isinstance(taxonomy.get("family_name"), str) else None,
            "attributes": {
                str(key): str(value)
                for key, value in attributes.items()
                if str(key).strip() and str(value).strip()
            },
        },
        "cogs": {
            "unit_cogs": _current_cogs(raw_cost),
            "has_history": bool(isinstance(raw_cost, dict) and raw_cost.get("history")),
        },
    }


def build_admin_catalog(catalog_payload: dict, snapshot: dict) -> dict:
    documents = snapshot["documents"]
    current = []
    for row in catalog_payload.get("products") or []:
        if row.get("product_role") not in SELLABLE_ROLES:
            continue
        if row.get("catalog_membership") != "CURRENT_OFFER" or not row.get("is_current_listing", True):
            continue
        sku = str(row.get("sku") or "")
        config = seller_config_for_sku(documents, sku)
        missing = {
            "short_name": not bool((config["label"].get("name") or "").strip()),
            "taxonomy": not bool(
                (config["taxonomy"].get("family_name") or "").strip()
                or config["taxonomy"].get("attributes")
            ),
            "cogs": config["cogs"].get("unit_cogs") is None,
        }
        current.append(
            {
                "sku": sku,
                "asin": row.get("asin"),
                "source_title": row.get("catalog_title") or row.get("product") or sku,
                "image_url": row.get("image_url"),
                "status": row.get("status"),
                "fulfillment_channel": row.get("fulfillment_channel"),
                "product_role": row.get("product_role"),
                "parent_asin": row.get("parent_asin"),
                "family_asin": row.get("family_asin"),
                "amazon_variation_attributes": row.get("amazon_variation_attributes") or {},
                "available": int(row.get("available") or 0),
                "inbound": int(row.get("inbound") or 0),
                "config": config,
                "missing": missing,
                "needs_configuration": any(missing.values()),
                "lifecycle": "CURRENT",
            }
        )

    deleted = []
    for row in catalog_payload.get("deleted_products") or []:
        sku = str(row.get("sku") or "")
        deleted.append(
            {
                "sku": sku,
                "asin": row.get("asin"),
                "source_title": row.get("catalog_title") or row.get("product") or sku,
                "last_seen_at": row.get("last_seen_at"),
                "deleted_at": row.get("deleted_at"),
                "config": seller_config_for_sku(documents, sku),
                "lifecycle": "DELETED_HISTORY",
            }
        )

    current.sort(key=lambda row: (not row["needs_configuration"], row["sku"]))
    return {
        "revision": snapshot["revision"],
        "summary": {
            "current": len(current),
            "needs_configuration": sum(row["needs_configuration"] for row in current),
            "deleted_history": len(deleted),
        },
        "current_products": current,
        "deleted_products": deleted,
        "lifecycle_basis": {
            "current": "Latest complete Amazon Seller Listings snapshot",
            "identity": "Amazon Catalog Items parent-child evidence",
            "deleted": "Retained seller-listing history; excluded from current editing and rollups",
        },
    }


def _optional_text(value, field: str, maximum: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise AdminConfigError(f"{field} must be text or null")
    text = value.strip()
    if not text:
        return None
    if len(text) > maximum:
        raise AdminConfigError(f"{field} must be at most {maximum} characters")
    return text


def _optional_url(value, field: str) -> str | None:
    text = _optional_text(value, field, 500)
    if text is None:
        return None
    parsed = urlparse(text)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise AdminConfigError(f"{field} must be an HTTPS URL")
    return text


def validate_update(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise AdminConfigError("Request body must be an object")
    sku = _optional_text(payload.get("sku"), "sku", 128)
    revision = _optional_text(payload.get("expected_revision"), "expected_revision", 64)
    if not sku or not revision:
        raise AdminConfigError("sku and expected_revision are required")

    label = payload.get("label") or {}
    taxonomy = payload.get("taxonomy") or {}
    cogs = payload.get("cogs") or {}
    if not all(isinstance(value, dict) for value in (label, taxonomy, cogs)):
        raise AdminConfigError("label, taxonomy, and cogs must be objects")

    raw_attributes = taxonomy.get("attributes") or {}
    if not isinstance(raw_attributes, dict) or len(raw_attributes) > 16:
        raise AdminConfigError("taxonomy attributes must be an object with at most 16 fields")
    attributes: dict[str, str] = {}
    folded = set()
    for raw_key, raw_value in raw_attributes.items():
        key = _optional_text(raw_key, "taxonomy attribute name", 64)
        value = _optional_text(raw_value, f"taxonomy attribute {key or ''}", 160)
        if not key or not value:
            continue
        normalized = key.casefold()
        if normalized in folded:
            raise AdminConfigError(f"Duplicate taxonomy attribute: {key}")
        folded.add(normalized)
        attributes[key] = value

    raw_cost = cogs.get("unit_cogs")
    if raw_cost in (None, ""):
        unit_cogs = None
    else:
        if isinstance(raw_cost, bool):
            raise AdminConfigError("unit_cogs must be a number or null")
        try:
            unit_cogs = float(raw_cost)
        except (TypeError, ValueError) as exc:
            raise AdminConfigError("unit_cogs must be a number or null") from exc
        if not 0 <= unit_cogs <= 1_000_000:
            raise AdminConfigError("unit_cogs must be between 0 and 1000000")
        unit_cogs = round(unit_cogs, 4)

    return {
        "sku": sku,
        "expected_revision": revision,
        "label": {
            "name": _optional_text(label.get("name"), "short name", 120),
            "image_url": _optional_url(label.get("image_url"), "image URL"),
            "amazon_url": _optional_url(label.get("amazon_url"), "Amazon URL"),
        },
        "taxonomy": {
            "family_name": _optional_text(taxonomy.get("family_name"), "family name", 160),
            "attributes": attributes,
        },
        "cogs": {"unit_cogs": unit_cogs},
    }


def _merge_entry(container: dict, key: str, updates: dict) -> None:
    entry = container.get(key, {})
    if not isinstance(entry, dict):
        entry = {}
    entry = dict(entry)
    for field, value in updates.items():
        if value is None or value == {}:
            entry.pop(field, None)
        else:
            entry[field] = value
    if entry:
        container[key] = entry
    else:
        container.pop(key, None)


def _apply_update(documents: dict[str, dict], update: dict) -> set[str]:
    sku = update["sku"]
    before = {name: json.dumps(value, sort_keys=True, ensure_ascii=False) for name, value in documents.items()}

    _merge_entry(documents["labels"], sku, update["label"])

    products = documents["taxonomy"].setdefault("products", {})
    if not isinstance(products, dict):
        raise AdminConfigError("product_variations.json products must be an object")
    _merge_entry(products, sku, update["taxonomy"])

    costs = documents["cogs"].setdefault("costs", {})
    if not isinstance(costs, dict):
        raise AdminConfigError("product_costs.json costs must be an object")
    existing_cost = costs.get(sku)
    unit_cogs = update["cogs"]["unit_cogs"]
    if unit_cogs == _current_cogs(existing_cost):
        pass
    elif isinstance(existing_cost, dict):
        cost_entry = dict(existing_cost)
        cost_entry.pop("current", None)
        if unit_cogs is None:
            cost_entry.pop("unit_cogs", None)
        else:
            cost_entry["unit_cogs"] = unit_cogs
        if cost_entry:
            costs[sku] = cost_entry
        else:
            costs.pop(sku, None)
    elif unit_cogs is None:
        costs.pop(sku, None)
    else:
        costs[sku] = {"unit_cogs": unit_cogs}

    return {
        name
        for name, value in documents.items()
        if json.dumps(value, sort_keys=True, ensure_ascii=False) != before[name]
    }


def _encoded(document: dict) -> bytes:
    return (json.dumps(document, ensure_ascii=False, indent=2) + "\n").encode()


def _write_temp(path: Path, body: bytes) -> Path:
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, path.stat().st_mode & 0o777 if path.exists() else 0o640)
        return temporary
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _backup(path: Path, raw: bytes, revision: str) -> Path:
    backup_dir = path.parent / "backups"
    backup_dir.mkdir(mode=0o750, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = backup_dir / f"{path.name}.{timestamp}.{revision[:12]}.bak"
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o640)
    with os.fdopen(fd, "wb") as handle:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())
    backups = sorted(backup_dir.glob(f"{path.name}.*.bak"), reverse=True)
    for old in backups[30:]:
        old.unlink(missing_ok=True)
    return backup


def _replace_documents(snapshot: dict, documents: dict[str, dict], changed: set[str]) -> None:
    if not changed:
        return
    temporaries: dict[str, Path] = {}
    replaced: list[str] = []
    try:
        for name in changed:
            path = snapshot["paths"][name]
            temporaries[name] = _write_temp(path, _encoded(documents[name]))
            _backup(path, snapshot["raw_documents"][name], snapshot["revision"])
        for name in sorted(changed):
            os.replace(temporaries[name], snapshot["paths"][name])
            replaced.append(name)
        directory_fd = os.open(next(iter(snapshot["paths"].values())).parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except Exception:
        for name in reversed(replaced):
            rollback = _write_temp(snapshot["paths"][name], snapshot["raw_documents"][name])
            os.replace(rollback, snapshot["paths"][name])
        raise
    finally:
        for temporary in temporaries.values():
            temporary.unlink(missing_ok=True)


def _append_audit(path: Path, *, sku: str, changed: set[str], revision: str) -> None:
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "actor": "admin_session",
        "sku": sku,
        "changed_documents": sorted(changed),
        "revision": revision,
    }
    body = (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    fd = os.open(path.parent / "admin-audit.jsonl", os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o640)
    with os.fdopen(fd, "ab") as handle:
        handle.write(body)
        handle.flush()
        os.fsync(handle.fileno())


def save_sku_config(
    payload: dict,
    *,
    editable_skus: set[str],
    paths: dict[str, Path] | None = None,
) -> dict:
    update = validate_update(payload)
    if update["sku"] not in editable_skus:
        raise AdminConfigError("SKU is not a current sellable offer")
    with WRITE_LOCK:
        snapshot = load_config_snapshot(paths)
        if update["expected_revision"] != snapshot["revision"]:
            raise RevisionConflict("Configuration changed; reload before saving")
        documents = json.loads(json.dumps(snapshot["documents"], ensure_ascii=False))
        changed = _apply_update(documents, update)
        _replace_documents(snapshot, documents, changed)
        current = load_config_snapshot(paths)
        if changed:
            _append_audit(
                next(iter(current["paths"].values())),
                sku=update["sku"],
                changed=changed,
                revision=current["revision"],
            )
        return {
            "saved": True,
            "changed": bool(changed),
            "changed_documents": sorted(changed),
            "revision": current["revision"],
            "config": seller_config_for_sku(current["documents"], update["sku"]),
        }
