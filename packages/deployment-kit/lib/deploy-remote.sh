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

# Logs are diagnostic output only: never print credentials from a failed process.
mask_secrets() {
  local diagnostic_line
  # A line at a time keeps the progress stream live even on hosts without stdbuf/sed -u.
  while IFS= read -r diagnostic_line || [[ -n "$diagnostic_line" ]]; do
    printf '%s\n' "$diagnostic_line" | sed -E \
      -e '/^upload-check: attachment=[A-Za-z0-9_-]+$/b' \
      -e 's/(Bearer|Basic)[[:space:]]+[^[:space:]",;]+/\1 [REDACTED]/Ig' \
      -e 's/(([^[:space:]:=,{}]*)(secret|token|password|credential|authorization|api[_-]?key|access[_-]?key|private[_-]?key)[^[:space:]:=,{}]*["'"'"']?[[:space:]]*[:=][[:space:]]*)("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:],;}]+)/\1[REDACTED]/Ig' \
      -e 's#(://)[^/@[:space:]]+:[^/@[:space:]]+@#\1[REDACTED]@#g' \
      -e 's/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/[REDACTED]/g' \
      -e 's/[A-Za-z0-9_+\/-]{32,}={0,2}/[REDACTED]/g'
  done
}

service_failure() {
  local service="$1" id="$2" reason="$3"
  echo "Service $service ($id) failed deploy check: $reason" >&2
  docker logs --tail=30 "$id" 2>&1 | mask_secrets >&2 || true
}

# Snapshot before pull/start: an unchanged container must not hide a restart during deploy.
restart_counts=""
container_state_format='{{index .Config.Labels "com.docker.compose.service"}} {{.State.Status}} {{.RestartCount}} {{.State.ExitCode}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
record_restart_counts() {
  local ids id service state restarts code health
  ids="$(compose ps --all -q)"
  for id in $ids; do
    read -r service state restarts code health <<< "$(docker inspect -f "$container_state_format" "$id")"
    printf '%s %s\n' "$id" "$restarts"
  done
}
restart_counts="$(record_restart_counts)"

# Compose emits canonical YAML (not the source YAML). A dependency explicitly required to
# complete successfully is a one-shot, including when `compose run --rm` has removed it.
# Do not infer this from a service name or restart policy (which defaults to "no").
one_shot_services="$(compose config --format yaml | awk '
  /^services:$/ { services = 1; next }
  /^[^ ]/ { services = 0 }
  services && /^    depends_on:$/ { dependencies = 1; next }
  /^    [^ ]/ { dependencies = 0 }
  dependencies && /^      [^ ]+:$/ { dependency = $1; sub(/:$/, "", dependency) }
  dependencies && /^        condition: service_completed_successfully$/ { print dependency }
')"

check_project_services() {
  local ids id service state restarts code health baseline reason failed=0
  ids="$(compose ps --all -q)"
  if [[ -z "$ids" ]]; then
    echo "Deploy check found no containers in the Compose project" >&2
    return 1
  fi
  for id in $ids; do
    # Previous Agent Run workers deliberately exit while draining beside their replacements.
    if grep -q -x -F -e "$id" <<< "$draining_ids"; then continue; fi
    read -r service state restarts code health <<< "$(docker inspect -f "$container_state_format" "$id")"
    baseline="$(awk -v id="$id" '$1 == id { print $2 }' <<< "$restart_counts")"
    baseline="${baseline:-0}"
    reason=""
    if (( restarts > baseline )); then
      reason="restart count grew from $baseline to $restarts during deploy"
    elif [[ "$state" == exited && "$code" == 0 ]] && grep -q -x -F -e "$service" <<< "$one_shot_services"; then
      continue
    elif [[ "$state" != running ]]; then
      reason="state=$state, exit code=$code"
    elif [[ "$health" != none && "$health" != healthy ]]; then
      reason="health=$health"
    fi
    if [[ -n "$reason" ]]; then
      service_failure "$service" "$id" "$reason"
      failed=1
    fi
  done
  return "$failed"
}

