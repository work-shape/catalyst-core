#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  restore-postgres.sh list
  restore-postgres.sh verify [DUMP]
  restore-postgres.sh recover DUMP --replace-database NAME

Runs on the VPS. DUMP is an object key as printed by "list", e.g.
"postgres/<name>.tar" (nightly) or "pre-deploy/<name>.tar" (taken by a deploy).
A .tar backup holds every database of the server and its roles; a .sql.gz dump,
written before backups held more, holds the platform database only. "verify"
uses the newest backup when DUMP is omitted.

  list     Print the backups in the bucket (date, size in bytes, key), oldest
           first, across both prefixes.
  verify   Restore each database of DUMP into a scratch database next to the
           live one, print row counts per table for both, then drop the scratch
           database. Does not touch the live databases, the roles or the app
           containers.
  recover  Replace the live databases with the ones in DUMP. Refuses to run
           while app containers are up. NAME must be the live platform database.
           Each replaced database is renamed and kept, not dropped. A .tar
           backup also creates the roles the server lacks and sets every role
           as in the backup, except the one in POSTGRES_USER.
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

if [[ -n "$dump" && ! "$dump" =~ ^(postgres|pre-deploy)/[A-Za-z0-9_.-]+\.(tar|sql\.gz)$ ]]; then
  echo "Invalid dump key: $dump (expected postgres/<name>.tar or pre-deploy/<name>.tar, or .sql.gz)" >&2
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
      ${docker_args[@]+"${docker_args[@]}"} \
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
      | awk -v prefix="$prefix" '$4 ~ /\.(tar|sql\.gz)$/ { print $1 "T" $2 "Z", $3, prefix "/" $4 }'
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
tmp_dir="$(mktemp -d)"
# Databases this script made and drops again on exit, also after a failure.
scratch_databases=()
# Set while a recovery from an archive replaces databases: an exit before it finishes, at any
# step, puts every database back as it was.
recovering=""

cleanup() {
  if [[ -n "$recovering" ]]; then
    recovering=""
    echo "The recovery did not finish. Putting back the databases as they were." >&2
    undo_recovery
  fi
  rm -rf "$tmp_dir"
  local database
  for database in ${scratch_databases[@]+"${scratch_databases[@]}"}; do
    if database_exists "$database"; then
      psql_sql postgres "drop database \"$database\"" || true
    fi
  done
}
trap cleanup EXIT

