#!/usr/bin/env bash
# Starts the database a job of the Check workflow tests against and waits until it accepts
# connections.
#
# A service container pulls once and fails the job before its first step when the registry
# does not answer. This pulls the instance's Postgres image, by the digest of
# docker/postgres/pinned-image, from the organisation's registry and tries three times. The job
# signs in to ghcr.io before, since the package is the repository's.
set -euo pipefail

[[ $# -eq 4 ]] || { echo "usage: start-postgres.sh USER PASSWORD DATABASE HOST_PORT" >&2; exit 2; }
user=$1 password=$2 database=$3 port=$4
name=${CHECK_POSTGRES_NAME:-check-postgres}

image=$(grep -v '^#' "$(dirname "${BASH_SOURCE[0]}")/../../docker/postgres/pinned-image" | grep . | head -n 1)
[[ $image == *@sha256:* ]] || { echo "start-postgres: docker/postgres/pinned-image names no image by digest" >&2; exit 2; }

# On a hosted runner the line is also an annotation on the run's summary page.
fail() {
  echo "start-postgres: $1" >&2
  [[ -z ${GITHUB_ACTIONS:-} ]] || echo "::error title=Database::$1"
  exit 1
}

pulled=""
for round in 1 2 3; do
  if docker pull --quiet "$image" >/dev/null; then
    pulled=yes
    echo "start-postgres: pulled $image (round $round)"
    break
  fi
  echo "start-postgres: the registry did not serve $image (round $round)" >&2
  [[ $round -eq 3 ]] || sleep $((round * 15))
done
[[ -n $pulled ]] || fail "the registry did not serve $image in three rounds; the reason it gave is above"

# Room for three test files side by side: a hosted runner has four cores, Vitest leaves one
# free, and vitest.config.ts runs no more files than the server has connections for. Postgres's
# default of 100 has room for two. The number is connectionsForWorkers(3) of
# scripts/test-postgres-capacity.mjs: 3 * (40 + 1) + 3.
max_connections=126

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
fail "$image started but did not accept connections on port $port within two minutes"
