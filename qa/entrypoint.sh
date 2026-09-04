#!/bin/sh
set -u

base_url="${1:-http://127.0.0.1:8088}"
out_root="${2:-/out}"
work_dir="$out_root/captures"
rc_dir="$(mktemp -d)"
mkdir -p "$work_dir"

cleanup() {
  rm -rf "$rc_dir"
}
trap cleanup EXIT INT TERM

run_check() {
  script="$1"
  shift
  node "/qa/$script.mjs" "$@"
  printf '%s\n' "$?" >"$rc_dir/$script"
}

wait_batch() {
  for pid in "$@"; do
    wait "$pid" || true
  done
}

# visual_qa owns the top-level summary/report and clears the output directory at
# startup, so it must finish before independent checks begin writing evidence.
run_check visual_qa "$base_url" "$work_dir"

# The self-hosted runner has a hard execution ceiling below the workflow's
# nominal timeout. Run independent browser contracts in bounded groups of three:
# enough concurrency to complete the full matrix, without the memory pressure of
# launching all Playwright engines at once.
scripts="
nav_qa
sidebar_subtitle_qa
presentation_profiles_qa
accessibility_qa
audit_batch1_qa
audit_422_qa
analysis_state_qa
today_day_picker_qa
today_mobile_benchmark_qa
trajectory_lead_caption_qa
trajectory_axis_ticks_qa
data_health_disclosure_qa
sales_driver_units_qa
sales_momentum_qa
sales_layout_qa
catalog_family_overflow_qa
choice_reveal_qa
mobile_layout_qa
percentage_format_qa
shared_control_targets_qa
numeric_ui_qa
ui_format_qa
geography_qa
geography_zoom_qa
order_operations_qa
product_naming_qa
ads_surface_qa
ads_cross_route_qa
footer_qa
short_state_footer_qa
asset_revision_qa
favicon_qa
timezone_qa
cache_performance_qa
load_time_qa
catalog_onboarding_qa
interpretation_rules_qa
metric_windows_qa
inventory_qa
"

set --
for script in $scripts; do
  run_check "$script" "$base_url" "$work_dir" &
  set -- "$@" "$!"
  if [ "$#" -ge 3 ]; then
    wait_batch "$@"
    set --
  fi
done
if [ "$#" -gt 0 ]; then
  wait_batch "$@"
fi

# This check consumes the cache/load summaries produced above.
run_check performance_baseline_qa "$work_dir" /qa/performance-baseline.json

# Manual sync changes source lifecycle state, and Admin authenticates against a
# shared session endpoint. Keep both serialized after the read-only checks.
run_check manual_sync_qa "$base_url" "$work_dir"
run_check admin_qa "$base_url" "$work_dir"

cp -a "$work_dir"/. "$out_root"/ 2>/dev/null || true

first_failure=0
for result in "$rc_dir"/*; do
  rc="$(cat "$result")"
  if [ "$rc" -ne 0 ] && [ "$first_failure" -eq 0 ]; then
    first_failure="$rc"
  fi
done
exit "$first_failure"
