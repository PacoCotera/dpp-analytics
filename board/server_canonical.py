from __future__ import annotations

import json
import os
from http.server import ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from admin_auth import AdminAuth, admin_client_allowed
from admin_config import (
    AdminConfigError,
    RevisionConflict,
    build_admin_catalog,
    load_config_snapshot,
    save_sku_config,
)
import server_legacy as legacy
from catalog_api import catalog_payload as build_raw_catalog_payload
from catalog_onboarding import apply_catalog_onboarding
from geo_reference import postal_geometry
from home_api import home_payload as build_home_payload
from sales_geography_api import sales_geography_payload as build_sales_geography_payload


legacy.home_payload = lambda: build_home_payload(legacy.connect, legacy.decorate_products, legacy.MARKETPLACE)
legacy.build_catalog_payload = lambda connect, decorate_products, marketplace: apply_catalog_onboarding(
    build_raw_catalog_payload(connect, decorate_products, marketplace),
    connect,
    marketplace,
)

ADMIN_INDEX = legacy.versioned_page("admin.html")
ADMIN_AUTH = AdminAuth(os.getenv("DPP_ADMIN_PASSWORD", ""))
ADMIN_COOKIE_SECURE = os.getenv("DPP_ADMIN_COOKIE_SECURE", "false").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
ADMIN_ALLOW_REMOTE = os.getenv("DPP_ADMIN_ALLOW_REMOTE", "false").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
ADMIN_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; img-src 'self' https: data:; "
        "style-src 'self'; script-src 'self'; connect-src 'self'; "
        "base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    ),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
}


def _catalog_payload():
    return legacy.build_catalog_payload(legacy.connect, legacy.decorate_products, legacy.MARKETPLACE)


