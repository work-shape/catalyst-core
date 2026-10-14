#!/usr/bin/env bash
# Starts the database a job of the Check workflow tests against and waits until it accepts
# connections.
#
# A service container pulls from one registry and gives up after three tries within ten
# seconds; public.ecr.aws answered "toomanyrequests: Data limit exceeded" to a hosted runner
# and the job failed before its first step. This pulls the same image, by digest, from the
# first registry of its list that serves it without a sign-in, and tries the list three times.
set -euo pipefail

[[ $# -eq 4 ]] || { echo "usage: start-postgres.sh USER PASSWORD DATABASE HOST_PORT" >&2; exit 2; }
user=$1 password=$2 database=$3 port=$4
name=${CHECK_POSTGRES_NAME:-check-postgres}

# postgres:17.6 by the digest of .github/mirrored-images, the same index on every registry. The
# organisation's own copy comes first: it is public, so a pull request from a fork reads it too,
# and it has no limit for shared runner addresses. The public registries stay behind it.
digest=$(awk '$1 == "postgres:17.6" { print $2 }' "$(dirname "${BASH_SOURCE[0]}")/../mirrored-images")
[[ $digest == sha256:* ]] || { echo "start-postgres: .github/mirrored-images names no postgres:17.6" >&2; exit 2; }
# CHECK_POSTGRES_REGISTRIES replaces the list, for trying this script out.
read -r -a registries <<<"${CHECK_POSTGRES_REGISTRIES:-ghcr.io/vivd-solutions/mirror public.ecr.aws/docker/library mirror.gcr.io/library docker.io/library}"

# On a hosted runner the line is also an annotation on the run's summary page.
fail() {
  echo "start-postgres: $1" >&2
  [[ -z ${GITHUB_ACTIONS:-} ]] || echo "::error title=Database::$1"
  exit 1
}

image=""
for round in 1 2 3; do
  for registry in "${registries[@]}"; do
    candidate="$registry/postgres@$digest"
    if docker pull --quiet "$candidate" >/dev/null; then
      image=$candidate
      echo "start-postgres: postgres 17.6 served by $registry (round $round)"
      break 2
    fi
    echo "start-postgres: $registry did not serve the image (round $round)" >&2
  done
  [[ $round -eq 3 ]] || sleep $((round * 15))
done
[[ -n $image ]] \
  || fail "no registry served postgres 17.6 in three rounds: ${registries[*]}; the reason each gave is above"

# Room for as many test files side by side as Vitest runs on this machine: one per core but
# one, and vitest.config.ts runs no more files than the server has connections for. Postgres's
# default of 100 has room for two. The number is connectionsForWorkers(defaultTestWorkers()) of
# scripts/test-postgres-capacity.mjs: workers * (40 + 1) + 3, 126 on 4 cores, 290 on 8.
cores=$(nproc)
workers=$(( cores > 1 ? cores - 1 : 1 ))
max_connections=$(( workers * (40 + 1) + 3 ))

docker run --detach --name "$name" \
  --env "POSTGRES_USER=$user" --env "POSTGRES_PASSWORD=$password" --env "POSTGRES_DB=$database" \
  --publish "$port:5432" "$image" -c "max_connections=$max_connections" >/dev/null

# Over TCP: the server that runs the first-start scripts listens on the socket only, and the
# database is ready when the one after it answers on the port.
for _ in $(seq 60); do
  if docker exec "$name" pg_isready --quiet --host 127.0.0.1 --username "$user" --dbname "$database"; then
    echo "start-postgres: ready on port $port"
    exit 0
  fi
  sleep 2
done
docker logs "$name" >&2
fail "postgres 17.6 from $image started but did not accept connections on port $port within two minutes"
