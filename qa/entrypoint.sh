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
cp -a "$work_dir"/. "$out_root"/ 2>/dev/null || true
if [ "$visual_rc" -ne 0 ]; then exit "$visual_rc"; fi
exit "$nav_rc"
