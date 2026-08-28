from __future__ import annotations

import gzip
import json
import tarfile
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from urllib.request import Request, urlopen

from geo_reference import (
    POSTAL_GEOMETRY_SOURCE_COMMIT,
    POSTAL_GEOMETRY_SOURCE_REPOSITORY,
    STATE_FILES,
)

ARCHIVE_URL = (
    f"https://github.com/{POSTAL_GEOMETRY_SOURCE_REPOSITORY}/archive/"
    f"{POSTAL_GEOMETRY_SOURCE_COMMIT}.tar.gz"
)
ARCHIVE_ROOT = f"mexico-geojson-{POSTAL_GEOMETRY_SOURCE_COMMIT}"
TARGET = Path("/app/reference/mexico-geojson")
MAX_SOURCE_BYTES = 32 * 1024 * 1024


def install(target: Path = TARGET) -> dict:
    request = Request(ARCHIVE_URL, headers={"User-Agent": "Dirty-Pawz-Press-Analytics/1.0"})
    with urlopen(request, timeout=180) as response:
        archive_bytes = response.read()

    target.mkdir(parents=True, exist_ok=True)
    installed = {}
    with tarfile.open(fileobj=BytesIO(archive_bytes), mode="r:gz") as archive:
        for state_code, filename in STATE_FILES.items():
            member = archive.getmember(f"{ARCHIVE_ROOT}/{filename}")
            if not member.isfile() or member.size <= 0 or member.size > MAX_SOURCE_BYTES:
                raise RuntimeError(f"Unexpected geometry member for state {state_code}: {member!r}")
            source = archive.extractfile(member)
            if source is None:
                raise RuntimeError(f"Missing geometry payload for state {state_code}")
            raw = source.read()
            payload = json.loads(raw)
            features = payload.get("features")
            if payload.get("type") != "FeatureCollection" or not isinstance(features, list) or not features:
                raise RuntimeError(f"Invalid geometry payload for state {state_code}")
            if not any(str((feature.get("properties") or {}).get("d_codigo") or "").strip() for feature in features):
                raise RuntimeError(f"Geometry payload has no postal-code evidence for state {state_code}")
            (target / f"{filename}.gz").write_bytes(gzip.compress(raw, compresslevel=9, mtime=0))
            installed[state_code] = {
                "filename": filename,
                "features": len(features),
                "sha256": sha256(raw).hexdigest(),
            }

        license_member = archive.getmember(f"{ARCHIVE_ROOT}/LICENSE")
        license_source = archive.extractfile(license_member)
        if license_source is None:
            raise RuntimeError("Pinned geometry archive has no license")
        (target / "LICENSE.txt").write_bytes(license_source.read())

    if sorted(installed) != [f"{state:02d}" for state in range(1, 33)]:
        raise RuntimeError(f"Expected all 32 state geometry files, got {sorted(installed)}")
    manifest = {
        "repository": POSTAL_GEOMETRY_SOURCE_REPOSITORY,
        "commit": POSTAL_GEOMETRY_SOURCE_COMMIT,
        "license": "MIT",
        "states": installed,
    }
    (target / "SOURCE.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return manifest


if __name__ == "__main__":
    result = install()
    print(
        f"Bundled {len(result['states'])} state postal-geometry sources "
        f"from {result['repository']}@{result['commit']}"
    )
