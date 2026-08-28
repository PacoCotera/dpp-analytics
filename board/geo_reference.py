from __future__ import annotations

import gzip
import json
import math
import os
import re
import sqlite3
from functools import lru_cache
from pathlib import Path

POSTAL_DB = Path(os.getenv("POSTAL_REFERENCE_DB", "/app/reference/db_postal.sqlite"))
POSTAL_GEOMETRY_ROOT = Path(
    os.getenv("POSTAL_GEOMETRY_ROOT", "/app/reference/mexico-geojson")
)
POSTAL_GEOMETRY_SOURCE_REPOSITORY = "open-mexico/mexico-geojson"
POSTAL_GEOMETRY_SOURCE_COMMIT = "ff9a744df9e9c1db66d5de40ae14a71920cb72e7"
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

# Postal geometry is WGS84.  Keep a deliberately generous Mexico envelope so
# malformed KML conversions cannot create world-sized SVG paths in the browser.
MEXICO_LON_MIN = -120.0
MEXICO_LON_MAX = -85.0
MEXICO_LAT_MIN = 10.0
MEXICO_LAT_MAX = 35.0


def _postal(value: object) -> str | None:
    raw = str(value or "").strip()
    if raw.isdigit() and len(raw) <= 5:
        raw = raw.zfill(5)
    return raw if POSTAL_RE.fullmatch(raw) else None


