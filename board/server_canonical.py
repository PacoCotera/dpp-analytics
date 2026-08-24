from __future__ import annotations

from http.server import ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import server_legacy as legacy
from geo_reference import postal_geometry
from home_api import home_payload as build_home_payload
from sales_geography_api import sales_geography_payload as build_sales_geography_payload


legacy.home_payload = lambda: build_home_payload(legacy.connect, legacy.decorate_products, legacy.MARKETPLACE)


class Handler(legacy.Handler):
    """Canonical additions on top of the mature router."""

    def do_GET(self):
        parsed = urlsplit(self.path)
        query = parse_qs(parsed.query)
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


health_payload = legacy.health_payload
connect = legacy.connect


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
