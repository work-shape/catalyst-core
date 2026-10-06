set -euo pipefail

cd "$REMOTE_APP_DIR"
chmod +x "$REMOTE_APP_DIR/backup-postgres.sh" "$REMOTE_APP_DIR/restore-postgres.sh"

# Compose reads the release from the environment; the same values are written to
# the env file below so that later manual Compose commands see this release.
export IMAGE_REPOSITORY IMAGE_TAG API_IMAGE_DIGEST UI_IMAGE_DIGEST DOC_WORKER_IMAGE_DIGEST \
  WORKSPACE_COMMAND_WORKER_IMAGE_DIGEST ARTIFACT_PREVIEW_WORKER_IMAGE_DIGEST RUNNER_IMAGE_DIGEST

compose_profile=()
if [[ "$EXECUTION_WORKSPACES" == "1" ]]; then
  compose_profile=(--profile execution-workspaces)
fi

compose() {
  docker compose \
    "${compose_profile[@]}" \
    --env-file "$REMOTE_ENV_FILE" \
    -f "$REMOTE_APP_DIR/docker-compose.prod.yml" \
    "$@"
}

# Replaces agent-run-worker without a claim gap: the new worker starts and is verified
# before the old one gets SIGTERM. The old worker then drains its active runs in the
# background (up to its stop_grace_period) while the new one claims queued runs.
draining_ids=""
roll_agent_run_worker() {
  local old_ids new_ids id old_count
  old_ids="$(compose ps -q agent-run-worker)"
  if [[ -z "$old_ids" ]]; then
    compose up -d --no-deps agent-run-worker
  else
    old_count="$(printf '%s\n' "$old_ids" | wc -l | tr -d ' ')"
    compose up -d --no-deps --no-recreate \
      --scale "agent-run-worker=$((old_count + 1))" agent-run-worker
  fi
  new_ids="$(compose ps -q agent-run-worker | grep -v -x -F -e "${old_ids:-none}" || true)"
  if [[ -z "$new_ids" ]]; then
    echo "New agent-run-worker container was not created" >&2
    exit 1
  fi
  sleep 5
  for id in $new_ids; do
    if [[ "$(docker inspect -f '{{.State.Running}}' "$id")" != "true" ]]; then
      echo "New agent-run-worker container is not running: $id" >&2
      docker logs --tail=100 "$id" >&2 || true
      exit 1
    fi
  done
  if [[ -n "$old_ids" ]]; then
    # docker stop honours each container's own stop timeout; detach so the deploy
    # does not wait for the drain.
    # shellcheck disable=SC2086
    nohup sh -c "docker stop $(echo $old_ids); docker rm $(echo $old_ids)" \
      > /dev/null 2>&1 < /dev/null &
    disown
    echo "Draining previous agent-run-worker container(s) in the background: $(echo $old_ids)"
    draining_ids="$old_ids"
  fi
}

# Fails the deploy unless every container of the service was created from the
# release's image reference (which carries the digest) and is running. Workers of
# the previous release that are still draining are the one accepted exception.
require_release_image() {
  local service="$1" expected="$2" ids id actual checked=0
  ids="$(compose ps -q "$service")"
  for id in $ids; do
    if grep -q -x -F -e "$id" <<< "$draining_ids"; then
      continue
    fi
    actual="$(docker inspect -f '{{.Config.Image}} {{.State.Running}}' "$id")"
    if [[ "$actual" != "$expected true" ]]; then
      echo "Service $service is not running the release image:" >&2
      echo "  expected: $expected" >&2
      echo "  actual:   ${actual% *} (running: ${actual##* })" >&2
      exit 1
    fi
    checked=$((checked + 1))
  done
  if [[ "$checked" -eq 0 ]]; then
    echo "Service $service has no running container on the release image" >&2
    compose logs --tail=100 "$service" >&2 || true
    exit 1
  fi
}

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
  ' "$REMOTE_ENV_FILE"
}

upsert_env_file_value() {
  local key="$1"
  local value="$2"
  local tmp_file
  tmp_file="$(mktemp)"
  sudo awk -v key="$key" -v value="$value" '
    BEGIN { updated = 0 }
    $0 ~ "^" key "=" {
      print key "=" value
      updated = 1
      next
    }
    { print }
    END {
      if (!updated) {
        print key "=" value
      }
    }
  ' "$REMOTE_ENV_FILE" > "$tmp_file"
  sudo install -o root -g deploy -m 0640 "$tmp_file" "$REMOTE_ENV_FILE"
  rm -f "$tmp_file"
}

