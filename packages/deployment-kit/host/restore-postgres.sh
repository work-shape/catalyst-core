#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  restore-postgres.sh list
  restore-postgres.sh verify [DUMP]
  restore-postgres.sh recover DUMP --replace-database NAME

Runs on the VPS. DUMP is an object key as printed by "list", e.g.
"postgres/<name>.sql.gz" (nightly) or "pre-deploy/<name>.sql.gz" (taken by a
deploy). "verify" uses the newest dump when DUMP is omitted.

  list     Print the dumps in the backup bucket (date, size in bytes, key),
           oldest first, across both prefixes.
  verify   Restore DUMP into a scratch database next to the live one, print row
           counts per table for both, then drop the scratch database. Does not
           touch the live database or the app containers.
  recover  Restore DUMP into a new database and swap it in for the live one.
           Refuses to run while app containers are up. NAME must be the live
           database name. The replaced database is renamed and kept, not dropped.
USAGE
}

app_dir="${APP_DIR:-/opt/vivd-catalyst/@INSTANCE@}"
env_file="${ENV_FILE:-/etc/vivd-catalyst/@INSTANCE@/app.env}"
backup_prefixes=(postgres pre-deploy)
aws_cli_image="${AWS_CLI_IMAGE:-amazon/aws-cli:2.37.9}"

