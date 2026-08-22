FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY dpp_analytics ./dpp_analytics

# Fail the image build before replacing production if a scheduler dependency is
# missing or a newly added collector has a syntax/import error.
RUN python -m compileall -q dpp_analytics && python - <<'PY'
import dpp_analytics.scheduler
import dpp_analytics.amazon_ads
import dpp_analytics.finance_close
import dpp_analytics.finance_close_tax_corrected
PY

CMD ["python", "-m", "dpp_analytics.scheduler"]