for key in IMAGE_REPOSITORY IMAGE_TAG API_IMAGE_DIGEST UI_IMAGE_DIGEST DOC_WORKER_IMAGE_DIGEST \
  WORKSPACE_COMMAND_WORKER_IMAGE_DIGEST ARTIFACT_PREVIEW_WORKER_IMAGE_DIGEST RUNNER_IMAGE_DIGEST; do
  upsert_env_file_value "$key" "${!key}"
done

public_hostnames="$(read_env_file_value PUBLIC_HOSTNAMES)"
if [[ "$public_hostnames" == *,* ]]; then
  normalized_public_hostnames="$(printf '%s' "$public_hostnames" | sed -E 's/[[:space:]]*,[[:space:]]*/, /g')"
  if [[ "$normalized_public_hostnames" != "$public_hostnames" ]]; then
    upsert_env_file_value PUBLIC_HOSTNAMES "\"$normalized_public_hostnames\""
  fi
fi

GHCR_USERNAME="${GHCR_USERNAME:-$(read_env_file_value GHCR_USERNAME)}"
GHCR_PULL_TOKEN="${GHCR_PULL_TOKEN:-$(read_env_file_value GHCR_PULL_TOKEN)}"
GHCR_TOKEN="${GHCR_TOKEN:-$(read_env_file_value GHCR_TOKEN)}"
ghcr_pull_token="${GHCR_PULL_TOKEN:-${GHCR_TOKEN:-}}"
if [[ -n "${GHCR_USERNAME:-}" && -n "$ghcr_pull_token" ]]; then
  printf '%s' "$ghcr_pull_token" | docker login ghcr.io --username "$GHCR_USERNAME" --password-stdin
fi

# Keep the images used by running containers for rollback, but remove images
# from older unused releases before pulling the next immutable release.
docker image prune --all --force
compose pull
if [[ "$EXECUTION_WORKSPACES" == "1" ]]; then
  docker pull "$IMAGE_REPOSITORY-catalyst-runner-base:$IMAGE_TAG@$RUNNER_IMAGE_DIGEST"
fi
compose up -d --wait postgres
# Dump the database before migrations touch it. A failed backup aborts the deploy
# here, while the previous release is still running. Pre-deploy dumps get their own
# key prefix so bucket retention can treat them differently from nightly dumps.
APP_DIR="$REMOTE_APP_DIR" ENV_FILE="$REMOTE_ENV_FILE" BACKUP_PREFIX=pre-deploy \
  "$REMOTE_APP_DIR/backup-postgres.sh" "pre-deploy-$IMAGE_TAG" < /dev/null
compose run --rm -T migrate < /dev/null
services=(api doc-worker artifact-preview-worker ui caddy)
if [[ "$EXECUTION_WORKSPACES" == "1" ]]; then
  services+=(workspace-command-worker)
fi
compose up -d "${services[@]}"
compose exec -T api node -e "fetch('http://127.0.0.1:4100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" < /dev/null
roll_agent_run_worker

release_image() {
  printf '%s-%s:%s@%s\n' "$IMAGE_REPOSITORY" "$1" "$IMAGE_TAG" "$2"
}
require_release_image api "$(release_image api "$API_IMAGE_DIGEST")"
require_release_image agent-run-worker "$(release_image api "$API_IMAGE_DIGEST")"
require_release_image doc-worker "$(release_image doc-worker "$DOC_WORKER_IMAGE_DIGEST")"
require_release_image artifact-preview-worker \
  "$(release_image artifact-preview-worker "$ARTIFACT_PREVIEW_WORKER_IMAGE_DIGEST")"
require_release_image ui "$(release_image ui "$UI_IMAGE_DIGEST")"
if [[ "$EXECUTION_WORKSPACES" == "1" ]]; then
  require_release_image workspace-command-worker \
    "$(release_image workspace-command-worker "$WORKSPACE_COMMAND_WORKER_IMAGE_DIGEST")"
fi
echo "All services run the images of $IMAGE_TAG."
