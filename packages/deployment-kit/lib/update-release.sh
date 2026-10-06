#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  update-release.sh --deployment-root DIR [--workspace-root DIR]
    [--platform-ref REF] [--capabilities-ref REF] [--latest]
  update-release.sh --deployment-root DIR [--workspace-root DIR] --check

Pins platform and capabilities commits in deploy/release.refs and regenerates
deploy/workspace/pnpm-lock.yaml from those committed trees. Dirty checkout
contents are never included.

Options:
  --deployment-root DIR   Deployment checkout containing package.json (required).
  --workspace-root DIR    Parent containing platform and capabilities checkouts.
                          Defaults to the deployment checkout parent.
  --platform-ref REF      Pin platform to REF.
  --capabilities-ref REF  Pin capabilities to REF.
  --latest                Pin both repositories to origin/main.
  --check                 Verify the committed lockfile without changing files.
USAGE
}

fail() {
  echo "update-release: $*" >&2
  exit 1
}

deployment_root=""
workspace_root=""
mode="write"
platform_ref_arg=""
capabilities_ref_arg=""
latest="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deployment-root)
      deployment_root="${2:-}"
      [[ -n "$deployment_root" ]] || fail "--deployment-root requires a value"
      shift 2
      ;;
    --workspace-root)
      workspace_root="${2:-}"
      [[ -n "$workspace_root" ]] || fail "--workspace-root requires a value"
      shift 2
      ;;
    --check)
      mode="check"
      shift
      ;;
    --latest)
      latest="1"
      shift
      ;;
    --platform-ref)
      platform_ref_arg="${2:-}"
      [[ -n "$platform_ref_arg" ]] || fail "--platform-ref requires a value"
      shift 2
      ;;
    --capabilities-ref)
      capabilities_ref_arg="${2:-}"
      [[ -n "$capabilities_ref_arg" ]] || fail "--capabilities-ref requires a value"
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
if [[ -z "$workspace_root" ]]; then
  workspace_root="$(cd "$deployment_root/.." && pwd)"
else
  [[ -d "$workspace_root" ]] || fail "workspace root does not exist: $workspace_root"
  workspace_root="$(cd "$workspace_root" && pwd)"
fi

if [[ "$mode" == "check" ]] && [[ -n "$platform_ref_arg" || -n "$capabilities_ref_arg" || "$latest" == "1" ]]; then
  fail "--check does not take ref arguments"
fi

command -v git >/dev/null 2>&1 || fail "git is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

