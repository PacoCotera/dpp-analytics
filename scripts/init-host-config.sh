#!/usr/bin/env bash
set -euo pipefail

ROOT=/etc/dpp-analytics
CONFIG_DIR="$ROOT/board-config"

prepare_config() {
  local label="$1"
  local template="$2"
  local target="$3"
  local legacy="$4"

  # A previous single-file bind could make Docker create a missing path as a
  # directory. Remove only that known bad directory shape; preserve real files.
  if sudo test -d "$legacy"; then
    sudo rm -rf "$legacy"
  fi
  if sudo test -d "$target"; then
    sudo rm -rf "$target"
  fi

  # Preserve any legacy regular file by migrating it into the config directory.
  if sudo test -f "$legacy" && ! sudo test -f "$target"; then
    sudo cp "$legacy" "$target"
  fi

  # Seed only when missing. Deployments never overwrite seller-owned config.
  if ! sudo test -f "$target"; then
    sudo install -m 0644 "$template" "$target"
  fi

  sudo python3 -m json.tool "$target" >/dev/null
  echo "Host $label config ready: $target"
}

sudo install -d -m 0750 "$CONFIG_DIR"

prepare_config \
  "product cost" \
  "board/product_costs.json" \
  "$CONFIG_DIR/product_costs.json" \
  "$ROOT/product_costs.json"

prepare_config \
  "product taxonomy" \
  "board/product_variations.json" \
  "$CONFIG_DIR/product_variations.json" \
  "$ROOT/product_variations.json"

# Merge newly introduced canonical taxonomy entries without replacing any
# seller-owned values already present on the host.
sudo python3 - "$CONFIG_DIR/product_variations.json" "board/product_variations.json" <<'PY'
import json
import os
import tempfile
import sys
from pathlib import Path

target = Path(sys.argv[1])
template = Path(sys.argv[2])
current = json.loads(target.read_text())
defaults = json.loads(template.read_text())

def merge_missing(existing, seed):
    if not isinstance(existing, dict) or not isinstance(seed, dict):
        return existing
    for key, value in seed.items():
        if key not in existing:
            existing[key] = value
        elif isinstance(existing[key], dict) and isinstance(value, dict):
            merge_missing(existing[key], value)
    return existing

merged = merge_missing(current, defaults)
fd, temporary = tempfile.mkstemp(prefix=".product-variations.", suffix=".json", dir=target.parent)
try:
    with os.fdopen(fd, "w") as handle:
        json.dump(merged, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.chmod(temporary, 0o644)
    os.replace(temporary, target)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY

sudo python3 -m json.tool "$CONFIG_DIR/product_variations.json" >/dev/null
