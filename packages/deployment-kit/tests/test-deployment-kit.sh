#!/usr/bin/env bash
set -euo pipefail

kit_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
platform_dir="$(cd "$kit_dir/../.." && pwd)"
fakes="$kit_dir/tests/fakes"
catalyst_deploy="$kit_dir/bin/catalyst-deploy"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

fail() {
  echo "deployment-kit test: $*" >&2
  exit 1
}

assert_contains() {
  grep -Fq -e "$2" "$1" || fail "$1 does not contain: $2"
}

assert_not_contains() {
  if grep -Fq -e "$2" "$1"; then
    fail "$1 contains: $2"
  fi
}

# Line number of the first line of $1 that contains $2.
line_of() {
  grep -n -F -e "$2" "$1" | head -n 1 | cut -d: -f1
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

  "$kit_dir/lib/prepare-build-workspace.sh" \
    --workspace-root "$root" \
    --deployment-root deployment.fixture

  assert_contains "$root/pnpm-workspace.yaml" '  - "deployment.fixture"'
  cmp -s "$root/pnpm-lock.yaml" \
    "$root/deployment.fixture/deploy/workspace/pnpm-lock.yaml" \
    || fail "prepare-build-workspace did not copy the committed lockfile"

  printf "lockfileVersion: 'different'\n" > "$root/pnpm-lock.yaml"
  expect_failure "$kit_dir/lib/prepare-build-workspace.sh" \
    --workspace-root "$root" \
    --deployment-root "$root/deployment.fixture"
  assert_contains "$scratch/failure-output" "refusing to overwrite"

  mkdir -p "$scratch/outside-deployment"
  expect_failure "$kit_dir/lib/prepare-build-workspace.sh" \
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

  PATH="$fake_bin:$PATH" "$kit_dir/lib/update-release.sh" \
    --workspace-root "$root" \
    --deployment-root "$deployment"
  [[ -s "$deployment/deploy/workspace/pnpm-lock.yaml" ]] \
    || fail "update-release did not create the committed lockfile"
  assert_contains "$deployment/deploy/release.refs" \
    "PLATFORM_REF=$(git -C "$root/platform" rev-parse HEAD)"

  PATH="$fake_bin:$PATH" "$kit_dir/lib/update-release.sh" \
    --workspace-root "$root" \
    --deployment-root "$deployment" \
    --check

  printf '{"name":"platform-dirty-tree-must-be-ignored"}\n' \
    > "$root/platform/package.json"
  PATH="$fake_bin:$PATH" "$kit_dir/lib/update-release.sh" \
    --workspace-root "$root" \
    --deployment-root "$deployment" \
    --check

  printf '{"name":"deployment-fixture","version":"2.0.0"}\n' \
    > "$deployment/package.json"
  expect_failure env PATH="$fake_bin:$PATH" "$kit_dir/lib/update-release.sh" \
    --workspace-root "$root" \
    --deployment-root "$deployment" \
    --check
  assert_contains "$scratch/failure-output" "committed lockfile is out of date"

  printf 'PLATFORM_REF=short\nCAPABILITIES_REF=short\n' \
    > "$deployment/deploy/release.refs"
  printf '{}\n' > "$root/package.json"
  printf 'packages: []\n' > "$root/pnpm-workspace.yaml"
  cp "$deployment/deploy/workspace/pnpm-lock.yaml" "$root/pnpm-lock.yaml"
  expect_failure "$kit_dir/lib/check-release.sh" \
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
  PATH="$fake_bin:$PATH" node "$kit_dir/dev/compose-watch-preflight.mjs" \
    --root "$root" --services api
}

test_ensure_compose_dev_images() {
  local root="$scratch/dev-images-fixture"
  local fake_bin="$root/fake-bin"
  mkdir -p "$fake_bin" "$root/packages/example"
  printf '{"name":"fixture"}\n' > "$root/package.json"
  printf '{"name":"example"}\n' > "$root/packages/example/package.json"
  printf 'FROM scratch\n' > "$root/Dockerfile"
  cat > "$fake_bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "compose config --images api" ]]; then
  printf 'fixture-api\n'
elif [[ "$*" == "image inspect fixture-api" ]]; then
  [[ -f "$FAKE_DOCKER_IMAGE" ]] && printf 'sha256:fixture\n'
elif [[ "$*" == "compose build api" ]]; then
  touch "$FAKE_DOCKER_IMAGE"
  printf 'build\n' >> "$FAKE_DOCKER_BUILDS"
else
  exit 2
fi
SH
  chmod +x "$fake_bin/docker"

  local command=(
    node "$kit_dir/dev/ensure-compose-dev-images.mjs"
    --root "$root"
    --services api
    --inputs package.json Dockerfile
    --package-roots packages
  )
  FAKE_DOCKER_IMAGE="$root/image" FAKE_DOCKER_BUILDS="$root/builds" \
    PATH="$fake_bin:$PATH" "${command[@]}"
  [[ "$(wc -l < "$root/builds" | tr -d ' ')" == "1" ]] \
    || fail "initial development image build did not run exactly once"

  FAKE_DOCKER_IMAGE="$root/image" FAKE_DOCKER_BUILDS="$root/builds" \
    PATH="$fake_bin:$PATH" "${command[@]}"
  [[ "$(wc -l < "$root/builds" | tr -d ' ')" == "1" ]] \
    || fail "unchanged development images rebuilt"

  printf '{"name":"example","version":"2.0.0"}\n' \
    > "$root/packages/example/package.json"
  FAKE_DOCKER_IMAGE="$root/image" FAKE_DOCKER_BUILDS="$root/builds" \
    PATH="$fake_bin:$PATH" "${command[@]}"
  [[ "$(wc -l < "$root/builds" | tr -d ' ')" == "2" ]] \
    || fail "changed package manifest did not rebuild development images"
}

