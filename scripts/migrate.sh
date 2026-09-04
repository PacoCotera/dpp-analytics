#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-/etc/dpp-analytics/env}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-sql/migrations}"

# This script already runs before the application stack is deployed, so use it
# as the host-side safety gate for persistent board configuration as well.
# The helper is idempotent and never overwrites an existing product-cost file.
bash scripts/init-host-config.sh

if ! sudo test -r "$ENV_FILE"; then
  echo "Environment file not readable via sudo: $ENV_FILE" >&2
  exit 1
fi

env_value() {
  local key="$1"
  sudo grep -E "^${key}=" "$ENV_FILE" | tail -1 | cut -d= -f2-
}

POSTGRES_DB="$(env_value POSTGRES_DB)"
POSTGRES_USER="$(env_value POSTGRES_USER)"

if [[ -z "$POSTGRES_DB" || -z "$POSTGRES_USER" ]]; then
  echo "POSTGRES_DB/POSTGRES_USER missing from $ENV_FILE" >&2
  exit 1
fi

psql_cmd() {
  sudo docker compose --env-file "$ENV_FILE" exec -T postgres \
    psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"
}

psql_cmd <<'SQL'
CREATE SCHEMA IF NOT EXISTS ops;
CREATE TABLE IF NOT EXISTS ops.schema_migrations (
    filename text PRIMARY KEY,
    sha256 text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

shopt -s nullglob
files=("$MIGRATIONS_DIR"/*.sql)

if (( ${#files[@]} == 0 )); then
  echo "No migrations found in $MIGRATIONS_DIR"
  exit 0
fi

for file in "${files[@]}"; do
  name="$(basename "$file")"
  if [[ ! "$name" =~ ^[0-9]{3}_[A-Za-z0-9_.-]+\.sql$ ]]; then
    echo "Invalid migration filename: $name" >&2
    exit 1
  fi

  hash="$(sha256sum "$file" | awk '{print $1}')"
  existing="$(psql_cmd -Atc "SELECT sha256 FROM ops.schema_migrations WHERE filename = '$name';")"

  if [[ -n "$existing" ]]; then
    if [[ "$existing" != "$hash" ]]; then
      echo "Migration $name was modified after application." >&2
      echo "Recorded: $existing" >&2
      echo "Current:  $hash" >&2
      exit 1
    fi
    echo "SKIP  $name"
    continue
  fi

  echo "APPLY $name"
  {
    echo 'BEGIN;'
    cat "$file"
    printf "\nINSERT INTO ops.schema_migrations(filename, sha256) VALUES ('%s', '%s');\n" "$name" "$hash"
    echo 'COMMIT;'
  } | psql_cmd

done

maintenance_table="$(psql_cmd -Atc "SELECT to_regclass('ops.maintenance_action');")"
if [[ "$maintenance_table" == "ops.maintenance_action" ]]; then
  pending_raw_compaction="$(psql_cmd -Atc "
    SELECT count(*)
    FROM ops.maintenance_action
    WHERE action_name='compact_raw_payload_after_search_terms_reset'
      AND status='PENDING';
  ")"
  if [[ "$pending_raw_compaction" == "1" ]]; then
    echo "MAINTENANCE compact_raw_payload_after_search_terms_reset"
    # VACUUM FULL cannot run inside the transactional migration wrapper. The
    # migration first truncates the oversized canonical relation, creating the
    # working space needed to rewrite raw.api_payload and return deleted TOAST
    # pages to the host filesystem.
    psql_cmd -c "VACUUM (FULL, ANALYZE) raw.api_payload;"
    psql_cmd -c "
      UPDATE ops.maintenance_action
      SET status='COMPLETE', completed_at=now()
      WHERE action_name='compact_raw_payload_after_search_terms_reset';
    "
  fi
fi

echo "Migrations complete."
