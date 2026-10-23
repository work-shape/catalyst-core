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
# The development UI image (`ui-dev`) builds a few packages by name instead of everything the
# client depends on, so it is built as well.
#
# The two worker images add a Docker client and system packages to the same two build stages.
# The runner image, in which commands and Page builds run, is built too: it installs
# `catalyst-page-build` and `catalyst-asset-repo` from this repository and fails to build when
# either command does not run. The API and worker images are also asked whether they carry git,
# which only the runner image may.
#
# With RUNNER_IMAGE_TAG set, the runner image is kept under that tag in the local engine, for
# the tests that run commands in it. Whoever sets it removes the image.
set -euo pipefail

platform_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
client_package="@work-shape/catalyst-demo"
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
# The lockfile below names the overrides of this repository's own workspace manifest, and a
# frozen install refuses a root that does not name the same ones.
awk '/^overrides:/ { block = 1; print; next } block && /^[^ ]/ { block = 0 } block && /^ /' \
  "$platform_root/pnpm-workspace.yaml" >> "$workspace/pnpm-workspace.yaml"
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

# A runner or checkout may use umask 077. Image commands must remain readable by the
# unprivileged runner even when the source files copied into the build are owner-only.
chmod -R go-rwx "$workspace"

build() {
  local target="$1"
  # A second argument keeps the image under that tag in the local engine.
  local tag="${2:-}"
  local output=(--output type=cacheonly)
  if [[ "$target" == "workspace-command-runner" && -n "${RUNNER_IMAGE_TAG:-}" ]]; then
    tag="$RUNNER_IMAGE_TAG"
  fi
  if [[ -n "$tag" ]]; then
    output=(--tag "$tag" --load)
  fi
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
    "${output[@]}" \
    "$workspace"
}

build api
build ui
# The image `pnpm dev` runs the UI from. Its build loads the Vite plugin of chat-ui, which fails
# when the stage leaves out a package the plugin imports from built output.
build ui-dev
# Git runs in the runner image alone, as the fixed command `catalyst-asset-repo`. An API or
# worker image that carries a git binary fails here.
for target in api workspace-command-worker artifact-preview-worker; do
  image="catalyst-check-no-git-$target:local"
  build "$target" "$image"
  docker run --rm --network none --entrypoint node "$image" -e '
    const packages = require("/usr/local/share/catalyst/runner-packages.json");
    if (!packages.some(p => p.name.toLowerCase() === "pypdf" && p.version === "4.3.1"))
      throw new Error("API image has no pinned pypdf in its runner package manifest");
  '
  found="$(docker run --rm --network none --entrypoint sh "$image" -c 'command -v git || true')"
  docker rmi "$image" >/dev/null
  if [[ -n "$found" ]]; then
    echo "check-image-build: the $target image carries git at $found" >&2
    exit 1
  fi
  echo "==> The $target image carries no git"
done
# The runner image carries the commands that build a saved Page and keep a repository; its
# build runs both.
build workspace-command-runner
echo "==> The API, UI, development UI and runner images build"

# Prove the deployment kit's actual pinned Python layer too. This target needs no client
# install; BuildKit skips unrelated stages. The same layer supplies the release runner and
# the API's manifest, so publishing does not need Docker access.
kit_image="catalyst-check-kit-runner-system:local"
docker buildx build --file "$platform_root/packages/deployment-kit/docker/deployment.Dockerfile" \
  --target runner-system --tag "$kit_image" --load "$workspace"
kit_status=0
docker run --rm --network none --entrypoint python3 \
  --mount "type=bind,source=$platform_root/packages/deployment-kit/verify/runner-packages.py,target=/verify.py,readonly" \
  "$kit_image" /verify.py || kit_status=$?
docker rmi "$kit_image" >/dev/null
if [[ "$kit_status" -ne 0 ]]; then exit "$kit_status"; fi
echo "==> The deployment kit runner manifest, pypdf and offline sandbox verify"