mode="${1:-}"
[[ $# -gt 0 ]] && shift
dump=""
replace_database=""

case "$mode" in
  list) ;;
  verify)
    if [[ $# -gt 0 ]]; then
      dump="$1"
      shift
    fi
    ;;
  recover)
    dump="${1:-}"
    [[ $# -gt 0 ]] && shift
    if [[ "${1:-}" == "--replace-database" ]]; then
      replace_database="${2:-}"
      shift
      [[ $# -gt 0 ]] && shift
    fi
    if [[ -z "$dump" || -z "$replace_database" ]]; then
      usage >&2
      exit 2
    fi
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

if [[ $# -gt 0 ]]; then
  echo "Unknown argument: $1" >&2
  usage >&2
  exit 2
fi

if [[ -n "$dump" && ! "$dump" =~ ^(postgres|pre-deploy)/[A-Za-z0-9_.-]+\.sql\.gz$ ]]; then
  echo "Invalid dump key: $dump (expected postgres/<name>.sql.gz or pre-deploy/<name>.sql.gz)" >&2
  exit 2
fi

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

bucket_url="s3://${BACKUP_OBJECT_STORE_BUCKET}/"

# Runs the AWS CLI with the backup credentials. Extra "docker run" options go
# before "--".
aws_cli() {
  local docker_args=()
  while [[ "$1" != "--" ]]; do
    docker_args+=("$1")
    shift
  done
  shift
  AWS_ACCESS_KEY_ID="$BACKUP_AWS_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$BACKUP_AWS_SECRET_ACCESS_KEY" \
    docker run --rm \
      -e AWS_ACCESS_KEY_ID \
      -e AWS_SECRET_ACCESS_KEY \
      "${docker_args[@]}" \
      "$aws_cli_image" \
      --endpoint-url "$BACKUP_OBJECT_STORE_ENDPOINT" \
      --region "$BACKUP_OBJECT_STORE_REGION" \
      "$@" < /dev/null
}

list_dumps() {
  local prefix
  for prefix in "${backup_prefixes[@]}"; do
    # "s3 ls" exits 1 for a prefix without objects.
    { aws_cli -- s3 ls "${bucket_url}${prefix}/" || true; } \
      | awk -v prefix="$prefix" '$4 ~ /\.sql\.gz$/ { print $1 "T" $2 "Z", $3, prefix "/" $4 }'
  done | sort
}

if [[ "$mode" == "list" ]]; then
  list_dumps
  exit 0
fi

compose() {
  docker compose --env-file "$env_file" -f "$app_dir/docker-compose.prod.yml" "$@"
}

# Runs psql inside the postgres container against the given database.
psql_db() {
  local database="$1"
  shift
  compose exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$database" "$@"
}

psql_sql() {
  local database="$1"
  local sql="$2"
  psql_db "$database" -At -F ' ' -c "$sql" < /dev/null
}

database_exists() {
  [[ "$(psql_sql postgres "select count(*) from pg_database where datname = '$1'")" == "1" ]]
}

row_counts() {
  psql_sql "$1" "
    select table_schema || '.' || table_name,
      (xpath('/row/c/text()', query_to_xml(
        format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
    from information_schema.tables
    where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema')
    order by 1"
}

cd "$app_dir"

if [[ "$mode" == "recover" ]]; then
  if [[ "$replace_database" != "$POSTGRES_DB" ]]; then
    echo "--replace-database must name the live database of this host." >&2
    exit 2
  fi
  running="$(compose ps --services --status running | grep -v -x -e postgres -e caddy || true)"
  if [[ -n "$running" ]]; then
    echo "Stop the app containers before a recovery. Still running:" >&2
    echo "$running" >&2
    exit 1
  fi
fi

if [[ -z "$dump" ]]; then
  dump="$(list_dumps | tail -n 1 | awk '{ print $3 }')"
  if [[ -z "$dump" ]]; then
    echo "No dumps found in $bucket_url" >&2
    exit 1
  fi
fi

timestamp="$(date -u +%Y%m%dt%H%M%Sz)"
target_db="${POSTGRES_DB}_restore_${timestamp}"
tmp_dir="$(mktemp -d)"
drop_target_on_exit="1"

cleanup() {
  rm -rf "$tmp_dir"
  if [[ "$drop_target_on_exit" == "1" ]]; then
    psql_sql postgres "drop database if exists \"$target_db\"" || true
  fi
}
trap cleanup EXIT

dump_file="${dump##*/}"
echo "Downloading $dump"
aws_cli --user "$(id -u):$(id -g)" -v "$tmp_dir:/backup" -- \
  s3 cp --only-show-errors "${bucket_url}${dump}" "/backup/$dump_file"
gzip -t "$tmp_dir/$dump_file"
echo "Dump size: $(wc -c < "$tmp_dir/$dump_file" | tr -d ' ') bytes, gzip integrity ok"

echo "Restoring into database $target_db"
restore_started="$(date +%s)"
psql_sql postgres "create database \"$target_db\" owner \"$POSTGRES_USER\""
gunzip -c "$tmp_dir/$dump_file" | psql_db "$target_db" --single-transaction > /dev/null
echo "Restore finished in $(( $(date +%s) - restore_started ))s"

row_counts "$target_db" > "$tmp_dir/restored.counts"
if [[ ! -s "$tmp_dir/restored.counts" ]]; then
  echo "Restored database contains no tables." >&2
  exit 1
fi
if database_exists "$POSTGRES_DB"; then
  row_counts "$POSTGRES_DB" > "$tmp_dir/live.counts"
else
  : > "$tmp_dir/live.counts"
fi

echo
echo "Row counts (restored dump vs. live database $POSTGRES_DB; live rows may have changed since the dump):"
awk '
  NR == FNR { restored[$1] = $2; tables[$1] = 1; next }
  { live[$1] = $2; tables[$1] = 1 }
  END {
    printf "%-60s %12s %12s\n", "table", "restored", "live"
    for (table in tables) {
      r = (table in restored) ? restored[table] : "missing"
      l = (table in live) ? live[table] : "missing"
      printf "%-60s %12s %12s%s\n", table, r, l, (r == l ? "" : "  <- differs")
    }
  }
' "$tmp_dir/restored.counts" "$tmp_dir/live.counts" | { read -r header; echo "$header"; sort; }
echo
echo "Tables: restored $(wc -l < "$tmp_dir/restored.counts" | tr -d ' '), live $(wc -l < "$tmp_dir/live.counts" | tr -d ' ')"
echo "Rows:   restored $(awk '{ s += $2 } END { print s + 0 }' "$tmp_dir/restored.counts"), live $(awk '{ s += $2 } END { print s + 0 }' "$tmp_dir/live.counts")"

if [[ "$mode" == "verify" ]]; then
  echo "Verification done. Dropping $target_db."
  exit 0
fi

replaced_db="${POSTGRES_DB}_replaced_${timestamp}"
echo
echo "About to replace database $POSTGRES_DB on $(hostname) with $dump."
echo "The current database is kept as $replaced_db."
read -r -p "Type the database name to continue: " answer
if [[ "$answer" != "$POSTGRES_DB" ]]; then
  echo "Aborted. Nothing was replaced." >&2
  exit 1
fi

if database_exists "$POSTGRES_DB"; then
  psql_sql postgres "alter database \"$POSTGRES_DB\" rename to \"$replaced_db\""
fi
psql_sql postgres "alter database \"$target_db\" rename to \"$POSTGRES_DB\""
drop_target_on_exit="0"

echo "Recovered $POSTGRES_DB from $dump."
echo "Start the app again, check it, then drop the old database when it is no longer needed:"
echo "  docker compose --env-file $env_file -f $app_dir/docker-compose.prod.yml exec -T postgres psql -U $POSTGRES_USER -d postgres -c 'drop database \"$replaced_db\"'"