# Two observations after startup (60 s and 90 s) catch workers that briefly look alive.
settle_project_services() {
  echo "Deploy check: allowing services to settle for 60 s"
  sleep 60
  check_project_services
  echo "Deploy check: observing services for another 30 s"
  sleep 30
  check_project_services
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
      service_failure agent-run-worker "$id" "new container is not running"
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
      service_failure "$service" "$id" "release image mismatch or container is not running"
      exit 1
    fi
    checked=$((checked + 1))
  done
  if [[ "$checked" -eq 0 ]]; then
    echo "Service $service has no running container on the release image" >&2
    compose logs --tail=30 "$service" 2>&1 | mask_secrets >&2 || true
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
services_list="$(compose config --services)"
knowledge_worker_service=""
if grep -qx knowledge-worker <<< "$services_list"; then
  knowledge_worker_service=knowledge-worker
  services+=(knowledge-worker)
fi
knowledge_extraction_service=""
if grep -qx doc-worker-knowledge <<< "$services_list"; then
  knowledge_extraction_service=doc-worker-knowledge
  services+=(doc-worker-knowledge)
fi
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
if [[ -n "$knowledge_worker_service" ]]; then
  require_release_image knowledge-worker "$(release_image api "$API_IMAGE_DIGEST")"
  if [[ -n "$knowledge_extraction_service" ]]; then
    require_release_image doc-worker-knowledge "$(release_image doc-worker "$DOC_WORKER_IMAGE_DIGEST")"
  fi
  # Old containers have stopped and the API serves no ingestion kind. Only the new release
  # can renew this report after now; a container merely being alive is insufficient.
  # The verified production command is [node, entrypoint]. Docker exposes it without
  # requiring a JSON parser (or Node) on the Ubuntu host.
  knowledge_worker_id="$(compose ps -q knowledge-worker)"
  knowledge_worker_entry="$(docker inspect -f '{{index .Config.Cmd 1}}' "$knowledge_worker_id")"
  compose exec -T knowledge-worker node "$knowledge_worker_entry" --check-ready < /dev/null
fi
settle_project_services
echo "All services run the images of $IMAGE_TAG."

# The services run; now a file has to get through them. check-upload.mjs uploads one synthetic
# file as the user "catalyst-deploy-check", waits until it is processed and deletes it again.
# It signs in with the server credential the api container already holds. The container's own
# shell pipes the credential to it, so it is in no argument list and not in this script's
# environment. When the file is not processed, the job that should have done it is read from
# the queue, so the failure names the job kind and the state it is in.
upload_check_timeout="${UPLOAD_CHECK_TIMEOUT_SECONDS:-$(read_env_file_value UPLOAD_CHECK_TIMEOUT_SECONDS)}"
upload_check_timeout="${upload_check_timeout:-600}"
if [[ ! "$upload_check_timeout" =~ ^[1-9][0-9]*$ ]]; then
  echo "UPLOAD_CHECK_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 1
fi
# Poll in the worker's own network namespace, without a credential or exposing its port.
# Readiness and processing each get this timeout; neither is the 15 s HTTP request timeout.
echo "upload-check: waiting for doc-worker /ready (up to $upload_check_timeout s)"
ready_started=$SECONDS
until compose exec -T doc-worker node -e \
  'fetch(`http://127.0.0.1:${process.env.PORT || 4110}/ready`, {signal: AbortSignal.timeout(15000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' \
  < /dev/null > /dev/null 2>&1; do
  if (( SECONDS - ready_started >= upload_check_timeout )); then
    id="$(compose ps --all -q doc-worker)"
    service_failure doc-worker "$id" "readiness timed out after $upload_check_timeout s"
    exit 1
  fi
  echo "upload-check: doc-worker not ready after $((SECONDS - ready_started)) s; waiting"
  sleep 5
done
echo "upload-check: doc-worker is ready; processing timeout is $upload_check_timeout s"
upload_check_output="$(mktemp)"
trap 'rm -f "$upload_check_output"' EXIT
# Stream progress while retaining only masked output for the attachment/job lookup.
# shellcheck disable=SC2016
if compose exec -T api sh -c \
  'printf %s "$CHAT_SERVER_CREDENTIAL" | node --input-type=module -e "$1" -- "--release=$2" "--wait=$3"' \
  sh "$(cat "$REMOTE_APP_DIR/check-upload.mjs")" "$IMAGE_TAG" "$upload_check_timeout" < /dev/null 2>&1 \
  | mask_secrets | tee "$upload_check_output"; then
  check_project_services
else
  attachment_id="$(sed -n 's/^upload-check: attachment=\([A-Za-z0-9_-]\{1,\}\)$/\1/p' \
    "$upload_check_output" | tail -n 1)"
  if [[ -n "$attachment_id" ]]; then
    job_query="select kind || ' is ' || status || ', attempt ' || attempts || ' of ' || max_attempts
      || coalesce(', ' || error_code, '') || coalesce(': ' || left(error_message, 200), '')
      from platform_jobs where subject = '$attachment_id' order by created_at"
    # shellcheck disable=SC2016
    jobs_of_file="$(compose exec -T postgres sh -c \
      'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "$1"' sh "$job_query" < /dev/null 2>&1 || true)"
    echo "upload-check: job of the file: ${jobs_of_file:-none was enqueued for $attachment_id}" | mask_secrets >&2
  fi
  check_project_services || true
  echo "The upload check failed: $IMAGE_TAG runs, but a file uploaded to it was not processed." >&2
  compose logs --tail=30 doc-worker 2>&1 | mask_secrets >&2 || true
  exit 1
fi