case "$deployment_root" in
  "$workspace_root"/*) ;;
  *) fail "deployment root must be inside workspace root" ;;
esac
deployment_path="${deployment_root#"$workspace_root"/}"
platform_repo="$workspace_root/platform"
capabilities_repo="$workspace_root/capabilities"
refs_file="$deployment_root/deploy/release.refs"
committed_lockfile="$deployment_root/deploy/workspace/pnpm-lock.yaml"

[[ -f "$refs_file" ]] || fail "missing $refs_file"
[[ -f "$deployment_root/package.json" ]] || fail "missing $deployment_root/package.json"
git -C "$platform_repo" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || fail "platform checkout not found at $platform_repo"
git -C "$capabilities_repo" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || fail "capabilities checkout not found at $capabilities_repo"

# shellcheck disable=SC1090
source "$refs_file"
: "${PLATFORM_REF:?PLATFORM_REF is required in deploy/release.refs}"
: "${CAPABILITIES_REF:?CAPABILITIES_REF is required in deploy/release.refs}"

resolve_sha() {
  local repo="$1" ref="$2" sha
  if sha="$(git -C "$repo" rev-parse --verify --quiet "${ref}^{commit}")"; then
    printf '%s\n' "$sha"
    return 0
  fi
  git -C "$repo" fetch --quiet origin >/dev/null 2>&1 || true
  sha="$(git -C "$repo" rev-parse --verify --quiet "${ref}^{commit}")" \
    || fail "cannot resolve ref '$ref' in $repo"
  printf '%s\n' "$sha"
}

platform_ref_in="$PLATFORM_REF"
capabilities_ref_in="$CAPABILITIES_REF"
if [[ "$latest" == "1" ]]; then
  git -C "$platform_repo" fetch --quiet origin
  git -C "$capabilities_repo" fetch --quiet origin
  platform_ref_in="origin/main"
  capabilities_ref_in="origin/main"
fi
[[ -n "$platform_ref_arg" ]] && platform_ref_in="$platform_ref_arg"
[[ -n "$capabilities_ref_arg" ]] && capabilities_ref_in="$capabilities_ref_arg"

platform_sha="$(resolve_sha "$platform_repo" "$platform_ref_in")"
capabilities_sha="$(resolve_sha "$capabilities_repo" "$capabilities_ref_in")"

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

extract_tree() {
  local repo="$1" sha="$2" destination="$3"
  mkdir -p "$destination"
  git -C "$repo" archive "$sha" | tar -x -C "$destination"
}

extract_tree "$platform_repo" "$platform_sha" "$scratch/platform"
extract_tree "$capabilities_repo" "$capabilities_sha" "$scratch/capabilities"
mkdir -p "$scratch/$deployment_path"
cp "$deployment_root/package.json" "$scratch/$deployment_path/package.json"

cat > "$scratch/package.json" <<'JSON'
{
  "name": "vivd-catalyst-build-workspace",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.29.3"
}
JSON

cat > "$scratch/pnpm-workspace.yaml" <<YAML
packages:
  - "platform"
  - "platform/packages/*"
  - "platform/clients/*"
  - "capabilities"
  - "capabilities/packages/*"
  - "$deployment_path"
YAML

if [[ -f "$committed_lockfile" ]]; then
  cp "$committed_lockfile" "$scratch/pnpm-lock.yaml"
elif [[ "$mode" == "write" && -f "$workspace_root/pnpm-lock.yaml" ]]; then
  cp "$workspace_root/pnpm-lock.yaml" "$scratch/pnpm-lock.yaml"
fi

pnpm_cmd=(pnpm)
if command -v corepack >/dev/null 2>&1; then
  pnpm_cmd=(corepack pnpm)
fi
(cd "$scratch" && "${pnpm_cmd[@]}" install --lockfile-only)

if [[ "$mode" == "check" ]]; then
  [[ -f "$committed_lockfile" ]] \
    || fail "missing $committed_lockfile; regenerate and commit the release lockfile"
  if ! cmp -s "$scratch/pnpm-lock.yaml" "$committed_lockfile"; then
    diff -u "$committed_lockfile" "$scratch/pnpm-lock.yaml" | head -80 || true
    fail "committed lockfile is out of date for deploy/release.refs and package.json"
  fi
  echo "update-release: committed lockfile matches the pinned refs"
  exit 0
fi

mkdir -p "$(dirname "$committed_lockfile")"
cp "$scratch/pnpm-lock.yaml" "$committed_lockfile"
cat > "$refs_file" <<EOF
# Refs used by automated deployment builds.
# Commit SHAs keep staging tags and production releases reproducible.
# Regenerate deploy/workspace/pnpm-lock.yaml whenever these refs or any
# package.json changes, and commit both files together.
PLATFORM_REF=$platform_sha
CAPABILITIES_REF=$capabilities_sha
EOF

print_ref_change() {
  local name="$1" repo="$2" old="$3" new="$4"
  if [[ "$old" == "$new" ]]; then
    echo "$name: unchanged (${new:0:12})"
    return
  fi
  echo "$name: ${old:0:12} -> ${new:0:12}"
  git -C "$repo" log --oneline "${old}..${new}" 2>/dev/null | head -15 || true
}

echo
print_ref_change "platform" "$platform_repo" "$PLATFORM_REF" "$platform_sha"
print_ref_change "capabilities" "$capabilities_repo" "$CAPABILITIES_REF" "$capabilities_sha"
echo
echo "Updated deploy/release.refs and deploy/workspace/pnpm-lock.yaml."
echo "Review the diff and commit both files together."
