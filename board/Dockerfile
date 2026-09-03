FROM python:3.13-slim
WORKDIR /app
ARG DEPLOY_SHA=dev
ENV DPP_BUILD_SHA=${DEPLOY_SHA}
COPY board/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY board/geo_reference.py board/bundle_geography_reference.py ./

# Pin the lightweight textual SEPOMEX catalog inside the board image. This gives
# geography stable municipality/city/settlement labels without making the UI or
# API depend on a best-effort third-party service at runtime.
RUN python - <<'PY'
from io import BytesIO
from pathlib import Path
from urllib.request import Request, urlopen
from zipfile import ZipFile

url = 'https://github.com/open-mexico/sepomex-db-generator/releases/download/v1.2.0/db_postal.sqlite.zip'
request = Request(url, headers={'User-Agent': 'Dirty-Pawz-Press-Analytics/1.0'})
with urlopen(request, timeout=120) as response:
    archive = response.read()
with ZipFile(BytesIO(archive)) as zf:
    sqlite_members = [name for name in zf.namelist() if name.lower().endswith('.sqlite')]
    if len(sqlite_members) != 1:
        raise RuntimeError(f'Expected one SQLite postal catalog, found {sqlite_members!r}')
    target = Path('/app/reference/db_postal.sqlite')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(zf.read(sqlite_members[0]))
PY

# Postal drill-down geometry is fetched only while building the immutable image,
# from an exact MIT-licensed source commit. Runtime map requests read the
# validated compressed copies under /app/reference and never contact GitHub.
RUN python bundle_geography_reference.py

# Keep the mature HTTP router as a stable legacy module. server_canonical.py
# replaces only payload owners that need stronger canonical contracts.
COPY board/server.py ./server_legacy.py
COPY board/server_canonical.py ./server.py
COPY board/asset_release.py .
COPY board/response_cache.py .
COPY board/response_transport.py .
COPY board/admin_auth.py .
COPY board/admin_config.py .
COPY board/interpretation_rules.py .
COPY board/metric_windows.py .
COPY board/home_api.py .
# Keep the mature API implementations as legacy readers and make the canonical
# monetary-basis adapters the production module names imported by server_legacy.py.
COPY board/sales_api.py ./sales_api_legacy.py
COPY board/sales_api_canonical.py ./sales_api.py
COPY board/sales_geography_api.py .
COPY board/today_api.py ./today_api_legacy.py
COPY board/today_api_canonical.py ./today_api.py
COPY board/product_api.py ./product_api_legacy.py
COPY board/product_api_canonical.py ./product_api.py
COPY board/ads_context.py .
COPY board/ads_state.py .
COPY board/ads_decisions.py .
# Finance legacy reader owns period-state/immutable-close behavior. The adapter
# corrects OPEN/finalizing Sales & Traffic from gross shopper spend to net revenue;
# closed history is already corrected by explicit RESTATED versions in migration 037.
COPY board/finance_emergency.py ./finance_api_legacy.py
COPY board/finance_settlement.py .
COPY board/finance_api_corrected.py ./finance_api.py
COPY board/inventory_api.py .
COPY board/catalog_api.py .
COPY board/catalog_onboarding.py .
COPY board/trajectory_api.py .
COPY board/health_contract.py .
COPY board/health_api.py .
COPY board/ads_api.py .
COPY board/product_labels.json .
COPY board/product_costs.json .
COPY board/product_variations.json .
COPY board/static ./static
COPY .git/refs/heads/main .build_main_ref
RUN python -c "import server; print('board import smoke test: ok')"
EXPOSE 8080
CMD ["python", "server.py"]
