#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  catalyst-deploy publish staging [--watch] [--tag TAG] [--allow-dirty]
  catalyst-deploy publish production [--watch] [--tag TAG] [--release STAGING_TAG]

staging: runs the local release checks, then creates and pushes the next
staging-* tag from the current deployment main. The tag makes CI build the
images, publish the release manifest and deploy it to staging.

production: promotes a release that staging ran. Nothing is built. It creates
the next v* tag on the commit of the staging release, attaches a copy of the
release manifest to the GitHub release of that tag and starts the production
deploy from it. Without --release it promotes the staging release of
origin/main.

Roll back by deploying an earlier release tag again:
  gh workflow run deploy.yml --ref TAG -f environment=production

Examples:
  pnpm publish:staging
  pnpm publish:prod
  pnpm publish:staging:watch
  pnpm publish:prod:watch

Options:
  --watch        Watch the GitHub Actions deploy run until it completes.
  --tag TAG      Use an explicit tag instead of the next date-based tag.
  --release STAGING_TAG
                 production: the staging release to promote.
  --allow-dirty  staging: allow local uncommitted changes. The tag still points
                 to HEAD.
  --skip-local-checks
                 staging: skip local release checks before tagging.
  -h, --help     Show this help.
USAGE
}

fail() {
  echo "publish: $*" >&2
  exit 1
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

target="${1:-}"
if [[ -z "$target" ]]; then
  usage
  exit 2
fi
shift

case "$target" in
  staging|stage)
    environment="staging"
    tag_prefix="staging-"
    workflow_event="push"
    ;;
  production|prod)
    environment="production"
    tag_prefix="v"
    workflow_event="workflow_dispatch"
    ;;
  *)
    usage
    exit 2
    ;;
esac

watch="0"
allow_dirty="0"
skip_local_checks="0"
tag=""
release=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --watch|-w)
      watch="1"
      shift
      ;;
    --allow-dirty)
      allow_dirty="1"
      shift
      ;;
    --skip-local-checks)
      skip_local_checks="1"
      shift
      ;;
    --tag)
      tag="${2:-}"
      [[ -n "$tag" ]] || fail "--tag requires a value"
      shift 2
      ;;
    --release)
      release="${2:-}"
      [[ -n "$release" ]] || fail "--release requires a value"
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

command -v git >/dev/null 2>&1 || fail "git is required"
command -v gh >/dev/null 2>&1 || fail "gh is required"
gh auth status -h github.com >/dev/null 2>&1 || fail "gh is not authenticated for github.com"

kit_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deployment-env.sh
source "$kit_dir/lib/deployment-env.sh"
load_deployment_env
repo_root="$DEPLOYMENT_ROOT"
cd "$repo_root"

[[ "$(cd "$(git rev-parse --show-toplevel)" && pwd -P)" == "$(pwd -P)" ]] \
  || fail "deploy/deployment.env must sit in the root of the deployment repo"
[[ -f "deploy/release.refs" ]] || fail "run this from deployment.$INSTANCE"
[[ -f ".github/workflows/deploy.yml" ]] || fail "missing .github/workflows/deploy.yml"

next_tag() {
  local base="$1"
  local max=0
  local existing suffix

  while IFS= read -r existing; do
    suffix="${existing##*-}"
    if [[ "$suffix" =~ ^[0-9]+$ ]] && (( suffix > max )); then
      max="$suffix"
    fi
  done < <(git tag --list "${base}-*")

  printf '%s-%s\n' "$base" "$((max + 1))"
}

git fetch origin main --tags >/dev/null

if [[ -z "$tag" ]]; then
  tag="$(next_tag "${tag_prefix}$(date +%Y.%m.%d)")"
fi
[[ "$tag" =~ ^[A-Za-z0-9_.-]+$ ]] || fail "invalid tag: $tag"
[[ "$tag" == "$tag_prefix"* ]] || fail "$environment tags must start with $tag_prefix"
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  fail "tag already exists: $tag"
fi

