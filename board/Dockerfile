FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .
COPY sales_api.py .
COPY today_api.py .
COPY product_api.py .
COPY finance_api.py .
COPY finance_emergency.py ./finance_api.py
COPY inventory_api.py .
COPY catalog_api.py .
COPY trajectory_api.py .
COPY health_api.py .
COPY ads_api.py .
COPY product_labels.json .
COPY product_costs.json .
COPY static ./static
RUN python - <<'PY'
from pathlib import Path

static = Path('static')

mobile_css = (static / 'mobile-ux.css').read_text()
mobile_tag = '<style>\n' + mobile_css + '\n</style>'
refine_css = (static / 'design-refine.css').read_text()
refine_tag = '<style>\n' + refine_css + '\n</style>'
swipe = (static / 'swipe-tabs.js').read_text()
swipe_tag = '<script>\n' + swipe + '\n</script>'
nav = (static / 'nav-enhance.js').read_text()
nav_tag = '<script>\n' + nav + '\n</script>'
for page in static.glob('*.html'):
    text = page.read_text()
    if '</head>' in text and 'Mobile-specific information design' not in text:
        text = text.replace('</head>', mobile_tag + '\n</head>', 1)
    if '</head>' in text and 'Summary reads are editorial hierarchy' not in text:
        text = text.replace('</head>', refine_tag + '\n</head>', 1)
    if '</body>' in text and 'touch swipe navigation for tabbed workspaces' not in text:
        text = text.replace('</body>', swipe_tag + '\n</body>', 1)
    if '</body>' in text and "href = '/ads'" not in text:
        text = text.replace('</body>', nav_tag + '\n</body>', 1)
    page.write_text(text)

today = static / 'today.html'
text = today.read_text()
today_enhance = (static / 'today-clarity.js').read_text()
today_tag = '<script>\n' + today_enhance + '\n</script>'
if '</body>' in text and 'Today clarity pass: compact recent-day selector' not in text:
    today.write_text(text.replace('</body>', today_tag + '\n</body>', 1))

product = static / 'product.html'
text = product.read_text()
product_ads = (static / 'product-ads-enhance.js').read_text()
product_ads_tag = '<script>\n' + product_ads + '\n</script>'
if '</body>' in text and 'Paid support is part of this product' not in text:
    product.write_text(text.replace('</body>', product_ads_tag + '\n</body>', 1))

sales = static / 'sales.html'
text = sales.read_text()
sales_ads = (static / 'sales-ads-enhance.js').read_text()
sales_ads_tag = '<script>\n' + sales_ads + '\n</script>'
if '</body>' in text and 'Advertising context is ready to connect' not in text:
    sales.write_text(text.replace('</body>', sales_ads_tag + '\n</body>', 1))

home = static / 'home.html'
text = home.read_text()
home_layout = (static / 'home-operating-v4.css').read_text()
home_layout_tag = '<style>\n' + home_layout + '\n</style>'
if '</head>' in text and 'Home operating layout v4' not in text:
    text = text.replace('</head>', home_layout_tag + '\n</head>', 1)
home_weekly = (static / 'home-weekly-rhythm.js').read_text()
home_weekly_tag = '<script>\n' + home_weekly + '\n</script>'
chart_tag = '<script src="/assets/chart-system.js"></script>'
if 'Home weekly rhythm v1' not in text and chart_tag in text:
    text = text.replace(chart_tag, chart_tag + home_weekly_tag, 1)
home_ads = (static / 'home-ads-enhance.js').read_text()
home_ads_tag = '<script>\n' + home_ads + '\n</script>'
if '</body>' in text and 'Paid-support efficiency is broadly stable' not in text:
    text = text.replace('</body>', home_ads_tag + '\n</body>', 1)
home.write_text(text)

ads = static / 'ads.html'
text = ads.read_text()
ads_targeting = (static / 'ads-targeting-enhance.js').read_text()
ads_targeting_tag = '<script>\n' + ads_targeting + '\n</script>'
if '</body>' in text and 'ads-targeting-search-term-workspaces-v1' not in text:
    ads.write_text(text.replace('</body>', ads_targeting_tag + '\n</body>', 1))

finance = static / 'finance.html'
text = finance.read_text()
finance_ads = (static / 'finance-ads-reconcile.js').read_text()
finance_ads_tag = '<script>\n' + finance_ads + '\n</script>'
if '</body>' in text and 'Advertising has two accounting clocks.' not in text:
    text = text.replace('</body>', finance_ads_tag + '\n</body>', 1)
finance_manager = (static / 'finance-manager-v2.js').read_text()
finance_manager_tag = '<script>\n' + finance_manager + '\n</script>'
if '</body>' in text and 'Sales → deductions → contribution' not in text:
    text = text.replace('</body>', finance_manager_tag + '\n</body>', 1)
finance_progression = (static / 'finance-month-progression.js').read_text()
finance_progression_tag = '<script>\n' + finance_progression + '\n</script>'
if '</body>' in text and 'finance-month-progression-v1' not in text:
    text = text.replace('</body>', finance_progression_tag + '\n</body>', 1)
finance_cost = (static / 'finance-cost-clarity.js').read_text()
finance_cost_tag = '<script>\n' + finance_cost + '\n</script>'
if '</body>' in text and 'Historical months not yet management-closed' not in text:
    text = text.replace('</body>', finance_cost_tag + '\n</body>', 1)
finance.write_text(text)
PY
# Fail the image build before production replacement if imports or static assets are broken.
RUN python -c "import server; print('board import smoke test: ok')"
EXPOSE 8080
CMD ["python", "server.py"]
