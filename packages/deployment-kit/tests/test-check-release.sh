#!/usr/bin/env bash
# Exercise the release gate with fake package, network and Docker commands only.
set -euo pipefail
kit_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
root="$scratch/workspace"
deployment="$root/deployment.fixture"
mkdir -p "$root/platform" "$root/capabilities/packages/artifact-helpers/scripts" \
  "$deployment/deploy/workspace" "$deployment/deploy/scripts" "$deployment/config" \
  "$deployment/dist/client/assets" "$scratch/bin"
for repo in platform capabilities deployment.fixture; do
  printf '{"name":"%s"}\n' "$repo" > "$root/$repo/package.json"
  git -C "$root/$repo" init -q
  git -C "$root/$repo" add package.json
  git -C "$root/$repo" -c user.name=Fixture -c user.email=fixture@example.test commit -qm fixture
done
printf 'packages: []\n' > "$root/platform/pnpm-workspace.yaml"
printf 'PLATFORM_REF=%s\nCAPABILITIES_REF=%s\n' \
  "$(git -C "$root/platform" rev-parse HEAD)" \
  "$(git -C "$root/capabilities" rev-parse HEAD)" > "$deployment/deploy/release.refs"
printf "lockfileVersion: '9.0'\n" > "$deployment/deploy/workspace/pnpm-lock.yaml"
bash "$kit_dir/lib/prepare-build-workspace.sh" --workspace-root "$root" --deployment-root "$deployment"
printf 'PUBLIC_HOSTNAMES=fixture.test\nCLIENT_CONFIG_PATH=config/app.staging.yaml\n' > "$deployment/.env.staging.example"
printf 'modules: {}\n' > "$deployment/config/app.staging.yaml"
printf 'console.log("resolve-only: this process starts with this config");\n' > "$deployment/dist/server.js"
printf '<html></html>\n' > "$deployment/dist/client/index.html"
printf 'fixture\n' > "$deployment/dist/client/assets/index.js"
printf '// runner verification fixture\n' > "$root/capabilities/packages/artifact-helpers/scripts/verify-runner-dockerfile.mjs"
printf 'services: {}\n' > "$deployment/docker-compose.prod.yml"
printf 'fixture.test {}\n' > "$deployment/deploy/Caddyfile"
cat > "$deployment/deploy/scripts/post-check.sh" <<'POST'
#!/usr/bin/env bash
printf 'post-check\n' >> "$COMMAND_LOG"
POST
chmod +x "$deployment/deploy/scripts/post-check.sh"
cat > "$scratch/bin/corepack" <<'PNPM'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == pnpm ]] || exit 2
shift
if [[ "$1" == install && "$*" == *--lockfile-only* ]]; then
  printf "lockfileVersion: '9.0'\n" > pnpm-lock.yaml
else
  printf '%s\n' "$*" >> "$COMMAND_LOG"
fi
PNPM
cat > "$scratch/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "$COMMAND_LOG"
DOCKER
cat > "$scratch/bin/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
url="${!#}"
printf '%s\n' "$url" >> "$LOOKUP_LOG"
case "$CASE" in
  http-error) exit 22 ;;
  invalid-json) printf 'unparseable'; exit 0 ;;
esac
if [[ "$url" == *'/jobs?'* ]]; then
  if [[ "$CASE" == failed-job ]]; then
    printf '{"jobs":[{"name":"check","status":"completed","conclusion":"failure"}]}'
  elif [[ "$CASE" == missing-job ]]; then
    printf '{"jobs":[]}'
  else
    printf '{"jobs":[{"name":"check","status":"completed","conclusion":"success"}]}'
  fi
else
  sha="${url#*head_sha=}"
  sha="${sha%%&*}"
  event=push
  [[ "$CASE" != dispatch ]] || event=workflow_dispatch
  [[ "$CASE" != pr-only ]] || event=pull_request
  [[ "$CASE" != wrong-sha ]] || sha=0000000000000000000000000000000000000000
  if [[ "$CASE" == unknown || ( "$CASE" == capabilities-missing && "$url" == *catalyst-capabilities/* ) ]]; then
    printf '{"workflow_runs":[]}'
  else
    printf '{"workflow_runs":[{"id":4711,"head_sha":"%s","status":"completed","conclusion":"success","event":"%s"}]}' "$sha" "$event"
  fi
fi
CURL
chmod +x "$scratch/bin/"*
export PATH="$scratch/bin:$PATH"
export COMMAND_LOG="$scratch/commands" LOOKUP_LOG="$scratch/lookups"
export GH_TOKEN=fixture-token
run_case() {
  export CASE="$1"
  shift
  : > "$COMMAND_LOG"
  : > "$LOOKUP_LOG"
  (cd "$root" && bash "$kit_dir/lib/check-release.sh" \
    --workspace-root "$root" --deployment-root "$deployment" \
    --post-check deploy/scripts/post-check.sh "$@") > "$scratch/output" 2>&1 || {
      cat "$scratch/output"; exit 1;
    }
  grep -Fq -- "--dir $deployment typecheck" "$COMMAND_LOG"
  grep -Fq -- "--dir $deployment build" "$COMMAND_LOG"
  grep -Fq 'post-check' "$COMMAND_LOG"
  grep -Fq 'docker compose' "$COMMAND_LOG"
  grep -Fq 'caddy validate' "$COMMAND_LOG"
  grep -Fq 'Release checks passed' "$scratch/output"
}
for scenario in green dispatch; do
  run_case "$scenario"
  grep -Fq -- "--dir $root/platform build" "$COMMAND_LOG"
  grep -Fq -- "--dir $root/capabilities build" "$COMMAND_LOG"
  if grep -Eq '^--dir .* check$' "$COMMAND_LOG"; then exit 1; fi
  grep -Fq 'Reuse platform check: work-shape/catalyst-core run 4711' "$scratch/output"
  grep -Fq 'Reuse capabilities check: work-shape/catalyst-capabilities run 4711' "$scratch/output"
done
for scenario in unknown capabilities-missing http-error invalid-json wrong-sha pr-only failed-job missing-job no-token full; do
  args=()
  [[ "$scenario" != full ]] || args=(--full)
  if [[ "$scenario" == no-token ]]; then GH_TOKEN=""; else GH_TOKEN=fixture-token; fi
  run_case "$scenario" ${args[@]+"${args[@]}"}
  grep -Fq -- "--dir $root/platform check" "$COMMAND_LOG"
  grep -Fq -- "--dir $root/capabilities check" "$COMMAND_LOG"
  if grep -Fq 'Reuse platform' "$scratch/output"; then exit 1; fi
  if [[ "$scenario" == full || "$scenario" == no-token ]]; then
    [[ ! -s "$LOOKUP_LOG" ]]
  fi
done
printf 'release-check CI reuse tests passed\n'
