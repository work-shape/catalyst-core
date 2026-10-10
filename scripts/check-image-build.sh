#!/usr/bin/env bash
# Builds the API and UI images of the demo client the way a deployment builds its own, and
# keeps nothing: no image, no tag, only the builder's cache.
#
# A deployment puts this repository in a folder `platform/` of a build workspace whose root
# declares no dependencies, and docker/vivd-client.Dockerfile installs only the client and
# what it depends on. The packages this repository's own root declares are therefore absent,
# and a package that leans on one of them without declaring it builds here and in
# `pnpm check`, but not in an image. This script builds in that layout, from the files Git
# knows and with the committed lockfile, so such a package fails before a deployment meets it.
#
# The two worker images add a Docker client and system packages to the same two build stages.
set -euo pipefail

platform_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
client_package="@vivd-catalyst/demo"
client_path="platform/clients/demo"

command -v docker >/dev/null 2>&1 || { echo "check-image-build: docker is required" >&2; exit 1; }

workspace="$(mktemp -d)"
trap 'rm -rf -- "$workspace"' EXIT
mkdir "$workspace/platform"

# The tracked and the new files of the working tree, without anything Git ignores.
(
  cd "$platform_root"
  git ls-files -z --cached --others --exclude-standard \
    | while IFS= read -r -d '' file; do
      if [[ -e "$file" || -L "$file" ]]; then printf '%s\0' "$file"; fi
    done \
    | tar --null --files-from - --create --file -
) | tar --extract --file - --directory "$workspace/platform"

# The root of a deployment's build workspace, as packages/deployment-kit writes it.
cat > "$workspace/package.json" <<'JSON'
{
  "name": "vivd-catalyst-build-workspace",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.29.3"
}
JSON
cat > "$workspace/pnpm-workspace.yaml" <<'YAML'
packages:
  - "platform"
  - "platform/packages/*"
  - "platform/clients/*"
YAML
cp "$platform_root/.npmrc" "$workspace/.npmrc"
cp "$platform_root/docker/vivd-client.Dockerfile.dockerignore" "$workspace/.dockerignore"

# The committed lockfile with every workspace package moved under `platform/` and an empty
# root in front, so the image installs the versions `pnpm check` tested and resolves nothing.
awk '
  /^importers:$/ { print; print ""; print "  .: {}"; importers = 1; next }
  /^[^ ]/ { importers = 0 }
  importers && /^  \.:$/ { print "  platform:"; next }
  importers && /^  [^ ]/ { sub(/^  /, "  platform/") }
  { print }
' "$platform_root/pnpm-lock.yaml" > "$workspace/pnpm-lock.yaml"

build() {
  local target="$1"
  echo "==> Build the $target image of $client_package"
  docker buildx build \
    --file "$workspace/platform/docker/vivd-client.Dockerfile" \
    --target "$target" \
    --build-arg "APP_PACKAGE=$client_package" \
    --build-arg "SERVER_ENTRY=$client_path/dist/server.js" \
    --build-arg "ARTIFACT_PREVIEW_WORKER_ENTRY=$client_path/dist/artifact-preview-worker.js" \
    --build-arg "UI_PACKAGE=$client_package" \
    --build-arg "UI_DIST_DIR=$client_path/dist/client" \
    --build-arg "NGINX_CONFIG_PATH=platform/docker/nginx-spa.conf" \
    --build-arg "VITE_CHAT_API_URL=" \
    --build-arg "VITE_CHAT_API_PORT=" \
    --output type=cacheonly \
    "$workspace"
}

build api
build ui
echo "==> Both images build"
