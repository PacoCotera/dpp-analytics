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

# Transitional compatibility only for pages not yet migrated to explicit source
# dependencies. Never inline CSS/JS contents here. Migrated pages declare their
# own assets in source and therefore pass through this loop unchanged apart from
# the build stamp (and the temporary global swipe-tabs compatibility layer).
shared_styles = (
    'mobile-ux.css',
    'design-refine.css',
    'nav-shell.css',
    'layout-system.css',
)
for page in static.glob('*.html'):
    text = page.read_text().replace('Dirty Pawz Press Analytics', footer_stamp)
    if '</head>' in text:
        tags = ''.join(
            f'<link rel="stylesheet" href="/assets/{name}">'
            for name in shared_styles
            if f'/assets/{name}' not in text
        )
        if tags:
            text = text.replace('</head>', tags + '\n</head>', 1)
    if '</body>' in text and '/assets/swipe-tabs.js' not in text:
        text = text.replace('</body>', '<script src="/assets/swipe-tabs.js"></script>\n</body>', 1)
    page.write_text(text)

# Today, Home, Sales, Inventory, Product Workspace and Finance own their
# DOM/state composition directly. Do not inject post-render layout, accounting
# or page-specific runtime layers into these canonical pages.

ads = static / 'ads.html'
text = ads.read_text()
if '/assets/ads-targeting-enhance.js' not in text:
    ads.write_text(text.replace('</body>', '<script src="/assets/ads-targeting-enhance.js"></script>\n</body>', 1))
PY
RUN python -c "import server; print('board import smoke test: ok')"
EXPOSE 8080
CMD ["python", "server.py"]
