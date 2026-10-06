#!/usr/bin/env bash
set -euo pipefail

# A release is the list of image digests CI built for one staging tag. The
# manifest is a small JSON file attached to the GitHub release of that tag
# (asset "release-manifest.json"). Production releases (v* tags) carry a copy of
# the manifest of the staging release they promote.

asset_name="release-manifest.json"
image_keys=(api ui doc-worker workspace-command-worker artifact-preview-worker runner)

usage() {
  cat <<'USAGE'
Usage:
  catalyst-deploy manifest write --release TAG --images JSON [--images JSON ...]
      Print the manifest for the deployment commit at HEAD. Each JSON argument
      maps image keys to "name@sha256:..." references.
  catalyst-deploy manifest check FILE [--commit SHA]
      Validate a manifest. With --commit, also require that it was built from
      that deployment commit.
  catalyst-deploy manifest fetch TAG FILE
      Download the manifest attached to the GitHub release of TAG and validate it.
  catalyst-deploy manifest staging-deployed FILE
      Succeed only if the manifest's release was deployed to staging successfully.

fetch and staging-deployed use the GitHub CLI (GH_TOKEN and GH_REPO in CI).
USAGE
}

fail() {
  echo "release-manifest: $*" >&2
  exit 1
}

kit_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v jq >/dev/null 2>&1 || fail "jq is required"

check_manifest() {
  local file="$1" commit="${2:-}"
  [[ -s "$file" ]] || fail "missing or empty manifest: $file"
  jq -e --argjson keys "$(printf '%s\n' "${image_keys[@]}" | jq -R . | jq -sc .)" '
    def sha: type == "string" and test("^[0-9a-f]{40}$");
    .schema == 1
    and (.release | type == "string" and test("^staging-[A-Za-z0-9_.-]+$"))
    and (.commits.deployment | sha)
    and (.commits.platform | sha)
    and (.commits.capabilities | sha)
    and ((.images | keys) == ($keys | sort))
    and ([.images[] | type == "string" and test("^[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}$")] | all)
  ' "$file" >/dev/null || fail "invalid manifest: $file"
  if [[ -n "$commit" ]]; then
    [[ "$(jq -r '.commits.deployment' "$file")" == "$commit" ]] \
      || fail "manifest was built from another deployment commit than $commit"
  fi
}

command="${1:-}"
[[ -n "$command" ]] || { usage >&2; exit 2; }
shift

case "$command" in
  write)
    release=""
    images="{}"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --release)
          release="${2:-}"
          shift 2
          ;;
        --images)
          images="$(jq -cn --argjson a "$images" --argjson b "${2:-}" '$a + $b')" \
            || fail "--images requires a JSON object"
          shift 2
          ;;
        *)
          fail "unknown argument: $1"
          ;;
      esac
    done
    [[ -n "$release" ]] || fail "--release is required"
    # shellcheck source=deployment-env.sh
    source "$kit_dir/lib/deployment-env.sh"
    load_deployment_env
    # shellcheck disable=SC1091
    source "$DEPLOYMENT_ROOT/deploy/release.refs"
    manifest="$(mktemp)"
    trap 'rm -f "$manifest"' EXIT
    jq -n \
      --arg release "$release" \
      --arg deployment "$(git -C "$DEPLOYMENT_ROOT" rev-parse HEAD)" \
      --arg platform "${PLATFORM_REF:-}" \
      --arg capabilities "${CAPABILITIES_REF:-}" \
      --argjson images "$images" \
      '{
        schema: 1,
        release: $release,
        commits: { deployment: $deployment, platform: $platform, capabilities: $capabilities },
        images: $images
      }' > "$manifest"
    check_manifest "$manifest"
    cat "$manifest"
    ;;
  check)
    file="${1:-}"
    [[ -n "$file" ]] || fail "check requires a manifest file"
    commit=""
    if [[ "${2:-}" == "--commit" ]]; then
      commit="${3:-}"
      [[ -n "$commit" ]] || fail "--commit requires a value"
    fi
    check_manifest "$file" "$commit"
    ;;
  fetch)
    tag="${1:-}"
    file="${2:-}"
    [[ -n "$tag" && -n "$file" ]] || fail "fetch requires a tag and a target file"
    gh release download "$tag" --pattern "$asset_name" --output "$file" --clobber \
      || fail "release $tag has no $asset_name; only releases built by the deploy workflow can be deployed"
    check_manifest "$file"
    ;;
  staging-deployed)
    file="${1:-}"
    [[ -n "$file" ]] || fail "staging-deployed requires a manifest file"
    check_manifest "$file"
    release="$(jq -r '.release' "$file")"
    commit="$(jq -r '.commits.deployment' "$file")"
    # The staging deploy job runs in the GitHub environment "staging", which
    # records a deployment for the tag and its outcome.
    deployment_ids="$(gh api \
      "repos/{owner}/{repo}/deployments?environment=staging&sha=$commit&per_page=100" \
      --jq ".[] | select(.ref == \"$release\") | .id")"
    for deployment_id in $deployment_ids; do
      if [[ "$(gh api "repos/{owner}/{repo}/deployments/$deployment_id/statuses" \
        --jq 'any(.[]; .state == "success")')" == "true" ]]; then
        echo "$release was deployed to staging successfully (deployment $deployment_id)."
        exit 0
      fi
    done
    fail "$release has no successful staging deployment; deploy it to staging first"
    ;;
  -h|--help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
