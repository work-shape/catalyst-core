#!/usr/bin/env bash
set -euo pipefail

# Usage: backup-postgres.sh [LABEL]
# Backs up every database of the Postgres server and its roles into one tar archive,
# <instance>-<database>-<timestamp>[-<label>].tar, and uploads it to the backup bucket.
# LABEL is appended to the name, e.g. "pre-deploy-v2026.10.06-1".
# BACKUP_PREFIX selects the key prefix in the bucket: "postgres" (default, nightly
# backups) or "pre-deploy" (backups taken by deploy.sh).
label="${1:-}"
if [[ -n "$label" && ! "$label" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  echo "Invalid backup label: $label" >&2
  exit 2
fi

app_dir="${APP_DIR:-/opt/vivd-catalyst/@INSTANCE@}"
env_file="${ENV_FILE:-/etc/vivd-catalyst/@INSTANCE@/app.env}"
backup_prefix="${BACKUP_PREFIX:-postgres}"
aws_cli_image="${AWS_CLI_IMAGE:-amazon/aws-cli:2.37.9}"

if [[ ! -f "$env_file" ]]; then
  echo "Missing env file: $env_file" >&2
  exit 1
fi

read_env_file_value() {
  local key="$1"
  awk -v key="$key" '
    /^[[:space:]]*($|#)/ { next }
    {
      line = $0
      sub(/^[[:space:]]+/, "", line)
      if (index(line, key "=") == 1) {
        value = substr(line, length(key) + 2)
        sub(/^[[:space:]]+/, "", value)
        sub(/[[:space:]]+$/, "", value)
        first = substr(value, 1, 1)
        last = substr(value, length(value), 1)
        if ((first == "\"" && last == "\"") || (first == "\047" && last == "\047")) {
          value = substr(value, 2, length(value) - 2)
        }
        found = value
      }
    }
    END {
      if (found != "") {
        print found
      }
    }
  ' "$env_file"
}

env_or_file_value() {
  local key="$1"
  if [[ -n "${!key:-}" ]]; then
    printf '%s\n' "${!key}"
  else
    read_env_file_value "$key"
  fi
}

POSTGRES_USER="$(env_or_file_value POSTGRES_USER)"
POSTGRES_DB="$(env_or_file_value POSTGRES_DB)"
BACKUP_OBJECT_STORE_ENDPOINT="$(env_or_file_value BACKUP_OBJECT_STORE_ENDPOINT)"
BACKUP_OBJECT_STORE_BUCKET="$(env_or_file_value BACKUP_OBJECT_STORE_BUCKET)"
BACKUP_OBJECT_STORE_REGION="$(env_or_file_value BACKUP_OBJECT_STORE_REGION)"
BACKUP_AWS_ACCESS_KEY_ID="$(env_or_file_value BACKUP_AWS_ACCESS_KEY_ID)"
BACKUP_AWS_SECRET_ACCESS_KEY="$(env_or_file_value BACKUP_AWS_SECRET_ACCESS_KEY)"

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${BACKUP_OBJECT_STORE_ENDPOINT:?BACKUP_OBJECT_STORE_ENDPOINT is required}"
: "${BACKUP_OBJECT_STORE_BUCKET:?BACKUP_OBJECT_STORE_BUCKET is required}"
: "${BACKUP_OBJECT_STORE_REGION:?BACKUP_OBJECT_STORE_REGION is required}"
: "${BACKUP_AWS_ACCESS_KEY_ID:?BACKUP_AWS_ACCESS_KEY_ID is required}"
: "${BACKUP_AWS_SECRET_ACCESS_KEY:?BACKUP_AWS_SECRET_ACCESS_KEY is required}"

# A database name becomes a file name in the archive and a literal in SQL.
database_name_pattern='^[A-Za-z0-9_.-]+$'
if [[ ! "$POSTGRES_DB" =~ $database_name_pattern ]]; then
  echo "Unsupported POSTGRES_DB: $POSTGRES_DB" >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="@INSTANCE@-${POSTGRES_DB}-${timestamp}${label:+-$label}.tar"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cd "$app_dir"

postgres_exec() {
  docker compose --env-file "$env_file" -f "$app_dir/docker-compose.prod.yml" \
    exec -T postgres "$@" < /dev/null
}

# Every database of the server, read from the server itself: the platform database, each Data
# Store and whatever else it holds, so a store the platform has not recorded yet is not missed.
# Left out: the templates, "postgres" (initdb's empty maintenance database, unless it is the
# platform's), and the scratch and replaced databases that restore-postgres.sh names
# <database>_restore_<timestamp> and <database>_replaced_<timestamp>, and the test copy of a
# Data Store, <store database>_test: it is built again from the store's draft and never holds a
# live row (ADR-0031), and the platform rebuilds a copy it finds missing. Also left out, as
# pg_dumpall does, is a database an interrupted DROP DATABASE left invalid: nothing can connect
# to it, so it would fail every backup until it is dropped.
databases="$(postgres_exec psql -X -q -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  select datname from pg_catalog.pg_database
  where not datistemplate
    and datconnlimit <> -2
    and (datname <> 'postgres' or datname = '$POSTGRES_DB')
    and datname !~ '_(restore|replaced)_[0-9]{8}t[0-9]{6}z\$'
    and datname !~ '^catalyst_ds_[0-9a-f]+_test\$'
  order by datname")"

invalid_databases="$(postgres_exec psql -X -q -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "select datname from pg_catalog.pg_database where datconnlimit = -2 order by datname")"
if [[ -n "$invalid_databases" ]]; then
  echo "Left out, invalid after an interrupted DROP DATABASE (drop them): $(paste -sd ' ' - <<< "$invalid_databases")" >&2
fi

if ! grep -Fqx -e "$POSTGRES_DB" <<< "$databases"; then
  echo "The server has no database $POSTGRES_DB." >&2
  exit 1
fi

# One archive per backup: globals.sql (roles, their settings and memberships, from
# pg_dumpall --globals-only) and <database>.dump (pg_dump custom format) per database.
mkdir "$tmp_dir/archive"
postgres_exec pg_dumpall -U "$POSTGRES_USER" --globals-only > "$tmp_dir/archive/globals.sql"
while IFS= read -r database; do
  if [[ ! "$database" =~ $database_name_pattern ]]; then
    echo "Cannot back up database \"$database\": its name is not a file name." >&2
    exit 1
  fi
  postgres_exec pg_dump -U "$POSTGRES_USER" -Fc -d "$database" > "$tmp_dir/archive/$database.dump"
done <<< "$databases"
tar -C "$tmp_dir/archive" -cf "$tmp_dir/$name" .

docker run --rm \
  -e AWS_ACCESS_KEY_ID="$BACKUP_AWS_ACCESS_KEY_ID" \
  -e AWS_SECRET_ACCESS_KEY="$BACKUP_AWS_SECRET_ACCESS_KEY" \
  -v "$tmp_dir:/backup:ro" \
  "$aws_cli_image" \
  --endpoint-url "$BACKUP_OBJECT_STORE_ENDPOINT" \
  --region "$BACKUP_OBJECT_STORE_REGION" \
  s3 cp "/backup/$name" "s3://${BACKUP_OBJECT_STORE_BUCKET}/${backup_prefix}/${name}"

echo "Backup uploaded: ${backup_prefix}/${name} ($(wc -c < "$tmp_dir/$name" | tr -d ' ') bytes; globals and $(wc -l <<< "$databases" | tr -d ' ') databases: $(paste -sd ' ' - <<< "$databases"))"
