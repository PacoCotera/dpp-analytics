FROM python:3.13-slim
WORKDIR /app
ARG DEPLOY_SHA=dev
COPY board/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY board/server.py .
COPY board/sales_api.py .
COPY board/today_api.py .
COPY board/product_api.py .
COPY board/ads_context.py .
# finance_emergency.py is the current immutable-close implementation. Copy it
# once under the module name imported by server.py; do not copy an older module
# and overwrite it in the next layer.
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

# Frontend dependencies are source-controlled. The image build only adds a
# visible deployment stamp; it no longer injects CSS, JavaScript or page logic.
for page in static.glob('*.html'):
    page.write_text(page.read_text().replace('Dirty Pawz Press Analytics', footer_stamp))
PY
RUN python -c "import server; print('board import smoke test: ok')"
EXPOSE 8080
CMD ["python", "server.py"]
