#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-/etc/dpp-analytics/env}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-sql/migrations}"

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

echo "Migrations complete."
