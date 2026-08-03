#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  check-release.sh --workspace-root DIR --deployment-root DIR
    [--post-check EXECUTABLE]

Runs the common release gate for a stitched Catalyst workspace. Environment
examples and loadable config entrypoints are discovered from the deployment.
Deployment-specific assertions may live in one thin executable passed through
--post-check; that executable receives WORKSPACE_ROOT, PLATFORM_ROOT,
CAPABILITIES_ROOT, and DEPLOYMENT_ROOT.
USAGE
}

fail() {
  echo "check-release: $*" >&2
  exit 1
}

log_step() {
  printf '\n==> %s\n' "$1"
}

workspace_root=""
deployment_root=""
post_check=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace-root)
      workspace_root="${2:-}"
      [[ -n "$workspace_root" ]] || fail "--workspace-root requires a value"
      shift 2
      ;;
    --deployment-root)
      deployment_root="${2:-}"
      [[ -n "$deployment_root" ]] || fail "--deployment-root requires a value"
      shift 2
      ;;
    --post-check)
      post_check="${2:-}"
      [[ -n "$post_check" ]] || fail "--post-check requires a value"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[[ -n "$workspace_root" ]] || fail "--workspace-root is required"
[[ -n "$deployment_root" ]] || fail "--deployment-root is required"
[[ -d "$workspace_root" ]] || fail "workspace root does not exist: $workspace_root"
[[ -d "$deployment_root" ]] || fail "deployment root does not exist: $deployment_root"
workspace_root="$(cd "$workspace_root" && pwd)"
deployment_root="$(cd "$deployment_root" && pwd)"
platform_root="$workspace_root/platform"
capabilities_root="$workspace_root/capabilities"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

require_dir() {
  [[ -d "$1" ]] || fail "missing required checkout: $1"
}

require_file() {
  [[ -f "$1" ]] || fail "missing required file: $1"
}

for directory in "$platform_root" "$capabilities_root" "$deployment_root"; do
  require_dir "$directory"
done
require_dir "$deployment_root/deploy/scripts"
for file in \
  "$workspace_root/package.json" \
  "$workspace_root/pnpm-workspace.yaml" \
  "$workspace_root/pnpm-lock.yaml" \
  "$deployment_root/deploy/release.refs"
do
  require_file "$file"