# The name of a database the script makes next to DATABASE: <database>_<kind>_<timestamp>.
# Postgres would cut a name longer than 63 bytes and then not find it again.
side_name() {
  local name="$1_$2_${timestamp}"
  if (( ${#name} > 63 )); then
    echo "Database name longer than Postgres allows: $name" >&2
    return 1
  fi
  printf '%s\n' "$name"
}

# Prints the row counts of a restored database next to the live one.
compare_counts() {
  local restored="$1" live="$2" live_name="$3"
  echo "Row counts (restored vs. live database $live_name; live rows may have changed since the backup):"
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
  ' "$restored" "$live" | { read -r header; echo "$header"; sort; }
  echo "Tables: restored $(wc -l < "$restored" | tr -d ' '), live $(wc -l < "$live" | tr -d ' ')"
  echo "Rows:   restored $(awk '{ s += $2 } END { print s + 0 }' "$restored"), live $(awk '{ s += $2 } END { print s + 0 }' "$live")"
}

live_counts() {
  if database_exists "$1"; then
    row_counts "$1"
  fi
}

dump_file="${dump##*/}"
echo "Downloading $dump"
aws_cli --user "$(id -u):$(id -g)" -v "$tmp_dir:/backup" -- \
  s3 cp --only-show-errors "${bucket_url}${dump}" "/backup/$dump_file"

# A backup before OPS-BK-1: one gzipped plain dump of the platform database.
restore_single_dump() {
  gzip -t "$tmp_dir/$dump_file"
  echo "Dump size: $(wc -c < "$tmp_dir/$dump_file" | tr -d ' ') bytes, gzip integrity ok"

  local target_db
  target_db="$(side_name "$POSTGRES_DB" restore)"
  scratch_databases=("$target_db")
  echo "Restoring into database $target_db"
  local restore_started
  restore_started="$(date +%s)"
  psql_sql postgres "create database \"$target_db\" owner \"$POSTGRES_USER\""
  gunzip -c "$tmp_dir/$dump_file" | psql_db "$target_db" --single-transaction > /dev/null
  echo "Restore finished in $(( $(date +%s) - restore_started ))s"

  row_counts "$target_db" > "$tmp_dir/restored.counts"
  if [[ ! -s "$tmp_dir/restored.counts" ]]; then
    echo "Restored database contains no tables." >&2
    exit 1
  fi
  live_counts "$POSTGRES_DB" > "$tmp_dir/live.counts"
  echo
  compare_counts "$tmp_dir/restored.counts" "$tmp_dir/live.counts" "$POSTGRES_DB"

  if [[ "$mode" == "verify" ]]; then
    echo "Verification done. Dropping $target_db."
    exit 0
  fi

  local replaced_db
  replaced_db="$(side_name "$POSTGRES_DB" replaced)"
  echo
  echo "About to replace database $POSTGRES_DB on $(hostname) with $dump."
  echo "The current database is kept as $replaced_db."
  confirm_recovery

  if database_exists "$POSTGRES_DB"; then
    psql_sql postgres "alter database \"$POSTGRES_DB\" rename to \"$replaced_db\""
  fi
  psql_sql postgres "alter database \"$target_db\" rename to \"$POSTGRES_DB\""
  scratch_databases=()

  echo "Recovered $POSTGRES_DB from $dump."
  echo "Start the app again, check it, then drop the old database when it is no longer needed:"
  print_drop_command "$replaced_db"
}

confirm_recovery() {
  local answer
  read -r -p "Type the database name to continue: " answer
  if [[ "$answer" != "$POSTGRES_DB" ]]; then
    echo "Aborted. Nothing was replaced." >&2
    exit 1
  fi
}

print_drop_command() {
  echo "  docker compose --env-file $env_file -f $app_dir/docker-compose.prod.yml exec -T postgres psql -U $POSTGRES_USER -d postgres -c 'drop database \"$1\"'"
}

pg_restore_db() {
  compose exec -T postgres pg_restore -U "$POSTGRES_USER" "$@"
}

# Writes one part of the backup's globals.sql for this server. "create": the CREATE ROLE
# statements of the roles the server lacks. "settings": everything else, which sets
# attributes, passwords, settings and memberships as in the backup. Both leave out the role
# this script connects as: its password is the one in the env file.
globals_part() {
  awk -v skip="$POSTGRES_USER" -v part="$1" '
    # The role a CREATE or ALTER ROLE statement names, also when quoted with "" inside.
    function role_name(rest,   name, i, c) {
      if (substr(rest, 1, 1) != "\"") {
        sub(/[ ;].*$/, "", rest)
        return rest
      }
      name = ""
      for (i = 2; i <= length(rest); i++) {
        c = substr(rest, i, 1)
        if (c == "\"") {
          if (substr(rest, i + 1, 1) != "\"") break
          i++
        }
        name = name c
      }
      return name
    }
    NR == FNR { have[$0] = 1; next }
    /^(CREATE|ALTER) ROLE / {
      rest = $0
      sub(/^(CREATE|ALTER) ROLE /, "", rest)
      role = role_name(rest)
      if (role == skip) next
      if ($0 ~ /^CREATE ROLE /) {
        if (part == "create" && !(role in have)) print
        next
      }
    }
    part == "settings" { print }
  ' "$tmp_dir/existing.roles" "$archive/globals.sql"
}

# Puts back every database a failed recovery moved: drops the one it restored and gives the
# replaced one its name again.
undo_recovery() {
  local i
  for (( i = swapped - 1; i >= 0; i-- )); do
    # FORCE ends a restore that may still run inside the container after this script was stopped.
    psql_sql postgres "drop database if exists \"${databases[i]}\" with (force)" || true
    if database_exists "${replaced[i]}"; then
      psql_sql postgres "alter database \"${replaced[i]}\" rename to \"${databases[i]}\"" || true
    fi
  done
}

# A backup since OPS-BK-1: a tar archive with globals.sql and one <database>.dump per database.
restore_archive() {
  archive="$tmp_dir/archive"
  mkdir "$archive"
  tar -xf "$tmp_dir/$dump_file" -C "$archive"
  rm "$tmp_dir/$dump_file"
  if [[ ! -s "$archive/globals.sql" ]]; then
    echo "The backup holds no globals.sql." >&2
    exit 1
  fi
  local file database
  databases=()
  for file in "$archive"/*.dump; do
    [[ -f "$file" ]] || continue
    database="${file##*/}"
    database="${database%.dump}"
    # The name goes into SQL literals below, as in backup-postgres.sh.
    if [[ ! "$database" =~ ^[A-Za-z0-9_.-]+$ ]]; then
      echo "The backup holds a dump of an unsupported database name: $database" >&2
      exit 1
    fi
    databases+=("$database")
  done
  if [[ " ${databases[*]-} " != *" $POSTGRES_DB "* ]]; then
    echo "The backup holds no dump of $POSTGRES_DB." >&2
    exit 1
  fi
  for database in "${databases[@]}"; do
    pg_restore_db -l < "$archive/$database.dump" > /dev/null
  done
  echo "Backup size: $(du -sk "$archive" | cut -f1) KiB unpacked; roles: $(grep -c '^CREATE ROLE ' "$archive/globals.sql" || true); databases: ${databases[*]}"

  if [[ "$mode" == "verify" ]]; then
    local scratch restore_started
    for database in "${databases[@]}"; do
      scratch="$(side_name "$database" restore)"
      scratch_databases+=("$scratch")
      echo
      echo "== $database: restoring into $scratch"
      restore_started="$(date +%s)"
      psql_sql postgres "create database \"$scratch\" template template0"
      # Owners and grants name roles, which a verify does not create; the recovery restores them.
      pg_restore_db -d "$scratch" --no-owner --no-acl --single-transaction \
        < "$archive/$database.dump"
      echo "Restore finished in $(( $(date +%s) - restore_started ))s"
      row_counts "$scratch" > "$tmp_dir/restored.counts"
      if [[ "$database" == "$POSTGRES_DB" && ! -s "$tmp_dir/restored.counts" ]]; then
        echo "Restored database contains no tables." >&2
        exit 1
      fi
      live_counts "$database" > "$tmp_dir/live.counts"
      compare_counts "$tmp_dir/restored.counts" "$tmp_dir/live.counts" "$database"
      psql_sql postgres "drop database \"$scratch\""
    done
    echo
    echo "Verification done. The scratch databases are dropped."
    exit 0
  fi

  local other_databases sessions existed=()
  replaced=()
  echo
  echo "About to replace these databases on $(hostname) with $dump:"
  for database in "${databases[@]}"; do
    replaced+=("$(side_name "$database" replaced)")
    if database_exists "$database"; then
      existed+=(1)
      echo "  $database (the current one is kept as ${replaced[${#replaced[@]} - 1]})"
    else
      existed+=("")
      echo "  $database (not on the server)"
    fi
  done
  other_databases="$(psql_sql postgres "
    select datname from pg_catalog.pg_database
    where not datistemplate and datname <> 'postgres'
      and datname !~ '_(restore|replaced)_[0-9]{8}t[0-9]{6}z$'
    order by datname" | grep -v -x -F "${databases[@]/#/-e}" || true)"
  if [[ -n "$other_databases" ]]; then
    echo "Not in the backup, so left as they are: $(paste -sd ' ' - <<< "$other_databases")"
  fi
  # A database with a session open cannot be renamed. Stop before anything changes.
  sessions="$(psql_sql postgres "
    select datname || ' (' || count(*) || ')' from pg_catalog.pg_stat_activity
    where datname in ($(printf "'%s'," "${databases[@]}" | sed 's/,$//'))
      and pid <> pg_catalog.pg_backend_pid()
    group by datname order by datname")"
  if [[ -n "$sessions" ]]; then
    echo "Sessions are still open on: $(paste -sd ' ' - <<< "$sessions"). Close them first; nothing was changed." >&2
    exit 1
  fi
  echo "Roles the server lacks are created, and every role is set as in the backup, except $POSTGRES_USER."
  psql_sql postgres "select rolname from pg_catalog.pg_roles" > "$tmp_dir/existing.roles"
  globals_part create > "$tmp_dir/create-roles.sql"
  globals_part settings > "$tmp_dir/set-roles.sql"
  confirm_recovery

  # The missing roles first, without login or other attributes: the owners and grants in the
  # dumps name them.
  psql_db postgres --single-transaction < "$tmp_dir/create-roles.sql" > /dev/null
  # Each database is moved aside and created again from its dump with its owner, grants and
  # settings. From here on, a failure at any step puts back every database moved so far.
  local index
  swapped=0
  recovering=1
  for (( index = 0; index < ${#databases[@]}; index++ )); do
    database="${databases[index]}"
    echo "Recovering $database"
    if [[ -n "${existed[index]}" ]]; then
      psql_sql postgres "alter database \"$database\" rename to \"${replaced[index]}\""
    fi
    swapped=$((index + 1))
    pg_restore_db -d postgres --create --exit-on-error < "$archive/$database.dump"
  done
  # The roles last, in one transaction: if it fails, the roles stay as they were and the
  # databases are put back.
  psql_db postgres --single-transaction < "$tmp_dir/set-roles.sql" > /dev/null
  recovering=""

  echo "Recovered ${databases[*]} from $dump."
  echo "Start the app again, check it, then drop the old databases when they are no longer needed:"
  for (( index = 0; index < ${#databases[@]}; index++ )); do
    if database_exists "${replaced[index]}"; then
      print_drop_command "${replaced[index]}"
    fi
  done
}

case "$dump_file" in
  *.tar) restore_archive ;;
  *) restore_single_dump ;;
esac
