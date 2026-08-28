from __future__ import annotations

import json
import re
from functools import lru_cache
from hashlib import sha256
from pathlib import Path


ASSET_REFERENCE_RE = re.compile(
    r'''(?P<quote>["'`])(?P<path>(?:/assets/|\./)[^"'`?#\s]+\.(?:css|gif|geojson|ico|jpeg|jpg|js|json|png|svg|webp|woff|woff2))(?P=quote)'''
)


def build_asset_manifest(static_root: Path) -> dict[str, str]:
    return {
        path.relative_to(static_root).as_posix(): sha256(path.read_bytes()).hexdigest()
        for path in sorted(static_root.rglob("*"))
        if path.is_file()
    }


def release_revision(manifest: dict[str, str]) -> str:
    canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    return sha256(canonical).hexdigest()[:12]


def version_asset_references(text: str, revision: str) -> str:
    return ASSET_REFERENCE_RE.sub(
        lambda match: f"{match.group('quote')}{match.group('path')}?v={revision}{match.group('quote')}",
        text,
    )


def version_page(text: str, revision: str) -> str:
    if "<head>" not in text:
        raise RuntimeError("Page has no head for the asset revision contract")
    versioned = version_asset_references(text, revision)
    return versioned.replace(
        "<head>",
        f'<head>\n    <meta name="dpp-asset-revision" content="{revision}" />',
        1,
    )


@lru_cache(maxsize=None)
def release_asset_bytes(path: Path, revision: str) -> bytes:
    body = path.read_bytes()
    if path.suffix.lower() not in {".css", ".js"} or "vendor" in path.parts:
        return body
    return version_asset_references(body.decode("utf-8"), revision).encode("utf-8")


def asset_etag(body: bytes) -> str:
    # The same source bytes may be transferred either identity-encoded or gzip
    # encoded. A weak validator correctly spans those negotiated representations.
    return f'W/"{sha256(body).hexdigest()}"'


def etag_matches(header: str, etag: str) -> bool:
    return any(value.strip() in {"*", etag} for value in str(header or "").split(","))


def manifest_bytes(manifest: dict[str, str], revision: str) -> bytes:
    payload = {
        "revision": revision,
        "assets": {
            f"/assets/{path}": {
                "source_sha256": digest,
                "url": f"/assets/{path}?v={revision}",
            }
            for path, digest in sorted(manifest.items())
        },
    }
    return (json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode()
