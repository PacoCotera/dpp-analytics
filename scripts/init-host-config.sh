#!/usr/bin/env bash
set -euo pipefail

ROOT=/etc/dpp-analytics
CONFIG_DIR="$ROOT/board-config"
TARGET="$CONFIG_DIR/product_costs.json"
LEGACY="$ROOT/product_costs.json"
TEMPLATE="board/product_costs.json"

sudo install -d -m 0750 "$CONFIG_DIR"

# A previous single-file bind could make Docker create this missing path as a
# directory. Remove only that known bad directory shape; preserve any real file.
if sudo test -d "$LEGACY"; then
  sudo rm -rf "$LEGACY"
fi

# Same protection for the current config location.
if sudo test -d "$TARGET"; then
  sudo rm -rf "$TARGET"
fi

# If a legacy regular file ever exists, preserve its contents by migrating it.
if sudo test -f "$LEGACY" && ! sudo test -f "$TARGET"; then
  sudo cp "$LEGACY" "$TARGET"
fi

# Seed only when missing. Deployments must never overwrite seller-entered COGS.
if ! sudo test -f "$TARGET"; then
  sudo install -m 0644 "$TEMPLATE" "$TARGET"
fi

sudo python3 -m json.tool "$TARGET" >/dev/null

echo "Host product cost config ready: $TARGET"
