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
