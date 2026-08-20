FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .
COPY sales_api.py .
COPY today_api.py .
COPY product_api.py .
COPY finance_api.py .
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
swipe = (static / 'swipe-tabs.js').read_text()
swipe_tag = '<script>\n' + swipe + '\n</script>'
nav = (static / 'nav-enhance.js').read_text()
nav_tag = '<script>\n' + nav + '\n</script>'
for page in static.glob('*.html'):
    text = page.read_text()
    if '</head>' in text and 'Mobile-specific information design' not in text:
        text = text.replace('</head>', mobile_tag + '\n</head>', 1)
    if '</body>' in text and 'touch swipe navigation for tabbed workspaces' not in text:
        text = text.replace('</body>', swipe_tag + '\n</body>', 1)
    if '</body>' in text and "href = '/ads'" not in text:
        text = text.replace('</body>', nav_tag + '\n</body>', 1)
    page.write_text(text)

finance = static / 'finance.html'
text = finance.read_text()
enhance = (static / 'finance-enhance.js').read_text()
enhance_tag = '<script>\n' + enhance + '\n</script>'
if '</body>' in text and 'maximum COGS + off-Amazon cost' not in text:
    finance.write_text(text.replace('</body>', enhance_tag + '\n</body>', 1))

today = static / 'today.html'
text = today.read_text()
today_enhance = (static / 'today-clarity.js').read_text()
today_tag = '<script>\n' + today_enhance + '\n</script>'
if '</body>' in text and 'Today clarity pass: compact recent-day selector' not in text:
    today.write_text(text.replace('</body>', today_tag + '\n</body>', 1))
PY
# Fail the image build before production replacement if imports or static assets are broken.
RUN python -c "import server; print('board import smoke test: ok')"
EXPOSE 8080
CMD ["python", "server.py"]