class Handler(legacy.Handler):
    """Canonical additions on top of the mature router."""

    def admin_json(self, status: int, payload: dict, *, headers: dict | None = None):
        response_headers = dict(ADMIN_HEADERS)
        response_headers.update(headers or {})
        self.send_bytes(
            status,
            "application/json",
            json.dumps(legacy.clean(payload), separators=(",", ":")).encode(),
            cache="no-store",
            headers=response_headers,
        )

    def admin_client_allowed(self) -> bool:
        address = self.client_address[0] if self.client_address else ""
        return admin_client_allowed(address, allow_remote=ADMIN_ALLOW_REMOTE)

    def require_admin_client(self) -> bool:
        if self.admin_client_allowed():
            return True
        self.admin_json(403, {"error": "Admin is available only through the secure operator path"})
        return False

    def admin_session(self):
        return ADMIN_AUTH.session(self.headers.get("Cookie"))

    def read_admin_json(self, maximum: int = 32768) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise AdminConfigError("Invalid request size") from exc
        if length < 1 or length > maximum:
            raise AdminConfigError("Invalid request size")
        try:
            payload = json.loads(self.rfile.read(length))
        except json.JSONDecodeError as exc:
            raise AdminConfigError("Request body must be valid JSON") from exc
        if not isinstance(payload, dict):
            raise AdminConfigError("Request body must be an object")
        return payload

    def require_admin(self, *, csrf: bool = False):
        session = self.admin_session()
        if not session:
            self.admin_json(401, {"error": "Authentication required"})
            return None
        if csrf and not ADMIN_AUTH.verify_csrf(session, self.headers.get("X-CSRF-Token")):
            self.admin_json(403, {"error": "Invalid CSRF token"})
            return None
        return session

    def do_GET(self):
        parsed = urlsplit(self.path)
        query = parse_qs(parsed.query)
        if (parsed.path == "/admin" or parsed.path.startswith("/api/admin/")) and not self.require_admin_client():
            return
        if parsed.path == "/admin":
            etag = legacy.asset_etag(ADMIN_INDEX)
            headers = {
                **ADMIN_HEADERS,
                "ETag": etag,
                "X-DPP-Asset-Revision": legacy.ASSET_VERSION,
            }
            if legacy.etag_matches(self.headers.get("If-None-Match", ""), etag):
                self.send_bytes(304, "text/html; charset=utf-8", b"", cache="no-cache", headers=headers)
            else:
                self.send_bytes(
                    200,
                    "text/html; charset=utf-8",
                    ADMIN_INDEX,
                    cache="no-cache",
                    headers=headers,
                )
            return
        if parsed.path == "/api/admin/session":
            session = self.admin_session()
            self.admin_json(
                200,
                {
                    "authenticated": bool(session),
                    "configured": ADMIN_AUTH.configured,
                    "csrf_token": session.csrf_token if session else None,
                },
            )
            return
        if parsed.path == "/api/admin/catalog":
            session = self.require_admin()
            if not session:
                return
            try:
                snapshot = load_config_snapshot()
                self.admin_json(200, build_admin_catalog(_catalog_payload(), snapshot))
            except AdminConfigError as exc:
                self.admin_json(503, {"error": str(exc)})
            except Exception:
                self.admin_json(500, {"error": "Unable to load Admin catalog"})
            return
        if parsed.path == "/api/sales/geography":
            self.json_endpoint(
                lambda: build_sales_geography_payload(
                    legacy.connect,
                    legacy.decorate_products,
                    legacy.MARKETPLACE,
                ),
                cache_key=legacy.api_cache_key(parsed.path, query),
                ttl_seconds=300,
                refresh=legacy.cache_refresh_requested(query),
            )
            return
        if parsed.path == "/api/geography/postal-geometry":
            state = (query.get("state") or [""])[0]
            raw_codes = (query.get("codes") or [""])[0]
            codes = [value for value in raw_codes.split(",") if value]
            self.json_endpoint(lambda: postal_geometry(state, codes))
            return
        super().do_GET()

    def do_POST(self):
        path = urlsplit(self.path).path
        if path.startswith("/api/admin/") and not self.require_admin_client():
            return
        if path == "/api/admin/login":
            try:
                payload = self.read_admin_json(4096)
                status, session = ADMIN_AUTH.login(
                    payload.get("password", ""),
                    self.client_address[0] if self.client_address else "unknown",
                )
                if status == "unconfigured":
                    self.admin_json(503, {"error": "Admin access is not configured"})
                elif status == "rate_limited":
                    self.admin_json(429, {"error": "Too many sign-in attempts; try again later"})
                elif status != "authenticated" or session is None:
                    self.admin_json(401, {"error": "Invalid credentials"})
                else:
                    self.admin_json(
                        200,
                        {"authenticated": True, "csrf_token": session.csrf_token},
                        headers={
                            "Set-Cookie": ADMIN_AUTH.cookie_header(
                                session,
                                secure=ADMIN_COOKIE_SECURE,
                            )
                        },
                    )
            except AdminConfigError as exc:
                self.admin_json(400, {"error": str(exc)})
            return
        if path == "/api/admin/logout":
            session = self.require_admin(csrf=True)
            if not session:
                return
            ADMIN_AUTH.logout(session)
            self.admin_json(
                200,
                {"authenticated": False},
                headers={"Set-Cookie": ADMIN_AUTH.clear_cookie_header(secure=ADMIN_COOKIE_SECURE)},
            )
            return
        if path == "/api/admin/product":
            session = self.require_admin(csrf=True)
            if not session:
                return
            try:
                payload = self.read_admin_json()
                admin_catalog = build_admin_catalog(_catalog_payload(), load_config_snapshot())
                editable_skus = {row["sku"] for row in admin_catalog["current_products"]}
                result = save_sku_config(payload, editable_skus=editable_skus)
                legacy.API_CACHE.clear()
                self.admin_json(200, result)
            except RevisionConflict as exc:
                self.admin_json(409, {"error": str(exc)})
            except AdminConfigError as exc:
                self.admin_json(400, {"error": str(exc)})
            except Exception:
                self.admin_json(500, {"error": "Unable to save product configuration"})
            return
        super().do_POST()


health_payload = legacy.health_payload
connect = legacy.connect


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
