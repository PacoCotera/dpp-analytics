from __future__ import annotations

import json
import os
import re
import sqlite3
from functools import lru_cache
from pathlib import Path
from urllib.request import Request, urlopen

POSTAL_DB = Path(os.getenv("POSTAL_REFERENCE_DB", "/app/reference/db_postal.sqlite"))
POSTAL_BASE = "https://raw.githubusercontent.com/open-mexico/mexico-geojson/main/"
STATE_FILES = {
    "01": "01-Ags.geojson",
    "02": "02-Bc.geojson",
    "03": "03-Bcs.geojson",
    "04": "04-Camp.geojson",
    "05": "05-Coah.geojson",
    "06": "06-Col.geojson",
    "07": "07-Chis.geojson",
    "08": "08-Chih.geojson",
    "09": "09-Cdmx.geojson",
    "10": "10-Dgo.geojson",
    "11": "11-Gto.geojson",
    "12": "12-Gro.geojson",
    "13": "13-Hgo.geojson",
    "14": "14-Jal.geojson",
    "15": "15-Mex.geojson",
    "16": "16-Mich.geojson",
    "17": "17-Mor.geojson",
    "18": "18-Nay.geojson",
    "19": "19-NL.geojson",
    "20": "20-Oax.geojson",
    "21": "21-Pue.geojson",
    "22": "22-Qro.geojson",
    "23": "23-Qroo.geojson",
    "24": "24-SLP.geojson",
    "25": "25-Sin.geojson",
    "26": "26-Son.geojson",
    "27": "27-Tab.geojson",
    "28": "28-Tmps.geojson",
    "29": "29-Tlax.geojson",
    "30": "30-Ver.geojson",
    "31": "31-Yuc.geojson",
    "32": "32-Zac.geojson",
}
POSTAL_RE = re.compile(r"^\d{5}$")
STATE_RE = re.compile(r"^\d{2}$")


def _postal(value: object) -> str | None:
    raw = str(value or "").strip()
    if raw.isdigit() and len(raw) <= 5:
        raw = raw.zfill(5)
    return raw if POSTAL_RE.fullmatch(raw) else None


def postal_dictionary(codes: list[str] | set[str] | tuple[str, ...]) -> list[dict]:
    """Return compact SEPOMEX labels for postal codes already present in DPP facts.

    One postal code may contain multiple settlements.  The reference therefore
    preserves the settlement list while exposing municipality/city as the useful
    human-readable label.  This is public reference data, not customer data.
    """
    requested = sorted({cp for value in codes if (cp := _postal(value))})
    if not requested or not POSTAL_DB.is_file():
        return []

    placeholders = ",".join("?" for _ in requested)
    sql = f"""
        SELECT c.codigo,
               c.nombre AS settlement,
               c.tipo AS settlement_type,
               c.ciudad,
               c.zona,
               c.estado_id,
               e.nombre AS state_name,
               m.nombre AS municipality_name
        FROM colonias c
        LEFT JOIN estados e ON e.id=c.estado_id
        LEFT JOIN municipios m ON m.municipio_uid=c.municipio_uid
        WHERE c.codigo IN ({placeholders})
        ORDER BY c.codigo,c.nombre
    """

    try:
        conn = sqlite3.connect(f"file:{POSTAL_DB}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(sql, requested).fetchall()
    except sqlite3.Error:
        return []
    finally:
        try:
            conn.close()
        except Exception:
            pass

    grouped: dict[str, dict] = {}
    for row in rows:
        cp = _postal(row["codigo"])
        if not cp:
            continue
        item = grouped.setdefault(
            cp,
            {
                "postal_code": cp,
                "state_code": row["estado_id"],
                "state_name": row["state_name"],
                "municipality_name": row["municipality_name"],
                "city_name": row["ciudad"],
                "zone": row["zona"],
                "settlements": [],
                "settlement_types": [],
                "source": "SEPOMEX · open-mexico db_postal v1.2.0",
            },
        )
        settlement = (row["settlement"] or "").strip()
        settlement_type = (row["settlement_type"] or "").strip()
        if settlement and settlement not in item["settlements"]:
            item["settlements"].append(settlement)
        if settlement_type and settlement_type not in item["settlement_types"]:
            item["settlement_types"].append(settlement_type)

    for item in grouped.values():
        municipality = item.get("municipality_name") or item.get("city_name") or item.get("state_name")
        item["label"] = municipality or f"CP {item['postal_code']}"
    return [grouped[cp] for cp in requested if cp in grouped]


@lru_cache(maxsize=2)
def _state_geojson(state_code: str) -> dict:
    filename = STATE_FILES.get(state_code)
    if not filename:
        raise ValueError("Unknown Mexican state code")
    request = Request(
        POSTAL_BASE + filename,
        headers={"User-Agent": "Dirty-Pawz-Press-Analytics/1.0"},
    )
    with urlopen(request, timeout=45) as response:
        payload = response.read()
    return json.loads(payload)


def postal_geometry(state_code: str, codes: list[str] | set[str] | tuple[str, ...]) -> dict:
    """Return only requested postal polygons from the Open Mexico state file.

    The browser never downloads the multi-megabyte raw state file.  The board
    fetches it server-side, caches two parsed states, and returns only the postal
    polygons that actually exist in the selected DPP demand slice.
    """
    state_code = str(state_code or "").strip().zfill(2)
    if not STATE_RE.fullmatch(state_code) or state_code not in STATE_FILES:
        raise ValueError("Invalid state code")
    requested = {cp for value in codes if (cp := _postal(value))}
    if not requested:
        return {
            "type": "FeatureCollection",
            "features": [],
            "state_code": state_code,
            "requested_codes": 0,
            "matched_codes": 0,
            "missing_codes": [],
            "source": "open-mexico/mexico-geojson",
        }

    geo = _state_geojson(state_code)
    features = []
    matched: set[str] = set()
    for feature in geo.get("features") or []:
        cp = _postal((feature.get("properties") or {}).get("d_codigo"))
        if cp and cp in requested:
            features.append(feature)
            matched.add(cp)

    return {
        "type": "FeatureCollection",
        "name": geo.get("name"),
        "bbox": geo.get("bbox"),
        "features": features,
        "state_code": state_code,
        "requested_codes": len(requested),
        "matched_codes": len(matched),
        "missing_codes": sorted(requested - matched),
        "source": "open-mexico/mexico-geojson · SEPOMEX",
    }
