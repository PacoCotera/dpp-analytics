FROM mcr.microsoft.com/playwright:v1.55.0-noble
WORKDIR /qa
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY visual_qa.mjs ./
COPY nav_qa.mjs ./
COPY sidebar_subtitle_qa.mjs ./
COPY presentation_profiles_qa.mjs ./
COPY accessibility_qa.mjs ./
COPY audit_batch1_qa.mjs ./
COPY analysis_state_qa.mjs ./
COPY manual_sync_qa.mjs ./
COPY today_day_picker_qa.mjs ./
COPY today_mobile_benchmark_qa.mjs ./
COPY trajectory_lead_caption_qa.mjs ./
COPY trajectory_axis_ticks_qa.mjs ./
COPY data_health_disclosure_qa.mjs ./
COPY sales_driver_units_qa.mjs ./
COPY sales_momentum_qa.mjs ./
COPY sales_layout_qa.mjs ./
COPY catalog_family_overflow_qa.mjs ./
COPY choice_reveal_qa.mjs ./
COPY percentage_format_qa.mjs ./
COPY shared_control_targets_qa.mjs ./
COPY numeric_ui_qa.mjs ./
COPY ui_format_qa.mjs ./
COPY geography_qa.mjs ./
COPY geography_zoom_qa.mjs ./
COPY order_operations_qa.mjs ./
COPY product_naming_qa.mjs ./
COPY ads_surface_qa.mjs ./
COPY footer_qa.mjs ./
COPY short_state_footer_qa.mjs ./
COPY asset_revision_qa.mjs ./
COPY favicon_qa.mjs ./
COPY timezone_qa.mjs ./
COPY cache_performance_qa.mjs ./
COPY load_time_qa.mjs ./
COPY performance_baseline_qa.mjs ./
COPY performance-baseline.json ./
COPY catalog_onboarding_qa.mjs ./
COPY interpretation_rules_qa.mjs ./
COPY metric_windows_qa.mjs ./
COPY inventory_qa.mjs ./
COPY admin_qa.mjs ./
COPY entrypoint.sh ./
RUN chmod +x /qa/entrypoint.sh
ENTRYPOINT ["/qa/entrypoint.sh"]
