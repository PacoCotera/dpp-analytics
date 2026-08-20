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
js = (static / 'swipe-tabs.js').read_text()
tag = '<script>\n' + js + '\n</script>'
for page in static.glob('*.html'):
    text = page.read_text()
    if '</body>' in text and 'touch swipe navigation for tabbed workspaces' not in text:
        page.write_text(text.replace('</body>', tag + '\n</body>', 1))
PY
EXPOSE 8080
CMD ["python", "server.py"]