test_compose_helpers() {
  KIT_DIR="$kit_dir" node --input-type=module <<'NODE'
import { pathToFileURL } from "node:url";
const helpers = await import(pathToFileURL(`${process.env.KIT_DIR}/verify/compose-helpers.mjs`));
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

# Callers that pin the layout before the kit became a package use these paths.
test_legacy_paths() {
  local legacy="$platform_dir/scripts/deployment-kit" script
  for script in check-release.sh update-release.sh prepare-build-workspace.sh; do
    "$legacy/$script" --help > "$scratch/legacy-help"
    assert_contains "$scratch/legacy-help" "$script"
  done
  node "$legacy/compose-watch-preflight.mjs" --help > "$scratch/legacy-help"
  assert_contains "$scratch/legacy-help" "compose-watch-preflight.mjs"
  expect_failure node "$legacy/ensure-compose-dev-images.mjs" --unknown-option
  LEGACY="$legacy" node --input-type=module <<'NODE'
import { pathToFileURL } from "node:url";
const helpers = await import(
  pathToFileURL(`${process.env.LEGACY}/verify-compose-helpers.mjs`)
);
for (const name of [
  "assert",
  "extractDockerStage",
  "extractServiceBlock",
  "readPlatformDockerfile",
  "workflowTagsImageSuffix"
]) {
  if (typeof helpers[name] !== "function") throw new Error(`${name} is not exported`);
}
NODE
}

digest_a="sha256:$(printf '%064d' 1)"
digest_b="sha256:$(printf '%064d' 2)"
fixture_repository="ghcr.io/example/vivd-catalyst-fixture"

write_fixture_manifest() {
  local file="$1" release="$2" commit="$3"
  jq -n --arg release "$release" --arg commit "$commit" \
    --arg repository "$fixture_repository" --arg a "$digest_a" --arg b "$digest_b" '{
      schema: 1,
      release: $release,
      commits: { deployment: $commit, platform: $commit, capabilities: $commit },
      images: {
        api: "\($repository)-api@\($a)",
        ui: "\($repository)-ui@\($b)",
        "doc-worker": "\($repository)-doc-worker@\($a)",
        "workspace-command-worker": "\($repository)-workspace-command-worker@\($a)",
        "artifact-preview-worker": "\($repository)-artifact-preview-worker@\($a)",
        runner: "\($repository)-catalyst-runner-base@\($b)"
      }
    }' > "$file"
}

# A deployment repo named deployment.fixture with an origin, on main.
init_fixture_deployment() {
  local root="$1" deployment="$1/deployment.fixture"
  mkdir -p "$deployment/deploy" "$deployment/.github/workflows"
  cat > "$deployment/deploy/deployment.env" <<ENV
# The one input of the deployment kit.
INSTANCE=fixture
IMAGE_REPOSITORY=$fixture_repository
APP_PACKAGE=@example/fixture
EXECUTION_WORKSPACES=1
ENV
  printf 'PLATFORM_REF=%040d\nCAPABILITIES_REF=%040d\n' 1 2 > "$deployment/deploy/release.refs"
  printf 'services: {}\n' > "$deployment/docker-compose.prod.yml"
  printf '{$PUBLIC_HOSTNAMES} {\n}\n' > "$deployment/deploy/Caddyfile"
  printf '{"name":"@example/fixture"}\n' > "$deployment/package.json"
  printf 'name: Deploy\n' > "$deployment/.github/workflows/deploy.yml"
  git init -q --bare "$root/origin.git"
  git -C "$deployment" init -q -b main
  git -C "$deployment" config user.name Fixture
  git -C "$deployment" config user.email fixture@example.test
  git -C "$deployment" add -A
  git -C "$deployment" commit -qm "fixture"
  git -C "$deployment" remote add origin "$root/origin.git"
  git -C "$deployment" push -q origin main
}

