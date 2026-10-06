#!/usr/bin/env bash
set -euo pipefail

# Part of "catalyst-deploy check": what the kit's deploy flow requires from the
# files a deployment repo still owns (Compose file, bake file, workflow).

: "${DEPLOYMENT_ROOT:?DEPLOYMENT_ROOT is required}"
kit_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  echo "$*" >&2
  exit 1
}

# shellcheck source=deployment-env.sh
source "$kit_dir/lib/deployment-env.sh"
load_deployment_env
command -v jq >/dev/null 2>&1 || fail "jq is required"

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

[[ "$(jq -r '.name' "$DEPLOYMENT_ROOT/package.json")" == "$APP_PACKAGE" ]] \
  || fail "APP_PACKAGE in deploy/deployment.env is not the name in package.json"

# A release is a manifest of image digests: production Compose must pin every
# first-party image by digest, and production must only get a release that
# staging ran.
if grep -E '^[[:space:]]+image:.*IMAGE_REPOSITORY' "$DEPLOYMENT_ROOT/docker-compose.prod.yml" \
  | grep -v '_IMAGE_DIGEST:?'; then
  fail "docker-compose.prod.yml must pin every first-party image by digest"
fi
grep -Eq '(release-manifest\.sh|catalyst-deploy manifest) staging-deployed' \
  "$DEPLOYMENT_ROOT/.github/workflows/deploy.yml" \
  || fail "deploy.yml must require a successful staging deployment before production"

# The bake file must parse, and its targets must be exactly the images of a manifest.
bake_images="$(docker buildx bake --file "$DEPLOYMENT_ROOT/deploy/docker-bake.hcl" --print 2>/dev/null \
  | jq -c --arg digest "sha256:$(printf '%064d' 0)" \
    '.target | map_values((.tags[0] | sub(":[^:/]+$"; "")) + "@" + $digest)')"
bash "$kit_dir/lib/release-manifest.sh" write \
  --release staging-policy-check --images "$bake_images" > "$scratch/release-manifest.json"
bash "$kit_dir/lib/release-manifest.sh" check "$scratch/release-manifest.json"

for wiring in artifact-preview-worker agent-run-worker workspace-command-worker; do
  node "$kit_dir/verify/$wiring-compose.mjs"
done
