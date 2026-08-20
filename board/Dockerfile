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
COPY product_labels.json .
COPY static ./static
RUN python - <<'PY'
from pathlib import Path

static = Path('static')

swipe = (static / 'swipe-tabs.js').read_text()
swipe_tag = '<script>\n' + swipe + '\n</script>'
for page in static.glob('*.html'):
    text = page.read_text()
    if '</body>' in text and 'touch swipe navigation for tabbed workspaces' not in text:
        page.write_text(text.replace('</body>', swipe_tag + '\n</body>', 1))

finance = static / 'finance.html'
text = finance.read_text()
enhance = (static / 'finance-enhance.js').read_text()
enhance_tag = '<script>\n' + enhance + '\n</script>'
if '</body>' in text and 'maximum COGS + off-Amazon cost' not in text:
    finance.write_text(text.replace('</body>', enhance_tag + '\n</body>', 1))
PY
EXPOSE 8080
CMD ["python", "server.py"]
