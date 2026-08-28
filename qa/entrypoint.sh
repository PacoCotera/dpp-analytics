#!/bin/sh
set -u
base_url="${1:-http://127.0.0.1:8088}"
out_root="${2:-/out}"
work_dir="$out_root/captures"
mkdir -p "$work_dir"
node /qa/visual_qa.mjs "$base_url" "$work_dir"
visual_rc=$?
node /qa/nav_qa.mjs "$base_url" "$work_dir"
nav_rc=$?
node /qa/accessibility_qa.mjs "$base_url" "$work_dir"
accessibility_rc=$?
node /qa/analysis_state_qa.mjs "$base_url" "$work_dir"
analysis_state_rc=$?
node /qa/numeric_ui_qa.mjs "$base_url" "$work_dir"
numeric_rc=$?
node /qa/ui_format_qa.mjs "$base_url" "$work_dir"
ui_format_rc=$?
node /qa/geography_qa.mjs "$base_url" "$work_dir"
geography_rc=$?
node /qa/geography_zoom_qa.mjs "$base_url" "$work_dir"
geography_zoom_rc=$?
node /qa/order_operations_qa.mjs "$base_url" "$work_dir"
order_operations_rc=$?
node /qa/product_naming_qa.mjs "$base_url" "$work_dir"
product_naming_rc=$?
node /qa/ads_surface_qa.mjs "$base_url" "$work_dir"
ads_surface_rc=$?
node /qa/footer_qa.mjs "$base_url" "$work_dir"
footer_rc=$?
node /qa/asset_revision_qa.mjs "$base_url" "$work_dir"
asset_revision_rc=$?
node /qa/favicon_qa.mjs "$base_url" "$work_dir"
favicon_rc=$?
node /qa/timezone_qa.mjs "$base_url" "$work_dir"
timezone_rc=$?
node /qa/cache_performance_qa.mjs "$base_url" "$work_dir"
cache_performance_rc=$?
node /qa/load_time_qa.mjs "$base_url" "$work_dir"
load_time_rc=$?
node /qa/performance_baseline_qa.mjs "$work_dir" /qa/performance-baseline.json
performance_baseline_rc=$?
node /qa/catalog_onboarding_qa.mjs "$base_url" "$work_dir"
catalog_onboarding_rc=$?
node /qa/interpretation_rules_qa.mjs "$base_url" "$work_dir"
interpretation_rules_rc=$?
node /qa/metric_windows_qa.mjs "$base_url" "$work_dir"
metric_windows_rc=$?
node /qa/inventory_qa.mjs "$base_url" "$work_dir"
inventory_rc=$?
node /qa/admin_qa.mjs "$base_url" "$work_dir"
admin_rc=$?
cp -a "$work_dir"/. "$out_root"/ 2>/dev/null || true
if [ "$visual_rc" -ne 0 ]; then exit "$visual_rc"; fi
if [ "$nav_rc" -ne 0 ]; then exit "$nav_rc"; fi
if [ "$accessibility_rc" -ne 0 ]; then exit "$accessibility_rc"; fi
if [ "$analysis_state_rc" -ne 0 ]; then exit "$analysis_state_rc"; fi
if [ "$numeric_rc" -ne 0 ]; then exit "$numeric_rc"; fi
if [ "$ui_format_rc" -ne 0 ]; then exit "$ui_format_rc"; fi
if [ "$geography_rc" -ne 0 ]; then exit "$geography_rc"; fi
if [ "$geography_zoom_rc" -ne 0 ]; then exit "$geography_zoom_rc"; fi
if [ "$order_operations_rc" -ne 0 ]; then exit "$order_operations_rc"; fi
if [ "$product_naming_rc" -ne 0 ]; then exit "$product_naming_rc"; fi
if [ "$ads_surface_rc" -ne 0 ]; then exit "$ads_surface_rc"; fi
if [ "$footer_rc" -ne 0 ]; then exit "$footer_rc"; fi
if [ "$asset_revision_rc" -ne 0 ]; then exit "$asset_revision_rc"; fi
if [ "$favicon_rc" -ne 0 ]; then exit "$favicon_rc"; fi
if [ "$timezone_rc" -ne 0 ]; then exit "$timezone_rc"; fi
if [ "$cache_performance_rc" -ne 0 ]; then exit "$cache_performance_rc"; fi
if [ "$load_time_rc" -ne 0 ]; then exit "$load_time_rc"; fi
if [ "$performance_baseline_rc" -ne 0 ]; then exit "$performance_baseline_rc"; fi
if [ "$interpretation_rules_rc" -ne 0 ]; then exit "$interpretation_rules_rc"; fi
if [ "$metric_windows_rc" -ne 0 ]; then exit "$metric_windows_rc"; fi
if [ "$inventory_rc" -ne 0 ]; then exit "$inventory_rc"; fi
if [ "$admin_rc" -ne 0 ]; then exit "$admin_rc"; fi
exit "$catalog_onboarding_rc"
