FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY dpp_analytics ./dpp_analytics
# Preserve the mature close machinery under an explicit legacy module. Both the
# scheduler and deployment close command route through the corrected tax-basis
# entry point, so raw Sales & Traffic gross is never frozen as net revenue.
RUN mv dpp_analytics/finance_close.py dpp_analytics/finance_close_legacy.py \
    && mv dpp_analytics/finance_close_corrected.py dpp_analytics/finance_close.py

# Fail the image build before replacing production if a scheduler dependency is
# missing or a newly added collector has a syntax/import error.
RUN python -m compileall -q dpp_analytics && python - <<'PY'
import dpp_analytics.scheduler
import dpp_analytics.amazon_ads
import dpp_analytics.finance_close
import dpp_analytics.finance_close_tax_corrected
PY
RUN python -m unittest discover -v -s dpp_analytics -t . -p 'test_*.py'

CMD ["python", "-m", "dpp_analytics.scheduler"]
