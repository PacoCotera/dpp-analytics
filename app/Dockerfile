FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY dpp_analytics ./dpp_analytics
# Preserve the mature close implementation and overlay the verified Sales &
# Traffic tax-basis adapter under the canonical module name used by scheduler
# and deployment close jobs.
RUN mv dpp_analytics/finance_close.py dpp_analytics/finance_close_legacy.py \
    && mv dpp_analytics/finance_close_corrected.py dpp_analytics/finance_close.py

# Fail the image build before replacing production if a scheduler dependency is
# missing or a newly added collector has a syntax/import error.
RUN python -m compileall -q dpp_analytics && python - <<'PY'
import dpp_analytics.scheduler
import dpp_analytics.amazon_ads
import dpp_analytics.finance_close
PY

CMD ["python", "-m", "dpp_analytics.scheduler"]
