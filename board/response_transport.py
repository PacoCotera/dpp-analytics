from __future__ import annotations

import gzip
import mimetypes
from functools import lru_cache
from pathlib import Path


COMPRESSIBLE_CONTENT_TYPES = (
    "application/geo+json",
    "application/json",
    "application/javascript",
    "image/svg+xml",
    "text/",
)
MIN_COMPRESSIBLE_BYTES = 1024


def asset_content_type(path: Path) -> str:
    if path.suffix == ".js":
        return "text/javascript; charset=utf-8"
    if path.suffix == ".css":
        return "text/css; charset=utf-8"
    if path.suffix == ".geojson":
        return "application/geo+json"
    content_type, _ = mimetypes.guess_type(path.name)
    if content_type and content_type.startswith("text/"):
        return f"{content_type}; charset=utf-8"
    return content_type or "application/octet-stream"


def accepts_gzip(value: str) -> bool:
    for item in value.split(","):
        encoding, *parameters = item.strip().lower().split(";")
        if encoding not in {"gzip", "*"}:
            continue
        quality = 1.0
        for parameter in parameters:
            name, separator, raw_value = parameter.strip().partition("=")
            if separator and name == "q":
                try:
                    quality = float(raw_value)
                except ValueError:
                    quality = 0.0
        if quality > 0:
            return True
    return False


def compressible_content_type(content_type: str) -> bool:
    media_type = content_type.split(";", 1)[0].strip().lower()
    return any(
        media_type == prefix or (prefix.endswith("/") and media_type.startswith(prefix))
        for prefix in COMPRESSIBLE_CONTENT_TYPES
    )


@lru_cache(maxsize=128)
def gzip_body(body: bytes) -> bytes:
    return gzip.compress(body, compresslevel=6, mtime=0)


def compress_response(
    content_type: str,
    body: bytes,
    accept_encoding: str,
) -> tuple[bytes, dict[str, str]]:
    if not compressible_content_type(content_type):
        return body, {}

    headers = {"Vary": "Accept-Encoding"}
    if len(body) < MIN_COMPRESSIBLE_BYTES or not accepts_gzip(accept_encoding):
        return body, headers

    compressed = gzip_body(body)
    if len(compressed) >= len(body):
        return body, headers
    headers["Content-Encoding"] = "gzip"
    return compressed, headers


@lru_cache(maxsize=None)
def read_asset(path: Path) -> bytes:
    return path.read_bytes()
