FROM python:3.13-slim
WORKDIR /app
ARG DEPLOY_SHA=dev
COPY board/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

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

# Keep the mature HTTP router as a stable legacy module. server_canonical.py
# replaces only payload owners that need stronger canonical contracts.
COPY board/server.py ./server_legacy.py
COPY board/server_canonical.py ./server.py
COPY board/geo_reference.py .
COPY board/home_api.py .
# Keep the mature API implementations as legacy readers and make the canonical
# monetary-basis adapters the production module names imported by server_legacy.py.
COPY board/sales_api.py ./sales_api_legacy.py
COPY board/sales_api_canonical.py ./sales_api.py
COPY board/today_api.py ./today_api_legacy.py
COPY board/today_api_canonical.py ./today_api.py
COPY board/product_api.py ./product_api_legacy.py
COPY board/product_api_canonical.py ./product_api.py
COPY board/ads_context.py .
# Finance legacy reader owns period-state/immutable-close behavior. The adapter
# corrects OPEN/finalizing Sales & Traffic from gross shopper spend to net revenue;
# closed history is already corrected by explicit RESTATED versions in migration 037.
COPY board/finance_emergency.py ./finance_api_legacy.py
COPY board/finance_api_corrected.py ./finance_api.py
COPY board/inventory_api.py .
COPY board/catalog_api.py .
COPY board/trajectory_api.py .
COPY board/health_api.py .
COPY board/ads_api.py .
COPY board/product_labels.json .
COPY board/product_costs.json .
COPY board/product_variations.json .
COPY board/static ./static
COPY .git/refs/heads/main .build_main_ref
RUN DEPLOY_SHA="$DEPLOY_SHA" python - <<'PY'
from pathlib import Path
import os
import re

static = Path('static')
raw_sha = os.getenv('DEPLOY_SHA', '').strip()
if not re.fullmatch(r'[0-9a-fA-F]{40}', raw_sha):
    raw_sha = Path('.build_main_ref').read_text().strip()
build_sha = raw_sha[:8].lower() if re.fullmatch(r'[0-9a-fA-F]{40}', raw_sha) else 'dev'

# Every operating page owns its page-specific basis/source copy, but the shell
# identity and deployed revision are one shared footer contract.  Do not depend
# on an exact prose phrase being present: inject the revision structurally into
# every footer so new pages cannot silently omit it.
footer_re = re.compile(r'(<footer\b[^>]*class=["\'][^"\']*\bfooter\b[^"\']*["\'][^>]*>)(.*?)(</footer>)', re.I | re.S)
old_stamp_re = re.compile(r'\s*·\s*main\s+[0-9a-fA-F]{7,40}\b', re.I)

for page in static.glob('*.html'):
    text = old_stamp_re.sub('', page.read_text())

    def stamp(match):
        opening, body, closing = match.groups()
        # Strip a prior dedicated stamp if a locally-built file is rebuilt.
        body = re.sub(r'\s*<span\s+class=["\']footer-build["\'][^>]*>.*?</span>\s*', '\n', body, flags=re.I | re.S)
        return f'{opening}{body}\n        <span class="footer-build">main {build_sha}</span>\n      {closing}'

    text, count = footer_re.subn(stamp, text, count=1)
    if count != 1:
        raise RuntimeError(f'{page}: expected exactly one .footer element, found {count}')
    page.write_text(text)
PY
RUN python -c "import server; print('board import smoke test: ok')"
EXPOSE 8080
CMD ["python", "server.py"]
