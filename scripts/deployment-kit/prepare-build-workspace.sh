#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  prepare-build-workspace.sh --workspace-root DIR --deployment-root DIR

Prepares the stitched platform/capabilities/deployment pnpm workspace used by
CI image builds. The deployment checkout must be inside the workspace root.
Existing root metadata is preserved; a differing root lockfile is never
overwritten.
USAGE
}

fail() {
  echo "prepare-build-workspace: $*" >&2
  exit 1
}

workspace_root=""
deployment_root=""
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
workspace_root="$(cd "$workspace_root" && pwd)"
if [[ "$deployment_root" != /* ]]; then
  deployment_root="$workspace_root/$deployment_root"
fi
[[ -d "$deployment_root" ]] || fail "deployment root does not exist: $deployment_root"
deployment_root="$(cd "$deployment_root" && pwd)"

case "$deployment_root" in
  "$workspace_root"/*) ;;
  *) fail "deployment root must be inside workspace root" ;;
esac
deployment_path="${deployment_root#"$workspace_root"/}"

for required_dir in "$workspace_root/platform" "$workspace_root/capabilities" "$deployment_root"; do
  [[ -d "$required_dir" ]] || fail "missing required checkout: $required_dir"
done

cd "$workspace_root"
if [[ ! -f package.json ]]; then
  cat > package.json <<'JSON'
{
  "name": "vivd-catalyst-build-workspace",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.29.3"
}
JSON
fi

if [[ ! -f pnpm-workspace.yaml ]]; then
  cat > pnpm-workspace.yaml <<YAML
packages:
  - "platform"
  - "platform/packages/*"
  - "platform/clients/*"
  - "capabilities"
  - "capabilities/packages/*"
  - "$deployment_path"
YAML
fi

if [[ ! -f .dockerignore ]]; then
  cat > .dockerignore <<'DOCKERIGNORE'
.git
**/.git
.pnpm-store
node_modules
**/node_modules
dist
**/dist
coverage
**/coverage
.turbo
**/.turbo
.vite
**/.vite
.env
.env.*
!.env.example
!.env.prod.example
terraform.tfstate
terraform.tfstate.*
**/.terraform
DOCKERIGNORE
fi

committed_lockfile="$deployment_root/deploy/workspace/pnpm-lock.yaml"
[[ -f "$committed_lockfile" ]] \
  || fail "missing committed build lockfile: $committed_lockfile"

if [[ -f pnpm-lock.yaml ]]; then
  cmp -s pnpm-lock.yaml "$committed_lockfile" \
    || fail "workspace pnpm-lock.yaml differs from $committed_lockfile; refusing to overwrite it"
else
  cp "$committed_lockfile" pnpm-lock.yaml
fi
