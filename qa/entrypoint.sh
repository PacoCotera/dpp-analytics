#!/bin/sh
set -u
base_url="${1:-http://127.0.0.1:8088}"
out_root="${2:-/out}"
work_dir="$out_root/captures"
mkdir -p "$work_dir"
node /qa/visual_qa.mjs "$base_url" "$work_dir"
rc=$?
cp -a "$work_dir"/. "$out_root"/ 2>/dev/null || true
exit "$rc"
