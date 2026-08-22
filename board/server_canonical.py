from __future__ import annotations

from http.server import ThreadingHTTPServer

import server_legacy as legacy
from home_api import home_payload as build_home_payload


# Keep the stable HTTP handler/router while replacing the inline Home payload with
# the canonical reconciled implementation. Other canonical adapters are already
# injected by the image composition.
legacy.home_payload = lambda: build_home_payload(legacy.connect, legacy.decorate_products, legacy.MARKETPLACE)

# Re-export for the existing Docker import smoke test and any local tooling.
Handler = legacy.Handler
health_payload = legacy.health_payload
connect = legacy.connect


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
