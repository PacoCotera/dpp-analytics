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
node /qa/numeric_ui_qa.mjs "$base_url" "$work_dir"
numeric_rc=$?
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
node /qa/cache_performance_qa.mjs "$base_url" "$work_dir"
cache_performance_rc=$?
cp -a "$work_dir"/. "$out_root"/ 2>/dev/null || true
if [ "$visual_rc" -ne 0 ]; then exit "$visual_rc"; fi
if [ "$nav_rc" -ne 0 ]; then exit "$nav_rc"; fi
if [ "$numeric_rc" -ne 0 ]; then exit "$numeric_rc"; fi
if [ "$geography_rc" -ne 0 ]; then exit "$geography_rc"; fi
if [ "$geography_zoom_rc" -ne 0 ]; then exit "$geography_zoom_rc"; fi
if [ "$order_operations_rc" -ne 0 ]; then exit "$order_operations_rc"; fi
if [ "$product_naming_rc" -ne 0 ]; then exit "$product_naming_rc"; fi
if [ "$ads_surface_rc" -ne 0 ]; then exit "$ads_surface_rc"; fi
if [ "$footer_rc" -ne 0 ]; then exit "$footer_rc"; fi
exit "$cache_performance_rc"