test_deployment_env() {
  local root="$scratch/env-fixture" deployment="$scratch/env-fixture/deployment.fixture"
  init_fixture_deployment "$root"
  mkdir -p "$deployment/src/nested"
  (
    cd "$deployment/src/nested"
    # shellcheck source=../lib/deployment-env.sh
    source "$kit_dir/lib/deployment-env.sh"
    load_deployment_env
    require_workspace_layout
    [[ "$DEPLOYMENT_ROOT" == "$deployment" ]] || fail "deployment root was not found from a subdirectory"
    [[ "$WORKSPACE_ROOT" == "$root" ]] || fail "workspace root is not the parent directory"
    [[ "$REMOTE_APP_DIR" == "/opt/vivd-catalyst/fixture" ]] || fail "unexpected app dir"
    [[ "$REMOTE_ENV_FILE" == "/etc/vivd-catalyst/fixture/app.env" ]] || fail "unexpected env file"
  )

  local env_file="$deployment/deploy/deployment.env" original
  original="$(cat "$env_file")"
  printf '%s\nSERVICES=api\n' "$original" > "$env_file"
  expect_failure env DEPLOYMENT_ROOT="$deployment" "$catalyst_deploy" prepare-workspace
  assert_contains "$scratch/failure-output" "unknown key SERVICES"
  printf '%s\n' "${original/INSTANCE=fixture/INSTANCE=Fixture/..}" > "$env_file"
  expect_failure env DEPLOYMENT_ROOT="$deployment" "$catalyst_deploy" prepare-workspace
  assert_contains "$scratch/failure-output" "INSTANCE must be"
  printf '%s\n' "${original/EXECUTION_WORKSPACES=1/EXECUTION_WORKSPACES=yes}" > "$env_file"
  expect_failure env DEPLOYMENT_ROOT="$deployment" "$catalyst_deploy" prepare-workspace
  assert_contains "$scratch/failure-output" "EXECUTION_WORKSPACES must be 0 or 1"
  printf '%s\n' "${original/INSTANCE=fixture/INSTANCE=other}" > "$env_file"
  expect_failure env DEPLOYMENT_ROOT="$deployment" "$catalyst_deploy" prepare-workspace
  assert_contains "$scratch/failure-output" "must be named deployment.other"

  expect_failure env -u DEPLOYMENT_ROOT bash -c 'cd / && "$0" deploy --host h --manifest m' \
    "$catalyst_deploy"
  assert_contains "$scratch/failure-output" "no deploy/deployment.env here or above"
}

test_release_manifest() {
  local root="$scratch/manifest-fixture" deployment="$scratch/manifest-fixture/deployment.fixture"
  local manifest="$scratch/manifest-fixture/manifest.json" commit images
  init_fixture_deployment "$root"
  commit="$(git -C "$deployment" rev-parse HEAD)"
  images="$(jq -c '.images' <(write_fixture_manifest /dev/stdout staging-1 "$commit"))"

  (cd "$deployment" && "$catalyst_deploy" manifest write --release staging-2026.10.06-1 \
    --images "$(jq -c '{api, ui}' <<< "$images")" \
    --images "$(jq -c 'del(.api, .ui)' <<< "$images")") > "$manifest"
  [[ "$(jq -r '.schema' "$manifest")" == "1" ]] || fail "manifest schema is not 1"
  [[ "$(jq -r '.commits.deployment' "$manifest")" == "$commit" ]] \
    || fail "manifest does not record the deployment commit"
  [[ "$(jq -r '.commits.platform' "$manifest")" == "$(printf '%040d' 1)" ]] \
    || fail "manifest does not record the platform ref"
  "$catalyst_deploy" manifest check "$manifest" --commit "$commit"
  expect_failure "$catalyst_deploy" manifest check "$manifest" --commit "$(printf '%040d' 9)"
  assert_contains "$scratch/failure-output" "another deployment commit"

  # One image short, a tag instead of a digest, a production tag as release, schema 2.
  expect_failure bash -c 'cd "$1" && "$2" manifest write --release staging-1 --images "$3"' _ \
    "$deployment" "$catalyst_deploy" "$(jq -c 'del(.runner)' <<< "$images")"
  local broken="$scratch/manifest-fixture/broken.json" filter
  for filter in \
    '.images.api = "ghcr.io/example/api:latest"' \
    '.release = "v2026.10.06-1"' \
    '.images.extra = .images.api' \
    '.schema = 2'
  do
    jq "$filter" "$manifest" > "$broken"
    expect_failure "$catalyst_deploy" manifest check "$broken"
    assert_contains "$scratch/failure-output" "invalid manifest"
  done

  local fixtures="$scratch/manifest-fixture/gh"
  mkdir -p "$fixtures"
  cp "$manifest" "$fixtures/release-manifest.json"
  jq -n --arg ref staging-2026.10.06-1 '[{ id: 7, ref: $ref }, { id: 8, ref: "staging-other" }]' \
    > "$fixtures/deployments.json"
  local gh_env=(env "PATH=$fakes:$PATH" "GH_FIXTURES=$fixtures" "GH_LOG=$fixtures/gh.log")

  "${gh_env[@]}" "$catalyst_deploy" manifest fetch staging-2026.10.06-1 "$scratch/fetched.json"
  cmp -s "$scratch/fetched.json" "$manifest" || fail "manifest fetch did not download the asset"

  printf '[{ "state": "in_progress" }, { "state": "failure" }]\n' > "$fixtures/statuses.json"
  expect_failure "${gh_env[@]}" "$catalyst_deploy" manifest staging-deployed "$manifest"
  assert_contains "$scratch/failure-output" "has no successful staging deployment"
  printf '[{ "state": "in_progress" }, { "state": "success" }]\n' > "$fixtures/statuses.json"
  "${gh_env[@]}" "$catalyst_deploy" manifest staging-deployed "$manifest" > "$scratch/staging-deployed"
  assert_contains "$scratch/staging-deployed" "was deployed to staging successfully (deployment 7)"
  assert_contains "$fixtures/gh.log" \
    "api repos/{owner}/{repo}/deployments?environment=staging&sha=$commit&per_page=100"
  assert_not_contains "$fixtures/gh.log" "deployments/8/statuses"
}

