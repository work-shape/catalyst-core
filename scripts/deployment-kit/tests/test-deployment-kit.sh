#!/usr/bin/env bash
set -euo pipefail

kit_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

fail() {
  echo "deployment-kit test: $*" >&2
  exit 1
}

assert_contains() {
  grep -Fq "$2" "$1" || fail "$1 does not contain: $2"
}

expect_failure() {
  local output="$scratch/failure-output"
  if "$@" >"$output" 2>&1; then
    fail "command unexpectedly succeeded: $*"
  fi
}

test_prepare_build_workspace() {
  local root="$scratch/prepare-workspace"
  mkdir -p \
    "$root/platform" \
    "$root/capabilities" \
    "$root/deployment.fixture/deploy/workspace"
  printf '{"name":"fixture"}\n' > "$root/deployment.fixture/package.json"
  printf "lockfileVersion: '9.0'\n" \
    > "$root/deployment.fixture/deploy/workspace/pnpm-lock.yaml"

  "$kit_dir/prepare-build-workspace.sh" \
    --workspace-root "$root" \
    --deployment-root deployment.fixture

  assert_contains "$root/pnpm-workspace.yaml" '  - "deployment.fixture"'
  cmp -s "$root/pnpm-lock.yaml" \
    "$root/deployment.fixture/deploy/workspace/pnpm-lock.yaml" \
    || fail "prepare-build-workspace did not copy the committed lockfile"

  printf "lockfileVersion: 'different'\n" > "$root/pnpm-lock.yaml"
  expect_failure "$kit_dir/prepare-build-workspace.sh" \
    --workspace-root "$root" \
    --deployment-root "$root/deployment.fixture"
  assert_contains "$scratch/failure-output" "refusing to overwrite"

  mkdir -p "$scratch/outside-deployment"
  expect_failure "$kit_dir/prepare-build-workspace.sh" \
    --workspace-root "$root" \
    --deployment-root "$scratch/outside-deployment"
  assert_contains "$scratch/failure-output" "must be inside workspace root"
}

init_fixture_repo() {
  local directory="$1" name="$2"
  mkdir -p "$directory"
  printf '{"name":"%s","version":"1.0.0"}\n' "$name" > "$directory/package.json"
  git -C "$directory" init -q
  git -C "$directory" add package.json
  git -C "$directory" -c user.name=Fixture -c user.email=fixture@example.test \
    commit -qm "fixture"
}

test_update_release() {
  local root="$scratch/release-workspace"
  local deployment="$root/deployment.fixture"
  local fake_bin="$root/fake-bin"
  init_fixture_repo "$root/platform" platform-fixture
  init_fixture_repo "$root/capabilities" capabilities-fixture
  mkdir -p "$deployment/deploy/scripts" "$deployment/deploy/workspace" "$fake_bin"
  printf '{"name":"deployment-fixture","version":"1.0.0"}\n' \
    > "$deployment/package.json"
  printf 'PLATFORM_REF=%s\nCAPABILITIES_REF=%s\n' \
    "$(git -C "$root/platform" rev-parse HEAD)" \
    "$(git -C "$root/capabilities" rev-parse HEAD)" \
    > "$deployment/deploy/release.refs"

  cat > "$fake_bin/corepack" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == "pnpm" ]] && shift
[[ "${1:-}" == "install" ]] || exit 2
deployment_package="$(find . -mindepth 2 -maxdepth 2 -path './deployment.*/package.json' -print -quit)"
checksum="$(cksum platform/package.json capabilities/package.json "$deployment_package" \
  | cksum | awk '{print $1}')"
printf "lockfileVersion: '9.0'\nfixtureChecksum: '%s'\n" "$checksum" > pnpm-lock.yaml
SH
  chmod +x "$fake_bin/corepack"

  PATH="$fake_bin:$PATH" "$kit_dir/update-release.sh" \
    --workspace-root "$root" \
    --deployment-root "$deployment"
  [[ -s "$deployment/deploy/workspace/pnpm-lock.yaml" ]] \
    || fail "update-release did not create the committed lockfile"
  assert_contains "$deployment/deploy/release.refs" \
    "PLATFORM_REF=$(git -C "$root/platform" rev-parse HEAD)"

  PATH="$fake_bin:$PATH" "$kit_dir/update-release.sh" \
    --workspace-root "$root" \
    --deployment-root "$deployment" \
    --check

  printf '{"name":"platform-dirty-tree-must-be-ignored"}\n' \
    > "$root/platform/package.json"
  PATH="$fake_bin:$PATH" "$kit_dir/update-release.sh" \
    --workspace-root "$root" \
    --deployment-root "$deployment" \
    --check

  printf '{"name":"deployment-fixture","version":"2.0.0"}\n' \
    > "$deployment/package.json"
  expect_failure env PATH="$fake_bin:$PATH" "$kit_dir/update-release.sh" \
    --workspace-root "$root" \
    --deployment-root "$deployment" \
    --check
  assert_contains "$scratch/failure-output" "committed lockfile is out of date"

  printf 'PLATFORM_REF=short\nCAPABILITIES_REF=short\n' \
    > "$deployment/deploy/release.refs"
  printf '{}\n' > "$root/package.json"
  printf 'packages: []\n' > "$root/pnpm-workspace.yaml"
  cp "$deployment/deploy/workspace/pnpm-lock.yaml" "$root/pnpm-lock.yaml"
  expect_failure "$kit_dir/check-release.sh" \
    --workspace-root "$root" \
    --deployment-root "$deployment"
  assert_contains "$scratch/failure-output" "release refs must be full commit SHAs"
}

test_compose_watch_preflight() {
  local root="$scratch/compose-fixture"
  local fake_bin="$root/fake-bin"
  mkdir -p "$fake_bin"
  cat > "$fake_bin/docker" <<'SH'
#!/usr/bin/env bash
if [[ "$*" == "compose config --format json" ]]; then
  printf '{"name":"fixture-project","services":{"api":{}}}\n'
elif [[ "$*" == "compose ps --format json" ]]; then
  printf '[]\n'
else
  exit 2
fi
SH
  cat > "$fake_bin/ps" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  chmod +x "$fake_bin/docker" "$fake_bin/ps"
  PATH="$fake_bin:$PATH" node "$kit_dir/compose-watch-preflight.mjs" \
    --root "$root" --services api
}

test_compose_helpers() {
  KIT_DIR="$kit_dir" node --input-type=module <<'NODE'
import { pathToFileURL } from "node:url";
const helpers = await import(pathToFileURL(`${process.env.KIT_DIR}/verify-compose-helpers.mjs`));
helpers.assert((await helpers.readPlatformDockerfile()).includes("FROM "), "platform Dockerfile");
const dockerfile = "FROM base AS api\nRUN api\nFROM base AS ui\nRUN ui\n";
helpers.assert(helpers.extractDockerStage(dockerfile, "api").includes("RUN api"), "stage");
const compose = "services:\n  api:\n    image: api\n  ui:\n    image: ui\n";
helpers.assert(helpers.extractServiceBlock(compose, "api").includes("image: api"), "service");
helpers.assert(
  helpers.workflowTagsImageSuffix("${{ env.IMAGE_REPOSITORY }}-api:latest", "api"),
  "workflow tag"
);
NODE
}

test_prepare_build_workspace
test_update_release
test_compose_watch_preflight
test_compose_helpers
echo "deployment-kit tests passed"
