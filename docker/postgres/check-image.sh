#!/usr/bin/env bash
# Starts an instance's Postgres image and checks what an instance relies on:
#
#   check-image.sh IMAGE
#
# - Debian, glibc and Postgres are those of the pinned base: trixie, glibc 2.41, Postgres 17.11,
#   and no database reports a collation version other than the library's;
# - pgvector is available at the pinned version, and whether it is a trusted extension is what
#   reference/infrastructure.md records (no), since provisioning relies on that answer;
# - the extension is created in one database and is in no other, a `halfvec` column ranks by
#   cosine distance exactly and through an HNSW index;
# - a dump of that database, vectors included, restores into a scratch database and ranks the
#   same there.
#
# The container publishes no port and is removed when the check ends.
set -euo pipefail

[[ $# -eq 1 ]] || { echo "usage: check-image.sh IMAGE" >&2; exit 2; }
image=$1
name="catalyst-postgres-check-$$-$RANDOM"
pgvector_version=0.8.7

fail() {
  echo "check-image: $1" >&2
  [[ -z ${GITHUB_ACTIONS:-} ]] || echo "::error title=Postgres image::$1"
  exit 1
}
trap 'docker rm --force --volumes "$name" >/dev/null 2>&1 || true' EXIT

docker run --detach --name "$name" \
  --env POSTGRES_USER=catalyst --env POSTGRES_PASSWORD=image-check --env POSTGRES_DB=catalyst \
  "$image" >/dev/null

# Over TCP: the server that runs the first-start scripts listens on the socket only.
ready=""
for _ in $(seq 60); do
  if docker exec "$name" pg_isready --quiet --host 127.0.0.1 --username catalyst --dbname catalyst; then
    ready=yes
    break
  fi
  sleep 1
done
[[ -n $ready ]] || { docker logs "$name" >&2; fail "$image did not accept connections within a minute"; }

# One statement, one value, as the superuser the platform connects as.
sql() {
  local database=$1
  shift
  docker exec -i "$name" psql --no-psqlrc --quiet --tuples-only --no-align \
    --set ON_ERROR_STOP=1 --username catalyst --dbname "$database" "$@"
}
expect() {
  local what=$1 got=$2 want=$3
  [[ $got == "$want" ]] || fail "$what: expected '$want', got '$got'"
  echo "check-image: $what: $got"
}

expect "Debian release" "$(docker exec "$name" sh -c '. /etc/os-release && echo "$VERSION_CODENAME"')" trixie
expect "glibc" "$(docker exec "$name" sh -c 'ldd --version | head -n 1 | awk "{ print \$NF }"')" 2.41
expect "Postgres" "$(sql catalyst --command 'show server_version' | awk '{ print $1 }')" 17.11
expect "databases whose collation version differs from the library's" "$(sql catalyst --command \
  "select count(*) from pg_database
   where datcollversion is distinct from pg_database_collation_actual_version(oid)
     and datcollversion is not null")" 0
expect "pgvector available" "$(sql catalyst --command \
  "select default_version from pg_available_extensions where name = 'vector'")" "$pgvector_version"
# pgvector's control file sets no `trusted`: a database owner who is no superuser cannot create
# it. Provisioning still takes CREATE on the database from a store's roles where it is trusted;
# a change here is recorded in reference/infrastructure.md before the image is pinned.
expect "pgvector trusted" "$(sql catalyst --command \
  "select trusted from pg_available_extension_versions
   where name = 'vector' and version = '$pgvector_version'")" f

sql catalyst --command "create database kb_store" >/dev/null
sql kb_store <<'SQL' >/dev/null
create extension vector;
create table chunks (id integer primary key, embedding halfvec(3) not null);
insert into chunks values (1, '[1,0,0]'), (2, '[0,1,0]'), (3, '[0.9,0.1,0]'), (4, '[0,0,1]');
SQL
nearest="select string_agg(id::text, ',' order by embedding <=> '[1,0.05,0]', id) from chunks"
expect "exact ranking" "$(sql kb_store --command "$nearest")" "1,3,2,4"
sql kb_store --command "create index on chunks using hnsw (embedding halfvec_cosine_ops)" >/dev/null
expect "ranking through HNSW" "$(sql kb_store --command \
  "set enable_seqscan = off; select string_agg(id::text, ',') from (
     select id from chunks order by embedding <=> '[1,0.05,0]' limit 2) nearest")" "1,3"
for database in catalyst postgres template1; do
  expect "extension in $database" "$(sql "$database" --command \
    "select count(*) from pg_extension where extname = 'vector'")" 0
done

sql catalyst --command "create database kb_restore" >/dev/null
docker exec "$name" sh -c \
  'pg_dump --username catalyst --format custom kb_store | pg_restore --username catalyst --exit-on-error --dbname kb_restore'
expect "rows after restore" "$(sql kb_restore --command "select count(*) from chunks")" 4
expect "ranking after restore" "$(sql kb_restore --command "$nearest")" "1,3,2,4"
expect "extension after restore" "$(sql kb_restore --command \
  "select extversion from pg_extension where extname = 'vector'")" "$pgvector_version"

echo "check-image: $image holds what an instance relies on"