test_publish() {
  local root="$scratch/publish-fixture" deployment="$scratch/publish-fixture/deployment.fixture"
  local fixtures="$scratch/publish-fixture/gh" commit
  init_fixture_deployment "$root"
  commit="$(git -C "$deployment" rev-parse HEAD)"
  mkdir -p "$fixtures"
  local publish=(env "PATH=$fakes:$PATH" "GH_FIXTURES=$fixtures" "GH_LOG=$fixtures/gh.log"
    "DEPLOYMENT_ROOT=$deployment" "$catalyst_deploy" publish)

  # Staging tags the pushed main commit; anything else is refused.
  printf 'dirty\n' > "$deployment/untracked"
  expect_failure "${publish[@]}" staging --skip-local-checks
  assert_contains "$scratch/failure-output" "working tree has uncommitted changes"
  rm "$deployment/untracked"
  git -C "$deployment" switch -q -c feature
  expect_failure "${publish[@]}" staging --skip-local-checks
  assert_contains "$scratch/failure-output" "publish from main"
  git -C "$deployment" switch -q main
  expect_failure "${publish[@]}" staging --skip-local-checks --tag v1
  assert_contains "$scratch/failure-output" "staging tags must start with staging-"

  "${publish[@]}" staging --skip-local-checks --tag staging-2026.10.06-1 > "$scratch/publish-output"
  [[ "$(git -C "$root/origin.git" rev-parse 'refs/tags/staging-2026.10.06-1^{commit}')" == "$commit" ]] \
    || fail "publish staging did not push the tag for main"
  assert_contains "$scratch/publish-output" "Published staging tag: staging-2026.10.06-1"
  assert_contains "$fixtures/gh.log" "--branch staging-2026.10.06-1 --event push"

  # Production promotes a staging release, and only one that staging ran.
  write_fixture_manifest "$fixtures/release-manifest.json" staging-2026.10.06-1 "$commit"
  jq -n '[{ id: 7, ref: "staging-2026.10.06-1" }]' > "$fixtures/deployments.json"
  printf '[{ "state": "failure" }]\n' > "$fixtures/statuses.json"
  : > "$fixtures/gh.log"
  expect_failure "${publish[@]}" production --tag v2026.10.06-1
  assert_contains "$scratch/failure-output" "has no successful staging deployment"
  [[ -z "$(git -C "$deployment" tag --list 'v*')" ]] \
    || fail "publish production tagged a release that staging did not run"
  assert_not_contains "$fixtures/gh.log" "workflow run"

  expect_failure "${publish[@]}" production --tag v2026.10.06-1 --release v2026.10.01-1
  assert_contains "$scratch/failure-output" "--release must be a staging-* tag"
  rm "$fixtures/release-manifest.json"
  expect_failure "${publish[@]}" production --tag v2026.10.06-1
  assert_contains "$scratch/failure-output" "has no release-manifest.json"

  # A commit after the staging release must not change what production gets.
  write_fixture_manifest "$fixtures/release-manifest.json" staging-2026.10.06-1 "$commit"
  printf '[{ "state": "success" }]\n' > "$fixtures/statuses.json"
  git -C "$deployment" commit -q --allow-empty -m "later"
  git -C "$deployment" push -q origin main
  : > "$fixtures/gh.log"
  "${publish[@]}" production --tag v2026.10.06-1 --release staging-2026.10.06-1 \
    > "$scratch/publish-output"
  [[ "$(git -C "$root/origin.git" rev-parse 'refs/tags/v2026.10.06-1^{commit}')" == "$commit" ]] \
    || fail "publish production did not tag the commit of the staging release"
  assert_contains "$fixtures/gh.log" "release create v2026.10.06-1"
  assert_contains "$fixtures/gh.log" "workflow run deploy.yml --ref v2026.10.06-1 -f environment=production"
  assert_contains "$scratch/publish-output" "Deploy run: https://github.example/runs/4711"

  # Without --release, production promotes the staging release of origin/main.
  expect_failure "${publish[@]}" production --tag v2026.10.06-2
  assert_contains "$scratch/failure-output" "origin/main has no staging release"
}

# Runs the kit's deploy against a fake ssh and rsync; the capture lands in $1.
capture_fixture_deploy() {
  local capture="$1" root="$1/workspace" deployment="$1/workspace/deployment.fixture"
  shift
  mkdir -p "$capture"
  init_fixture_deployment "$root"
  write_fixture_manifest "$capture/manifest.json" staging-2026.10.06-1 \
    "$(git -C "$deployment" rev-parse HEAD)"
  (cd "$deployment" && PATH="$fakes:$PATH" CAPTURE_DIR="$capture" "$catalyst_deploy" deploy \
    --host host.example.test --manifest "$capture/manifest.json" "$@" <<< "stdin of the caller") \
    > "$capture/output"
}

