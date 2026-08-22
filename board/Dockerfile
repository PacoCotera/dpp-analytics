FROM python:3.13-slim
WORKDIR /app
ARG DEPLOY_SHA=dev
COPY board/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Keep the mature HTTP router as a stable legacy module. server_canonical.py
# replaces only payload owners that need stronger canonical contracts.
COPY board/server.py ./server_legacy.py
COPY board/server_canonical.py ./server.py
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
# finance_emergency.py is the current immutable-close implementation. Copy it
# once under the module name imported by the router.
COPY board/finance_emergency.py ./finance_api.py
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
build_sha = raw_sha[:8] if re.fullmatch(r'[0-9a-fA-F]{40}', raw_sha) else 'dev'
footer_stamp = f'Dirty Pawz Press Analytics · main {build_sha}'

for page in static.glob('*.html'):
    page.write_text(page.read_text().replace('Dirty Pawz Press Analytics', footer_stamp))
PY
RUN python -c "import server; print('board import smoke test: ok')"
EXPOSE 8080
CMD ["python", "server.py"]
