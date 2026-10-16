#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  check-release.sh --deployment-root DIR [--post-check EXECUTABLE]

Runs the release gate on the deployment's installed published packages. Requires
one exact Catalyst version and a frozen standalone install, then typechecks,
builds and checks the entry points, Compose and Caddy files. Platform and
capabilities checks ran in their own release. A deployment-specific executable
passed through --post-check receives DEPLOYMENT_ROOT.
USAGE
}

fail() {
  echo "check-release: $*" >&2
  exit 1
}

log_step() {
  printf '\n==> %s\n' "$1"
}

deployment_root=""
post_check=""
while [[ $# -gt 0 ]]; do
  case "$1" in
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

[[ -n "$deployment_root" ]] || fail "--deployment-root is required"
[[ -d "$deployment_root" ]] || fail "deployment root does not exist: $deployment_root"
deployment_root="$(cd "$deployment_root" && pwd)"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
require_file() {
  [[ -f "$1" ]] || fail "missing required file: $1"
}

if [[ -n "$post_check" ]]; then
  [[ "$post_check" == /* ]] || post_check="$deployment_root/$post_check"
  [[ -x "$post_check" ]] || fail "post-check is not executable: $post_check"
fi

require_file "$deployment_root/pnpm-lock.yaml"
log_step "Verify the installed release"
node "$script_dir/catalyst-versions.mjs" installed "$deployment_root"

corepack_shim_dir=""
status_snapshot_dir=""
cleanup() {
  for path in "$corepack_shim_dir" "$status_snapshot_dir"; do
    [[ -z "$path" ]] || rm -rf -- "$path"
  done
}
trap cleanup EXIT

if ! command -v pnpm >/dev/null 2>&1 && command -v corepack >/dev/null 2>&1; then
  corepack_shim_dir="$(mktemp -d)"
  corepack enable --install-directory "$corepack_shim_dir" pnpm
  export PATH="$corepack_shim_dir:$PATH"
fi

pnpm_cmd=(pnpm)
if command -v corepack >/dev/null 2>&1; then
  pnpm_cmd=(corepack pnpm)
fi
run_pnpm() {
  "${pnpm_cmd[@]}" "$@"
}

status_snapshot_dir="$(mktemp -d)"

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

capture_git_status deployment "$deployment_root"

# A deployment that takes every script from the kit has no deploy/scripts.
if [[ -d "$deployment_root/deploy/scripts" ]]; then
  log_step "Verify deployment shell syntax"
  while IFS= read -r -d '' script; do
    bash -n "$script"
  done < <(find "$deployment_root/deploy/scripts" -maxdepth 1 -type f -name '*.sh' -print0)
fi

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

log_step "Typecheck and build deployment assembly"
run_pnpm --dir "$deployment_root" typecheck
run_pnpm --dir "$deployment_root" build

for artifact in "$deployment_root/dist/server.js" "$deployment_root/dist/client/index.html"; do
  [[ -s "$artifact" ]] || fail "missing or empty build artifact: $artifact"
done
first_ui_asset="$(find "$deployment_root/dist/client/assets" -type f -size +0c -print -quit)"
[[ -n "$first_ui_asset" ]] || fail "missing built UI assets"

log_step "Resolve every built entry point with every release config"
node "$script_dir/resolve-entry-points.mjs" "$deployment_root"

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
  DEPLOYMENT_ROOT="$deployment_root" "$post_check"
fi

log_step "Verify generated checks did not change repository status"
verify_git_status_unchanged deployment "$deployment_root"

log_step "Release checks passed"