def postal_dictionary(codes: list[str] | set[str] | tuple[str, ...]) -> list[dict]:
    """Return compact SEPOMEX labels for postal codes already present in DPP facts.

    One postal code may contain multiple settlements. The reference therefore
    preserves the settlement list while exposing municipality/city as the useful
    human-readable label. This is public reference data, not customer data.
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

    conn = None
    try:
        conn = sqlite3.connect(f"file:{POSTAL_DB}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(sql, requested).fetchall()
    except sqlite3.Error:
        return []
    finally:
        if conn is not None:
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
    path = POSTAL_GEOMETRY_ROOT / f"{filename}.gz"
    if not path.is_file():
        raise RuntimeError(f"Bundled postal geometry unavailable for state {state_code}")
    with gzip.open(path, "rt", encoding="utf-8") as source:
        payload = json.load(source)
    if payload.get("type") != "FeatureCollection" or not isinstance(payload.get("features"), list):
        raise RuntimeError(f"Bundled postal geometry is invalid for state {state_code}")
    return payload


def _position(value: object) -> list[float] | None:
    if not isinstance(value, (list, tuple)) or len(value) < 2:
        return None
    try:
        lon = float(value[0])
        lat = float(value[1])
    except (TypeError, ValueError):
        return None
    if not math.isfinite(lon) or not math.isfinite(lat):
        return None
    if not (MEXICO_LON_MIN <= lon <= MEXICO_LON_MAX and MEXICO_LAT_MIN <= lat <= MEXICO_LAT_MAX):
        return None
    return [lon, lat]


def _ring_area(ring: list[list[float]]) -> float:
    """Planar signed area; negative is clockwise in lon/lat Cartesian space."""
    return 0.5 * sum(
        ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1]
        for index in range(len(ring) - 1)
    )


def _sanitize_ring(value: object, *, clockwise: bool) -> tuple[list[list[float]] | None, bool]:
    if not isinstance(value, list):
        return None, False
    ring: list[list[float]] = []
    for raw in value:
        point = _position(raw)
        if point is None:
            return None, False
        ring.append(point)
    if len(ring) < 3:
        return None, False
    if ring[0] != ring[-1]:
        ring.append(list(ring[0]))
    if len(ring) < 4 or len({(p[0], p[1]) for p in ring[:-1]}) < 3:
        return None, False

    area = _ring_area(ring)
    if not math.isfinite(area) or abs(area) < 1e-12:
        return None, False
    is_clockwise = area < 0
    rewound = is_clockwise != clockwise
    if rewound:
        ring = list(reversed(ring))
    return ring, rewound


def _sanitize_polygon(value: object) -> tuple[list[list[list[float]]] | None, int]:
    if not isinstance(value, list) or not value:
        return None, 0
    outer, rewound = _sanitize_ring(value[0], clockwise=True)
    if outer is None:
        return None, 0
    rings = [outer]
    rewound_count = int(rewound)
    for raw_hole in value[1:]:
        hole, hole_rewound = _sanitize_ring(raw_hole, clockwise=False)
        if hole is None:
            continue
        rings.append(hole)
        rewound_count += int(hole_rewound)
    return rings, rewound_count


def _sanitize_geometry(value: object) -> tuple[dict | None, int]:
    if not isinstance(value, dict):
        return None, 0
    geometry_type = value.get("type")
    coordinates = value.get("coordinates")
    if geometry_type == "Polygon":
        polygon, rewound = _sanitize_polygon(coordinates)
        return ({"type": "Polygon", "coordinates": polygon}, rewound) if polygon else (None, 0)
    if geometry_type == "MultiPolygon" and isinstance(coordinates, list):
        polygons = []
        rewound_count = 0
        for raw_polygon in coordinates:
            polygon, rewound = _sanitize_polygon(raw_polygon)
            if polygon is None:
                continue
            polygons.append(polygon)
            rewound_count += rewound
        if polygons:
            return {"type": "MultiPolygon", "coordinates": polygons}, rewound_count
    return None, 0


def _sanitize_feature(feature: object) -> tuple[dict | None, int]:
    if not isinstance(feature, dict):
        return None, 0
    geometry, rewound = _sanitize_geometry(feature.get("geometry"))
    if geometry is None:
        return None, 0
    return {
        "type": "Feature",
        "properties": dict(feature.get("properties") or {}),
        "geometry": geometry,
    }, rewound


def postal_geometry(state_code: str, codes: list[str] | set[str] | tuple[str, ...]) -> dict:
    """Return requested postal polygons normalized for D3's spherical winding.

    Open Mexico publishes RFC-7946-style GeoJSON, whose exterior-ring winding is
    opposite D3's spherical convention. Passing those polygons directly to
    d3.geoPath can render the complement of a small postal polygon, visually
    filling almost the entire page. This endpoint validates WGS84 coordinates,
    rewinds exterior rings clockwise and holes counterclockwise, and only then
    exposes the filtered geometry to the browser.
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
            "invalid_codes": [],
            "invalid_feature_count": 0,
            "rewound_ring_count": 0,
            "source": f"{POSTAL_GEOMETRY_SOURCE_REPOSITORY} @ {POSTAL_GEOMETRY_SOURCE_COMMIT[:8]}",
            "geometry_contract": "WGS84 lon/lat · D3 clockwise exterior rings",
        }

    geo = _state_geojson(state_code)
    features = []
    raw_matched: set[str] = set()
    matched: set[str] = set()
    invalid_codes: set[str] = set()
    invalid_feature_count = 0
    rewound_ring_count = 0

    for feature in geo.get("features") or []:
        cp = _postal((feature.get("properties") or {}).get("d_codigo"))
        if not cp or cp not in requested:
            continue
        raw_matched.add(cp)
        sanitized, rewound = _sanitize_feature(feature)
        if sanitized is None:
            invalid_feature_count += 1
            invalid_codes.add(cp)
            continue
        features.append(sanitized)
        matched.add(cp)
        invalid_codes.discard(cp)
        rewound_ring_count += rewound

    return {
        "type": "FeatureCollection",
        "name": geo.get("name"),
        "features": features,
        "state_code": state_code,
        "requested_codes": len(requested),
        "source_matched_codes": len(raw_matched),
        "matched_codes": len(matched),
        "missing_codes": sorted(requested - matched),
        "invalid_codes": sorted(invalid_codes - matched),
        "invalid_feature_count": invalid_feature_count,
        "rewound_ring_count": rewound_ring_count,
        "source": f"{POSTAL_GEOMETRY_SOURCE_REPOSITORY} @ {POSTAL_GEOMETRY_SOURCE_COMMIT[:8]} · SEPOMEX",
        "geometry_contract": "WGS84 lon/lat · D3 clockwise exterior rings",
    }
