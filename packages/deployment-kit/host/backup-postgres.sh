#!/usr/bin/env bash
set -euo pipefail

# Usage: backup-postgres.sh [LABEL]
# LABEL is appended to the dump name, e.g. "pre-deploy-v2026.10.06-1".
# BACKUP_PREFIX selects the key prefix in the bucket: "postgres" (default, nightly
# dumps) or "pre-deploy" (dumps taken by deploy.sh).
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

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="@INSTANCE@-${POSTGRES_DB}-${timestamp}${label:+-$label}.sql.gz"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cd "$app_dir"

docker compose --env-file "$env_file" -f "$app_dir/docker-compose.prod.yml" \
  exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip -9 > "$tmp_dir/$name"

docker run --rm \
  -e AWS_ACCESS_KEY_ID="$BACKUP_AWS_ACCESS_KEY_ID" \
  -e AWS_SECRET_ACCESS_KEY="$BACKUP_AWS_SECRET_ACCESS_KEY" \
  -v "$tmp_dir:/backup:ro" \
  "$aws_cli_image" \
  --endpoint-url "$BACKUP_OBJECT_STORE_ENDPOINT" \
  --region "$BACKUP_OBJECT_STORE_REGION" \
  s3 cp "/backup/$name" "s3://${BACKUP_OBJECT_STORE_BUCKET}/${backup_prefix}/${name}"

echo "Backup uploaded: ${backup_prefix}/${name} ($(wc -c < "$tmp_dir/$name" | tr -d ' ') bytes)"