test_deploy() {
  local capture="$scratch/deploy-capture"
  capture_fixture_deploy "$capture"
  assert_contains "$capture/output" "Deploying staging-2026.10.06-1 to host.example.test"

  # The host keeps its paths: scripts in the app directory, units under deploy/systemd.
  local app_dir=/opt/vivd-catalyst/fixture path
  for path in docker-compose.prod.yml deploy/Caddyfile backup-postgres.sh restore-postgres.sh \
    deploy/systemd/vivd-catalyst-fixture-backup.service \
    deploy/systemd/vivd-catalyst-fixture-backup.timer
  do
    assert_contains "$capture/rsync.log" " deploy@host.example.test $app_dir/$path "
  done
  [[ "$(wc -l < "$capture/rsync.log" | tr -d ' ')" == "6" ]] \
    || fail "deploy sent files that are not part of a release"
  if grep -R -q '@INSTANCE' "$capture/host"; then
    fail "a host file was sent with an unfilled placeholder"
  fi
  local host="$capture/host$app_dir"
  assert_contains "$host/backup-postgres.sh" "app_dir=\"\${APP_DIR:-$app_dir}\""
  assert_contains "$host/backup-postgres.sh" "env_file=\"\${ENV_FILE:-/etc/vivd-catalyst/fixture/app.env}\""
  assert_contains "$host/backup-postgres.sh" "name=\"fixture-\${POSTGRES_DB}-"
  assert_contains "$host/restore-postgres.sh" "app_dir=\"\${APP_DIR:-$app_dir}\""
  assert_contains "$host/deploy/systemd/vivd-catalyst-fixture-backup.service" \
    "ExecStart=$app_dir/backup-postgres.sh"
  assert_contains "$host/deploy/systemd/vivd-catalyst-fixture-backup.service" \
    "Description=Back up Fixture Postgres to object storage"
  bash -n "$host/backup-postgres.sh"
  bash -n "$host/restore-postgres.sh"

  # Two ssh calls: create the directories, then run the remote script. The script
  # travels as an argument and ssh gets no stdin, see lib/deploy.sh.
  [[ "$(cat "$capture/ssh.count")" == "2" ]] || fail "deploy made an unexpected number of ssh calls"
  assert_contains "$capture/ssh-1.command" "mkdir -p '$app_dir/deploy/scripts' '$app_dir/deploy/systemd'"
  [[ "$(cat "$capture/ssh-2.target")" == "deploy@host.example.test" ]] || fail "unexpected ssh target"
  [[ ! -s "$capture/ssh-2.stdin" ]] || fail "the remote script could read the caller's stdin"
  local remote_command="$capture/ssh-2.command"
  assert_contains "$remote_command" "REMOTE_APP_DIR=$app_dir REMOTE_ENV_FILE=/etc/vivd-catalyst/fixture/app.env"
  assert_contains "$remote_command" "IMAGE_REPOSITORY=$fixture_repository IMAGE_TAG=staging-2026.10.06-1"
  assert_contains "$remote_command" "API_IMAGE_DIGEST=$digest_a UI_IMAGE_DIGEST=$digest_b"
  assert_contains "$remote_command" "RUNNER_IMAGE_DIGEST=$digest_b EXECUTION_WORKSPACES=1 bash -c "
  if grep -v '^[[:space:]]*#' "$kit_dir/lib/deploy.sh" | grep -Eq 'bash -s([[:space:]"]|$)'; then
    fail "deploy.sh must not feed the remote script to bash on stdin"
  fi

  # A manifest of another image repository is not this instance's release.
  jq '.images |= map_values(sub("vivd-catalyst-fixture"; "vivd-catalyst-other"))' \
    "$capture/manifest.json" > "$capture/foreign.json"
  expect_failure env "PATH=$fakes:$PATH" "CAPTURE_DIR=$capture" \
    "DEPLOYMENT_ROOT=$capture/workspace/deployment.fixture" \
    "$catalyst_deploy" deploy --host host.example.test --manifest "$capture/foreign.json"
  assert_contains "$scratch/failure-output" "Unexpected image name for api"
  expect_failure env "DEPLOYMENT_ROOT=$capture/workspace/deployment.fixture" \
    "$catalyst_deploy" deploy --host host.example.test --manifest "$capture/manifest.json" \
    --remote-app-dir /srv/elsewhere
  assert_contains "$scratch/failure-output" "Unknown argument: --remote-app-dir"
}

# The scripts that run on the host expand empty arrays under "set -u". The hosts'
# bash accepts that; bash before 4.4 (macOS) does not, so those cases run on Linux only.
has_host_bash() {
  if (( BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1] >= 404 )); then
    return 0
  fi
  echo "deployment-kit test: bash $BASH_VERSION is older than the hosts', skipping $1" >&2
  return 1
}

