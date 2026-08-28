FROM mcr.microsoft.com/playwright:v1.55.0-noble
WORKDIR /qa
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY visual_qa.mjs ./
COPY nav_qa.mjs ./
COPY numeric_ui_qa.mjs ./
COPY geography_qa.mjs ./
COPY geography_zoom_qa.mjs ./
COPY order_operations_qa.mjs ./
COPY product_naming_qa.mjs ./
COPY ads_surface_qa.mjs ./
COPY footer_qa.mjs ./
COPY asset_revision_qa.mjs ./
COPY timezone_qa.mjs ./
COPY cache_performance_qa.mjs ./
COPY load_time_qa.mjs ./
COPY performance_baseline_qa.mjs ./
COPY performance-baseline.json ./
COPY catalog_onboarding_qa.mjs ./
COPY interpretation_rules_qa.mjs ./
COPY metric_windows_qa.mjs ./
COPY inventory_qa.mjs ./
COPY entrypoint.sh ./
RUN chmod +x /qa/entrypoint.sh
ENTRYPOINT ["/qa/entrypoint.sh"]