publish_staging() {
  [[ -z "$release" ]] || fail "--release only applies to production"

  local branch local_head remote_head merge_base
  branch="$(git branch --show-current)"
  [[ "$branch" == "main" ]] || fail "publish from main, currently on '$branch'"

  if [[ "$allow_dirty" != "1" ]] && [[ -n "$(git status --porcelain=v1 --untracked-files=all)" ]]; then
    git status --short
    fail "working tree has uncommitted changes; commit them or pass --allow-dirty"
  fi

  local_head="$(git rev-parse HEAD)"
  remote_head="$(git rev-parse origin/main)"
  merge_base="$(git merge-base HEAD origin/main)"
  if [[ "$local_head" != "$remote_head" && "$merge_base" == "$local_head" ]]; then
    fail "main is behind origin/main; pull/rebase before publishing"
  elif [[ "$local_head" != "$remote_head" && "$merge_base" != "$remote_head" ]]; then
    fail "main has diverged from origin/main; resolve before publishing"
  fi

  if [[ "$skip_local_checks" != "1" ]]; then
    echo "Running local release checks before publishing..."
    CI="${CI:-true}" "$kit_dir/bin/catalyst-deploy" check
  fi

  if [[ "$local_head" != "$remote_head" ]]; then
    echo "Pushing main..."
    git push origin main
  fi

  echo "Creating staging tag $tag at $(git rev-parse --short HEAD)..."
  git tag -a "$tag" -m "Deploy staging ${tag#staging-}"
  git push origin "$tag"
}

publish_production() {
  command -v jq >/dev/null 2>&1 || fail "jq is required"

  local release_commit manifest
  if [[ -z "$release" ]]; then
    # Newest staging release of the commit origin/main points at.
    release="$(git tag --list 'staging-*' --points-at origin/main --sort=-creatordate | head -n 1)"
    [[ -n "$release" ]] \
      || fail "origin/main has no staging release; run publish:staging first or pass --release STAGING_TAG"
  fi
  [[ "$release" == staging-* ]] || fail "--release must be a staging-* tag: $release"
  release_commit="$(git rev-parse -q --verify "refs/tags/$release^{commit}")" \
    || fail "unknown staging release: $release"

  manifest_dir="$(mktemp -d)"
  trap 'rm -rf "$manifest_dir"' EXIT
  manifest="$manifest_dir/release-manifest.json"
  bash "$kit_dir/lib/release-manifest.sh" fetch "$release" "$manifest"
  bash "$kit_dir/lib/release-manifest.sh" check "$manifest" --commit "$release_commit"
  bash "$kit_dir/lib/release-manifest.sh" staging-deployed "$manifest"

  echo "Promoting $release ($(git rev-parse --short "$release_commit")) to production as $tag..."
  git tag -a "$tag" "$release_commit" -m "Release ${tag#v} (promotes $release)"
  git push origin "$tag"
  gh release create "$tag" "$manifest" \
    --verify-tag \
    --title "$tag" \
    --notes "Production release. Promotes the images of \`$release\`."

  echo "Dispatching production deploy for $tag..."
  gh workflow run deploy.yml --ref "$tag" -f environment=production
}

if [[ "$environment" == "staging" ]]; then
  publish_staging
else
  publish_production
fi

run_id=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  run_id="$(gh run list \
    --workflow deploy.yml \
    --branch "$tag" \
    --event "$workflow_event" \
    --limit 1 \
    --json databaseId \
    --jq '.[0].databaseId // ""' 2>/dev/null || true)"
  [[ -n "$run_id" ]] && break
  sleep 3
done

echo
echo "Published $environment tag: $tag"

if [[ -n "$run_id" ]]; then
  run_url="$(gh run view "$run_id" --json url --jq '.url')"
  echo "Deploy run: $run_url"
  if [[ "$watch" == "1" ]]; then
    gh run watch "$run_id" --exit-status
  else
    echo "Watch: gh run watch $run_id --exit-status"
  fi
else
  echo "Deploy run was not visible yet. Check GitHub Actions for tag $tag."
fi