# Runs the command a deploy sends to the host, with docker, sudo and the backup
# script replaced. HOST_LOG lists what ran, in order.
run_remote_deploy() {
  local capture="$1" host="$2"
  shift 2
  local app_dir="$host/app" bin="$host/bin"
  mkdir -p "$app_dir" "$bin" "$host/state"
  cp "$fakes/host-docker" "$bin/docker"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$bin/sleep"
  cat > "$bin/sudo" <<'SH'
#!/usr/bin/env bash
if [[ "$1" == "install" ]]; then
  cp "${@: -2:1}" "${@: -1}"
else
  exec "$@"
fi
SH
  cat > "$app_dir/backup-postgres.sh" <<'SH'
#!/usr/bin/env bash
echo "backup-postgres.sh $* prefix=$BACKUP_PREFIX app=$APP_DIR env=$ENV_FILE" >> "$HOST_LOG"
[[ "${HOST_BACKUP_FAILS:-0}" != "1" ]]
SH
  cp "$app_dir/backup-postgres.sh" "$app_dir/restore-postgres.sh"
  chmod +x "$bin"/* "$app_dir"/*.sh
  printf 'POSTGRES_DB=agent_chat\nPUBLIC_HOSTNAMES=a.example.test,b.example.test\nIMAGE_TAG=previous\n' \
    > "$host/app.env"
  # The command names the real host paths; point it at the scratch host instead.
  sed -e "s#REMOTE_APP_DIR=[^ ]*#REMOTE_APP_DIR=$app_dir#" \
    -e "s#REMOTE_ENV_FILE=[^ ]*#REMOTE_ENV_FILE=$host/app.env#" \
    "$capture/ssh-2.command" > "$host/command"
  env "PATH=$bin:$PATH" "HOST_LOG=$host/log" "HOST_STATE=$host/state" "$@" \
    bash -c "$(cat "$host/command")" > "$host/output" 2>&1 < /dev/null
}

test_remote_deploy() {
  local capture="$scratch/deploy-capture" host="$scratch/host" log="$scratch/host/log"
  local release="staging-2026.10.06-1"
  run_remote_deploy "$capture" "$host" || { cat "$host/output" >&2; fail "remote deploy failed"; }
  assert_contains "$host/output" "All services run the images of $release."

  # The release reaches the env file for later manual Compose commands.
  assert_contains "$host/app.env" "IMAGE_TAG=$release"
  assert_contains "$host/app.env" "API_IMAGE_DIGEST=$digest_a"
  assert_contains "$host/app.env" "RUNNER_IMAGE_DIGEST=$digest_b"
  assert_contains "$host/app.env" 'PUBLIC_HOSTNAMES="a.example.test, b.example.test"'
  assert_not_contains "$host/app.env" "IMAGE_TAG=previous"

  # Order: pull, postgres, backup under pre-deploy/, migrate, services, health, roll.
  local profile="compose --profile execution-workspaces --env-file $host/app.env -f $host/app/docker-compose.prod.yml"
  local backup="backup-postgres.sh pre-deploy-$release prefix=pre-deploy app=$host/app env=$host/app.env"
  local previous=0 current step
  for step in \
    "docker image prune --all --force" \
    "docker $profile pull" \
    "docker pull $fixture_repository-catalyst-runner-base:$release@$digest_b" \
    "docker $profile up -d --wait postgres" \
    "$backup" \
    "docker $profile run --rm -T migrate" \
    "docker $profile up -d api doc-worker artifact-preview-worker ui caddy workspace-command-worker" \
    "docker $profile exec -T api node -e" \
    "docker $profile up -d --no-deps --no-recreate --scale agent-run-worker=2 agent-run-worker" \
    "docker inspect -f {{.Config.Image}} {{.State.Running}} api-new"
  do
    current="$(line_of "$log" "$step")"
    [[ -n "$current" ]] || fail "remote deploy did not run: $step"
    (( current > previous )) || fail "remote deploy ran out of order: $step"
    previous="$current"
  done
  if grep -E 'up -d [^-].*agent-run-worker' "$log" | grep -v -e '--no-recreate' -q; then
    fail "agent-run-worker was recreated instead of rolled"
  fi

  # The previous worker is stopped only after the new one runs, and in the background.
  assert_contains "$host/output" "Draining previous agent-run-worker container(s) in the background: agent-run-worker-old"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    grep -Fq "docker rm agent-run-worker-old" "$log" && break
    command sleep 0.5
  done
  (( $(line_of "$log" "docker stop agent-run-worker-old") \
    > $(line_of "$log" "docker inspect -f {{.State.Running}} agent-run-worker-new") )) \
    || fail "the previous agent-run-worker was stopped before the new one was verified"
  local service
  for service in api agent-run-worker doc-worker artifact-preview-worker ui workspace-command-worker; do
    assert_contains "$log" "docker inspect -f {{.Config.Image}} {{.State.Running}} $service-new"
  done

  # A failed backup aborts before migrations and before any service is replaced.
  host="$scratch/host-backup-fails"
  if run_remote_deploy "$capture" "$host" HOST_BACKUP_FAILS=1; then
    fail "remote deploy went on after a failed pre-deploy backup"
  fi
  assert_contains "$host/log" "backup-postgres.sh pre-deploy-$release"
  assert_not_contains "$host/log" "run --rm -T migrate"
  assert_not_contains "$host/log" "up -d api"

  # A service that does not run the release digest fails the deploy.
  for service in api agent-run-worker ui; do
    host="$scratch/host-stale-$service"
    if run_remote_deploy "$capture" "$host" "HOST_STALE_SERVICE=$service"; then
      fail "remote deploy passed although $service runs another image"
    fi
    assert_contains "$host/output" "Service $service is not running the release image"
  done

  # Without execution workspaces neither the worker nor the runner is touched.
  has_host_bash "the deploy without execution workspaces" || return 0
  capture="$scratch/deploy-capture-without-workspaces"
  mkdir -p "$capture"
  init_fixture_deployment "$capture/workspace"
  sed -i.bak 's/^EXECUTION_WORKSPACES=1$/EXECUTION_WORKSPACES=0/' \
    "$capture/workspace/deployment.fixture/deploy/deployment.env"
  write_fixture_manifest "$capture/manifest.json" "$release" "$(printf '%040d' 3)"
  (cd "$capture/workspace/deployment.fixture" && PATH="$fakes:$PATH" CAPTURE_DIR="$capture" \
    "$catalyst_deploy" deploy --host host.example.test --manifest "$capture/manifest.json") \
    > /dev/null
  host="$scratch/host-without-workspaces"
  run_remote_deploy "$capture" "$host" || { cat "$host/output" >&2; fail "remote deploy failed"; }
  assert_not_contains "$host/log" "execution-workspaces"
  assert_not_contains "$host/log" "catalyst-runner-base"
  assert_not_contains "$host/log" "workspace-command-worker"
}

# Backup and restore run on the host; docker is replaced and logs its arguments.
test_host_backup_scripts() {
  local capture="$scratch/deploy-capture" host="$scratch/backup-host"
  local scripts="$capture/host/opt/vivd-catalyst/fixture" log="$scratch/backup-host/log"
  mkdir -p "$host/bin" "$host/app"
  cat > "$host/bin/docker" <<'SH'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "$HOST_LOG"
case "$*" in
  *"pg_dump"*) echo "-- dump" ;;
  *"s3 ls s3://backups/postgres/") echo "2026-10-06 02:15:14 1234 fixture-agent_chat-20261006T021514Z.sql.gz" ;;
  *"s3 ls s3://backups/pre-deploy/") echo "2026-10-05 10:00:00 99 fixture-agent_chat-20261005T100000Z-pre-deploy-v1.sql.gz" ;;
esac
SH
  chmod +x "$host/bin/docker"
  cat > "$host/app.env" <<'ENV'
POSTGRES_USER=catalyst
POSTGRES_DB=agent_chat
BACKUP_OBJECT_STORE_ENDPOINT=https://objects.example.test
BACKUP_OBJECT_STORE_BUCKET=backups
BACKUP_OBJECT_STORE_REGION=eu
BACKUP_AWS_ACCESS_KEY_ID=key
BACKUP_AWS_SECRET_ACCESS_KEY="secret value"
ENV
  local run=(env "PATH=$host/bin:$PATH" "HOST_LOG=$log" "APP_DIR=$host/app" "ENV_FILE=$host/app.env")

  "${run[@]}" "$scripts/backup-postgres.sh" > "$host/output"
  assert_contains "$log" "docker compose --env-file $host/app.env -f $host/app/docker-compose.prod.yml exec -T postgres pg_dump -U catalyst agent_chat"
  grep -Eq '^Backup uploaded: postgres/fixture-agent_chat-[0-9]{8}T[0-9]{6}Z\.sql\.gz \(' "$host/output" \
    || fail "nightly dump is not named <instance>-<database>-<timestamp> under postgres/"
  grep -Eq ' amazon/aws-cli:[0-9]+\.[0-9]+\.[0-9]+ --endpoint-url https://objects.example.test --region eu s3 cp /backup/fixture-.* s3://backups/postgres/fixture-' "$log" \
    || fail "backup did not upload with the pinned aws-cli image"
  assert_contains "$log" "-e AWS_SECRET_ACCESS_KEY=secret value"

  "${run[@]}" BACKUP_PREFIX=pre-deploy "$scripts/backup-postgres.sh" pre-deploy-v1 > "$host/output"
  grep -Eq '^Backup uploaded: pre-deploy/fixture-agent_chat-[0-9TZ]+-pre-deploy-v1\.sql\.gz ' "$host/output" \
    || fail "pre-deploy dump is not stored under pre-deploy/ with its label"
  expect_failure "${run[@]}" "$scripts/backup-postgres.sh" "bad label"
  assert_contains "$scratch/failure-output" "Invalid backup label"

  if has_host_bash "restore-postgres.sh list"; then
    "${run[@]}" "$scripts/restore-postgres.sh" list > "$host/output"
    assert_contains "$host/output" "2026-10-05T10:00:00Z 99 pre-deploy/fixture-agent_chat-20261005T100000Z-pre-deploy-v1.sql.gz"
    assert_contains "$host/output" "2026-10-06T02:15:14Z 1234 postgres/fixture-agent_chat-20261006T021514Z.sql.gz"
    assert_contains "$log" "-e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY amazon/aws-cli:"
  fi
  expect_failure "${run[@]}" "$scripts/restore-postgres.sh" verify "other/x.sql.gz"
  assert_contains "$scratch/failure-output" "Invalid dump key"
  expect_failure "${run[@]}" "$scripts/restore-postgres.sh" recover postgres/x.sql.gz \
    --replace-database not_the_live_database
  assert_contains "$scratch/failure-output" "must name the live database of this host"

  if grep -Eq 'amazon/aws-cli(:latest)?[}"[:space:]]' \
    "$kit_dir/host/backup-postgres.sh" "$kit_dir/host/restore-postgres.sh"; then
    fail "backup and restore scripts must pin the amazon/aws-cli version"
  fi
}

# What "catalyst-deploy check" requires from the files a deployment repo owns.
test_deployment_policy() {
  local root="$scratch/policy-fixture" deployment="$scratch/policy-fixture/deployment.fixture"
  local fake_bin="$scratch/policy-fixture/fake-bin" pinned unpinned
  init_fixture_deployment "$root"
  mkdir -p "$fake_bin"
  cat > "$fake_bin/docker" <<'SH'
#!/usr/bin/env bash
[[ "$1 $2" == "buildx bake" ]] || exit 2
jq -n --arg targets "$BAKE_TARGETS" '{
  target: ($targets | split(" ") | map({
    key: .,
    value: { tags: ["ghcr.io/example/vivd-catalyst-fixture-\(.):local"] }
  }) | from_entries)
}'
SH
  chmod +x "$fake_bin/docker"
  local all_targets="api ui doc-worker workspace-command-worker artifact-preview-worker runner"
  local policy=(env "PATH=$fake_bin:$PATH" "DEPLOYMENT_ROOT=$deployment"
    bash "$kit_dir/lib/check-deployment-policy.sh")
  pinned='    image: ${IMAGE_REPOSITORY}-api:${IMAGE_TAG}@${API_IMAGE_DIGEST:?API_IMAGE_DIGEST is required}'
  unpinned='    image: ${IMAGE_REPOSITORY}-ui:${IMAGE_TAG}'
  local gate='        run: catalyst-deploy manifest staging-deployed "$RUNNER_TEMP/release-manifest.json"'

  printf '{"name":"@example/other"}\n' > "$deployment/package.json"
  expect_failure "${policy[@]}"
  assert_contains "$scratch/failure-output" "APP_PACKAGE in deploy/deployment.env is not the name"
  printf '{"name":"@example/fixture"}\n' > "$deployment/package.json"

  printf 'services:\n  api:\n%s\n  ui:\n%s\n' "$pinned" "$unpinned" \
    > "$deployment/docker-compose.prod.yml"
  expect_failure "${policy[@]}"
  assert_contains "$scratch/failure-output" "must pin every first-party image by digest"

  printf 'services:\n  api:\n%s\n' "$pinned" > "$deployment/docker-compose.prod.yml"
  expect_failure "${policy[@]}"
  assert_contains "$scratch/failure-output" "must require a successful staging deployment"

  printf '%s\n' "$gate" >> "$deployment/.github/workflows/deploy.yml"
  expect_failure env BAKE_TARGETS="${all_targets% runner}" "${policy[@]}"
  assert_contains "$scratch/failure-output" "invalid manifest"
  expect_failure env BAKE_TARGETS="$all_targets extra" "${policy[@]}"
  assert_contains "$scratch/failure-output" "invalid manifest"

  # With matching bake targets the check moves on to the Compose wiring, which
  # this fixture does not have.
  expect_failure env BAKE_TARGETS="$all_targets" "${policy[@]}"
  assert_not_contains "$scratch/failure-output" "invalid manifest"
  assert_contains "$scratch/failure-output" "verify/artifact-preview-worker-compose.mjs"
}

# pnpm pack keeps the executable bit of the bin only. The commands must not depend
# on any other file being executable.
test_packed_layout() {
  local packed="$scratch/packed" capture="$scratch/packed-capture"
  mkdir -p "$packed"
  cp -R "$kit_dir/bin" "$kit_dir/lib" "$kit_dir/host" "$kit_dir/verify" "$kit_dir/dev" "$packed/"
  find "$packed/lib" "$packed/host" "$packed/verify" "$packed/dev" -type f -exec chmod 0644 {} +
  mkdir -p "$scratch/packed-bin"
  ln -s "$packed/bin/catalyst-deploy" "$scratch/packed-bin/catalyst-deploy"

  catalyst_deploy="$scratch/packed-bin/catalyst-deploy" capture_fixture_deploy "$capture"
  cmp -s "$capture/ssh-2.command" "$scratch/deploy-capture/ssh-2.command" \
    || fail "the packed kit sends another remote command"
  local deployment="$capture/workspace/deployment.fixture"
  mkdir -p "$capture/workspace/platform" "$capture/workspace/capabilities" "$deployment/deploy/workspace"
  printf "lockfileVersion: '9.0'\n" > "$deployment/deploy/workspace/pnpm-lock.yaml"
  DEPLOYMENT_ROOT="$deployment" "$scratch/packed-bin/catalyst-deploy" prepare-workspace
  assert_contains "$capture/workspace/pnpm-workspace.yaml" '  - "deployment.fixture"'
  DEPLOYMENT_ROOT="$deployment" "$scratch/packed-bin/catalyst-deploy" update-refs --help \
    > "$scratch/packed-help"
  assert_contains "$scratch/packed-help" "update-release.sh --deployment-root DIR"
  expect_failure env "DEPLOYMENT_ROOT=$deployment" "$scratch/packed-bin/catalyst-deploy" publish
  expect_failure env "DEPLOYMENT_ROOT=$deployment" "$scratch/packed-bin/catalyst-deploy" check
  assert_contains "$scratch/failure-output" "must require a successful staging deployment"
}

test_shell_files() {
  local file
  local files=("$kit_dir/bin/catalyst-deploy" "$kit_dir"/lib/*.sh "$kit_dir"/host/*.sh
    "$kit_dir"/tests/*.sh "$kit_dir"/tests/fakes/* "$platform_dir"/scripts/deployment-kit/*.sh)
  for file in "${files[@]}"; do
    bash -n "$file"
  done
  if ! command -v shellcheck >/dev/null 2>&1; then
    echo "deployment-kit test: shellcheck is not installed, skipping the lint" >&2
    return
  fi
  # deploy-remote.sh has no shebang because it is sent to the host as it is.
  # SC2024: its redirect of "sudo awk" writes a temp file the deploy user owns.
  shellcheck --severity=warning --shell=bash --exclude=SC2024 "${files[@]}"
}

test_shell_files
test_prepare_build_workspace
test_update_release
test_compose_watch_preflight
test_ensure_compose_dev_images
test_compose_helpers
test_legacy_paths
test_deployment_env
test_release_manifest
test_publish
test_deploy
test_remote_deploy
test_host_backup_scripts
test_deployment_policy
test_packed_layout
echo "deployment-kit tests passed"
