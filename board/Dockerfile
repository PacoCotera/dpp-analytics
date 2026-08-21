FROM python:3.13-slim
WORKDIR /app
ARG DEPLOY_SHA=dev
COPY board/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY board/server.py .
COPY board/sales_api.py .
COPY board/today_api.py .
COPY board/product_api.py .
COPY board/finance_api.py .
COPY board/finance_emergency.py ./finance_api.py
COPY board/inventory_api.py .
COPY board/catalog_api.py .
COPY board/trajectory_api.py .
COPY board/health_api.py .
COPY board/ads_api.py .
COPY board/product_labels.json .
COPY board/product_costs.json .
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

mobile_css = (static / 'mobile-ux.css').read_text(); mobile_tag = '<style>\n' + mobile_css + '\n</style>'
refine_css = (static / 'design-refine.css').read_text(); refine_tag = '<style>\n' + refine_css + '\n</style>'
swipe = (static / 'swipe-tabs.js').read_text(); swipe_tag = '<script>\n' + swipe + '\n</script>'
nav = (static / 'nav-enhance.js').read_text(); nav_tag = '<script>\n' + nav + '\n</script>'
for page in static.glob('*.html'):
    text = page.read_text().replace('Dirty Pawz Press Analytics', footer_stamp)
    if '</head>' in text and 'Mobile-specific information design' not in text: text = text.replace('</head>', mobile_tag + '\n</head>', 1)
    if '</head>' in text and 'Summary reads are editorial hierarchy' not in text: text = text.replace('</head>', refine_tag + '\n</head>', 1)
    if '</body>' in text and 'touch swipe navigation for tabbed workspaces' not in text: text = text.replace('</body>', swipe_tag + '\n</body>', 1)
    if '</body>' in text and "href = '/ads'" not in text: text = text.replace('</body>', nav_tag + '\n</body>', 1)
    page.write_text(text)

# Today is standalone: its source HTML owns its DOM, styles, data loop and chart.
# Do not inject post-render Today compatibility/runtime layers here.

product = static / 'product.html'
text = product.read_text(); product_ads = (static / 'product-ads-enhance.js').read_text(); product_ads_tag = '<script>\n' + product_ads + '\n</script>'
if '</body>' in text and 'Paid support is part of this product' not in text: product.write_text(text.replace('</body>', product_ads_tag + '\n</body>', 1))

# Sales has one composition/runtime owner. Do not re-introduce post-render chart,
# rail, state, or ads mutation layers here.
sales = static / 'sales.html'; text = sales.read_text()
sales_layout = (static / 'sales-operating-v2.css').read_text(); sales_layout_tag = '<style>\n' + sales_layout + '\n</style>'
if '</head>' in text and 'Sales operating layout v2' not in text: text = text.replace('</head>', sales_layout_tag + '\n</head>', 1)
sales_state_css = (static / 'sales-state-rail.css').read_text(); sales_state_css_tag = '<style>\n' + sales_state_css + '\n</style>'
if '</head>' in text and 'sales-current-state-rail-v1' not in text: text = text.replace('</head>', sales_state_css_tag + '\n</head>', 1)
sales_runtime = (static / 'sales-canonical.js').read_text(); sales_runtime_tag = '<script>\n' + sales_runtime + '\n</script>'
if '</body>' in text and 'Sales canonical renderer v1' not in text: text = text.replace('</body>', sales_runtime_tag + '\n</body>', 1)
sales.write_text(text)

home = static / 'home.html'; text = home.read_text()
home_layout = (static / 'home-operating-v4.css').read_text(); home_layout_tag = '<style>\n' + home_layout + '\n</style>'
if '</head>' in text and 'Home operating layout v4' not in text: text = text.replace('</head>', home_layout_tag + '\n</head>', 1)
home_weekly = (static / 'home-weekly-rhythm.js').read_text(); home_weekly_tag = '<script>\n' + home_weekly + '\n</script>'; chart_tag = '<script src="/assets/chart-system.js"></script>'
if 'Home weekly rhythm v1' not in text and chart_tag in text: text = text.replace(chart_tag, chart_tag + home_weekly_tag, 1)
home_ads = (static / 'home-ads-enhance.js').read_text(); home_ads_tag = '<script>\n' + home_ads + '\n</script>'
if '</body>' in text and 'Paid-support efficiency is broadly stable' not in text: text = text.replace('</body>', home_ads_tag + '\n</body>', 1)
home.write_text(text)

ads = static / 'ads.html'; text = ads.read_text(); ads_targeting = (static / 'ads-targeting-enhance.js').read_text(); ads_targeting_tag = '<script>\n' + ads_targeting + '\n</script>'
if '</body>' in text and 'ads-targeting-search-term-workspaces-v1' not in text: ads.write_text(text.replace('</body>', ads_targeting_tag + '\n</body>', 1))

finance = static / 'finance.html'; text = finance.read_text()
finance_ads = (static / 'finance-ads-reconcile.js').read_text(); finance_ads_tag = '<script>\n' + finance_ads + '\n</script>'
if '</body>' in text and 'Advertising has two accounting clocks.' not in text: text = text.replace('</body>', finance_ads_tag + '\n</body>', 1)
finance_manager = (static / 'finance-manager-v2.js').read_text(); finance_manager_tag = '<script>\n' + finance_manager + '\n</script>'
if '</body>' in text and 'Sales → deductions → contribution' not in text: text = text.replace('</body>', finance_manager_tag + '\n</body>', 1)
finance_progression = (static / 'finance-month-progression.js').read_text(); finance_progression_tag = '<script>\n' + finance_progression + '\n</script>'
if '</body>' in text and 'finance-month-progression-v1' not in text: text = text.replace('</body>', finance_progression_tag + '\n</body>', 1)
finance_cost = (static / 'finance-cost-clarity.js').read_text(); finance_cost_tag = '<script>\n' + finance_cost + '\n</script>'
if '</body>' in text and 'Historical months not yet management-closed' not in text: text = text.replace('</body>', finance_cost_tag + '\n</body>', 1)
finance.write_text(text)
PY
RUN python -c "import server; print('board import smoke test: ok')"
EXPOSE 8080
CMD ["python", "server.py"]