done
if [[ -n "$post_check" ]]; then
  [[ "$post_check" == /* ]] || post_check="$deployment_root/$post_check"
  [[ -x "$post_check" ]] || fail "post-check is not executable: $post_check"
fi

# shellcheck disable=SC1090
source "$deployment_root/deploy/release.refs"
: "${PLATFORM_REF:?PLATFORM_REF is required}"
: "${CAPABILITIES_REF:?CAPABILITIES_REF is required}"
for ref in "$PLATFORM_REF" "$CAPABILITIES_REF"; do
  [[ "$ref" =~ ^[0-9a-f]{40}$ ]] || fail "release refs must be full commit SHAs: $ref"
done

actual_platform_ref="$(git -C "$platform_root" rev-parse HEAD)"
actual_capabilities_ref="$(git -C "$capabilities_root" rev-parse HEAD)"
[[ "$actual_platform_ref" == "$PLATFORM_REF" ]] \
  || fail "platform checkout does not match PLATFORM_REF"
[[ "$actual_capabilities_ref" == "$CAPABILITIES_REF" ]] \
  || fail "capabilities checkout does not match CAPABILITIES_REF"

log_step "Verify committed build lockfile"
"$script_dir/update-release.sh" \
  --workspace-root "$workspace_root" \
  --deployment-root "$deployment_root" \
  --check

pnpm_cmd=(pnpm)
if command -v corepack >/dev/null 2>&1; then
  pnpm_cmd=(corepack pnpm)
fi
run_pnpm() {
  "${pnpm_cmd[@]}" "$@"
}

status_snapshot_dir="$(mktemp -d)"
trap 'rm -rf "$status_snapshot_dir"' EXIT

capture_git_status() {
  git -C "$2" status --porcelain=v1 --untracked-files=all | LC_ALL=C sort \
    > "$status_snapshot_dir/$1.before"
}

verify_git_status_unchanged() {
  local name="$1" directory="$2" after="$status_snapshot_dir/$1.after"
  git -C "$directory" status --porcelain=v1 --untracked-files=all | LC_ALL=C sort > "$after"
  if ! diff -u "$status_snapshot_dir/$name.before" "$after"; then
    fail "release checks changed repository status in $directory"
  fi
}

capture_git_status platform "$platform_root"
capture_git_status capabilities "$capabilities_root"
capture_git_status deployment "$deployment_root"

log_step "Verify deployment shell syntax"
while IFS= read -r -d '' script; do
  bash -n "$script"
done < <(find "$deployment_root/deploy/scripts" -maxdepth 1 -type f -name '*.sh' -print0)

log_step "Validate environment examples"
env_examples=()
release_env_examples=()
while IFS= read -r env_file; do
  env_examples+=("$env_file")
  if grep -q '^PUBLIC_HOSTNAMES=' "$env_file" && grep -q '^CLIENT_CONFIG_PATH=' "$env_file"; then
    release_env_examples+=("$env_file")
  fi
done < <(find "$deployment_root" -maxdepth 1 -type f -name '.env.*.example' -print | LC_ALL=C sort)
[[ ${#release_env_examples[@]} -gt 0 ]] \
  || fail "no release environment examples with PUBLIC_HOSTNAMES and CLIENT_CONFIG_PATH found"

for env_file in "${env_examples[@]}"; do
  if ! awk '
    /^[[:space:]]*($|#)/ { next }
    {
      line = $0
      sub(/^[[:space:]]+/, "", line)
      if (line !~ /^[A-Za-z_][A-Za-z0-9_]*=/) next
      value = line
      sub(/^[A-Za-z_][A-Za-z0-9_]*=/, "", value)
      sub(/[[:space:]]+#.*$/, "", value)
      if (value ~ /^["\047]/) next
      if (value ~ /[[:space:]]/) {
        print FILENAME ":" FNR ": unquoted whitespace in env assignment"
        failed = 1
      }
    }
    END { exit failed ? 1 : 0 }
  ' "$env_file"; then
    fail "quote env values that intentionally contain whitespace"
  fi
  bash -e -o pipefail -c 'set -a; source "$1"; set +a' _ "$env_file"
done

if [[ "${CHECK_RELEASE_INSTALL:-1}" != "0" ]]; then
  log_step "Install workspace dependencies"
  run_pnpm install --frozen-lockfile
fi

log_step "Run platform check"
run_pnpm --dir "$platform_root" check

log_step "Run capabilities check"
run_pnpm --dir "$capabilities_root" check

log_step "Verify runner image Dockerfile"
node "$capabilities_root/packages/artifact-helpers/scripts/verify-runner-dockerfile.mjs"

log_step "Typecheck and build deployment assembly"
run_pnpm --dir "$deployment_root" typecheck
run_pnpm --dir "$deployment_root" build

for artifact in "$deployment_root/dist/server.js" "$deployment_root/dist/client/index.html"; do
  [[ -s "$artifact" ]] || fail "missing or empty build artifact: $artifact"
done
first_ui_asset="$(find "$deployment_root/dist/client/assets" -type f -size +0c -print -quit)"
[[ -n "$first_ui_asset" ]] || fail "missing built UI assets"

log_step "Validate release configs"
DEPLOYMENT_ROOT="$deployment_root" run_pnpm --dir "$platform_root" \
  --filter @vivd-catalyst/config-schema exec node --input-type=module <<'NODE'
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { loadClientInstanceConfigFromFile } from "@vivd-catalyst/config-schema";

const configDir = join(process.env.DEPLOYMENT_ROOT, "config");
const candidates = (await readdir(configDir))
  .filter((name) => /^app(?:\..+)?\.yaml$/u.test(name))
  .sort();
const extended = new Set();
for (const name of candidates) {
  const contents = await readFile(join(configDir, name), "utf8");
  const match = contents.match(/^\s*extends:\s*["']?([^"'#\s]+)["']?/mu);
  if (match) extended.add(basename(resolve(configDir, match[1])));
}
const entrypoints = candidates.filter((name) => !extended.has(name));
if (entrypoints.length === 0) throw new Error("No release config entrypoints found");
for (const name of entrypoints) {
  const config = await loadClientInstanceConfigFromFile(join(configDir, name));
  console.log(`validated ${name} (${config.clientInstance.environment})`);
}
NODE

if [[ -f "$deployment_root/docker-compose.prod.yml" ]]; then
  command -v docker >/dev/null 2>&1 || fail "docker CLI is required"
  log_step "Validate release Compose config"
  for env_file in "${release_env_examples[@]}"; do
    docker compose --env-file "$env_file" \
      -f "$deployment_root/docker-compose.prod.yml" config >/dev/null
  done
fi

if [[ -f "$deployment_root/deploy/Caddyfile" ]]; then
  command -v docker >/dev/null 2>&1 || fail "docker CLI is required"
  log_step "Validate Caddy config"
  for env_file in "${release_env_examples[@]}"; do
    (
      set -a
      # shellcheck disable=SC1090
      source "$env_file"
      set +a
      : "${PUBLIC_HOSTNAMES:?PUBLIC_HOSTNAMES is required}"
      docker run --rm -e PUBLIC_HOSTNAMES \
        -v "$deployment_root/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" \
        caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile >/dev/null
    )
  done
fi

if [[ -n "$post_check" ]]; then
  log_step "Run deployment-specific post-check"
  WORKSPACE_ROOT="$workspace_root" \
    PLATFORM_ROOT="$platform_root" \
    CAPABILITIES_ROOT="$capabilities_root" \
    DEPLOYMENT_ROOT="$deployment_root" \
    "$post_check"
fi

log_step "Verify generated checks did not change repository status"
verify_git_status_unchanged platform "$platform_root"
verify_git_status_unchanged capabilities "$capabilities_root"
verify_git_status_unchanged deployment "$deployment_root"

log_step "Release checks passed"
