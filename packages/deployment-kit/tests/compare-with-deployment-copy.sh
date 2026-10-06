#!/usr/bin/env bash
set -euo pipefail

# Compares the kit with the script copies a deployment repo still carries under
# deploy/scripts: same inputs, fake ssh/rsync/gh, then a diff of everything that
# would reach the host or GitHub. Not part of the test run, because it needs the
# deployment checkout. Delete it once no deployment repo carries copies.
#
#   compare-with-deployment-copy.sh DEPLOYMENT_ROOT DEPLOYMENT_ENV_FILE
#
# DEPLOYMENT_ENV_FILE is the deploy/deployment.env the repo is going to commit.

deployment_root="$(cd "${1:?deployment root is required}" && pwd)"
deployment_env="$(cd "$(dirname "${2:?deployment.env file is required}")" && pwd)/$(basename "$2")"
kit_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fakes="$kit_dir/tests/fakes"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
instance="$(sed -n 's/^INSTANCE=//p' "$deployment_env")"
repository="$(sed -n 's/^IMAGE_REPOSITORY=//p' "$deployment_env")"
execution_workspaces="$(sed -n 's/^EXECUTION_WORKSPACES=//p' "$deployment_env")"
differences=0
# Same commit ids on both sides, so that tags and manifests are comparable.
export GIT_AUTHOR_DATE=2026-10-06T00:00:00Z GIT_COMMITTER_DATE=2026-10-06T00:00:00Z

section() {
  printf '\n== %s\n' "$1"
}

# Prints the diff of two files or "identical".
compare() {
  local label="$1" old="$2" new="$3"
  if diff -u "$old" "$new" > "$scratch/diff"; then
    printf '  identical: %s\n' "$label"
  else
    printf '  DIFFERENT: %s\n' "$label"
    sed 's/^/    /' "$scratch/diff"
    differences=$((differences + 1))
  fi
}

# Two copies of the committed deployment tree with one origin each: "old" runs the
# repo's own scripts, "new" has deploy/deployment.env and runs the kit.
make_pair() {
  local name="$1" side tree
  for side in old new; do
    tree="$scratch/$name/$side/deployment.$instance"
    mkdir -p "$tree"
    git -C "$deployment_root" archive HEAD | tar -x -C "$tree"
    [[ "$side" == "old" ]] || cp "$deployment_env" "$tree/deploy/deployment.env"
    git init -q --bare "$scratch/$name/$side/origin.git"
    git -C "$tree" init -q -b main
    git -C "$tree" config user.name Fixture
    git -C "$tree" config user.email fixture@example.test
    git -C "$tree" add -A
    # deployment.env stays out of the commit: both sides get the same commit id.
    git -C "$tree" reset -q -- deploy/deployment.env
    git -C "$tree" commit -qm "fixture"
    git -C "$tree" remote add origin "$scratch/$name/$side/origin.git"
    git -C "$tree" push -q origin main
    [[ "$side" == "old" ]] || printf 'deploy/deployment.env\n' >> "$tree/.git/info/exclude"
  done
}

write_manifest() {
  local file="$1" release="$2" commit="$3"
  digest() { printf 'sha256:%064d' "$1"; }
  jq -n --arg release "$release" --arg commit "$commit" --arg repository "$repository" \
    --arg a "$(digest 1)" --arg b "$(digest 2)" --arg c "$(digest 3)" --arg d "$(digest 4)" \
    --arg e "$(digest 5)" --arg f "$(digest 6)" '{
      schema: 1,
      release: $release,
      commits: { deployment: $commit, platform: $commit, capabilities: $commit },
      images: {
        api: "\($repository)-api@\($a)",
        ui: "\($repository)-ui@\($b)",
        "doc-worker": "\($repository)-doc-worker@\($c)",
        "workspace-command-worker": "\($repository)-workspace-command-worker@\($d)",
        "artifact-preview-worker": "\($repository)-artifact-preview-worker@\($e)",
        runner: "\($repository)-catalyst-runner-base@\($f)"
      }
    }' > "$file"
}

section "deploy: what reaches the host"
make_pair deploy
manifest="$scratch/deploy/manifest.json"
write_manifest "$manifest" staging-2026.10.06-1 "$(git -C "$scratch/deploy/old/deployment.$instance" rev-parse HEAD)"
old_flags=(--ssh-user deploy
  --remote-app-dir "/opt/vivd-catalyst/$instance"
  --remote-env-file "/etc/vivd-catalyst/$instance/app.env")
[[ "$execution_workspaces" != "1" ]] || old_flags+=(--execution-workspaces)
for side in old new; do
  mkdir "$scratch/deploy/$side/capture"
  (
    cd "$scratch/deploy/$side/deployment.$instance"
    export PATH="$fakes:$PATH" CAPTURE_DIR="$scratch/deploy/$side/capture"
    if [[ "$side" == "old" ]]; then
      deploy/scripts/deploy.sh --host host.example.test --manifest "$manifest" "${old_flags[@]}"
    else
      "$kit_dir/bin/catalyst-deploy" deploy --host host.example.test --manifest "$manifest"
    fi
  ) > "$scratch/deploy/$side/capture/output" 2>&1 <<< "stdin of the caller"
done
old="$scratch/deploy/old/capture"
new="$scratch/deploy/new/capture"
compare "local output" "$old/output" "$new/output"
compare "number of ssh calls" "$old/ssh.count" "$new/ssh.count"
compare "ssh call 1 (create directories)" "$old/ssh-1.command" "$new/ssh-1.command"
compare "ssh call 2: target" "$old/ssh-2.target" "$new/ssh-2.target"
compare "ssh call 2: environment and remote script, as sent" "$old/ssh-2.command" "$new/ssh-2.command"
compare "ssh call 2: stdin the remote script can read" "$old/ssh-2.stdin" "$new/ssh-2.stdin"
compare "rsync: flags, target, host path, mode and content of every file" \
  "$old/rsync.log" "$new/rsync.log"
printf '  remote command: %s bytes, files sent: %s\n' \
  "$(wc -c < "$new/ssh-2.command" | tr -d ' ')" "$(wc -l < "$new/rsync.log" | tr -d ' ')"
sed 's/^/    /' "$new/rsync.log"

section "host scripts that a deploy does not send"
compare "configure-zram.sh" "$deployment_root/deploy/scripts/configure-zram.sh" \
  "$kit_dir/host/configure-zram.sh"
compare "load-deploy-env.sh" "$deployment_root/deploy/scripts/load-deploy-env.sh" \
  "$kit_dir/lib/load-deploy-env.sh"

section "release manifest"
make_pair manifest
old="$scratch/manifest/old/deployment.$instance"
new="$scratch/manifest/new/deployment.$instance"
commit="$(git -C "$old" rev-parse HEAD)"
write_manifest "$scratch/manifest/valid.json" staging-2026.10.06-1 "$commit"
images="$(jq -c '.images' "$scratch/manifest/valid.json")"
(cd "$old" && deploy/scripts/release-manifest.sh write --release staging-2026.10.06-1 \
  --images "$images") > "$scratch/manifest/old.json"
(cd "$new" && "$kit_dir/bin/catalyst-deploy" manifest write --release staging-2026.10.06-1 \
  --images "$images") > "$scratch/manifest/new.json"
compare "manifest write" "$scratch/manifest/old.json" "$scratch/manifest/new.json"

fixtures="$scratch/manifest/gh"
mkdir -p "$fixtures"
jq -n '[{ id: 7, ref: "staging-2026.10.06-1" }, { id: 8, ref: "staging-other" }]' \
  > "$fixtures/deployments.json"
# Runs one manifest subcommand on both sides and records exit code, output and gh calls.
both_manifest() {
  local label="$1" side status
  shift
  for side in old new; do
    : > "$fixtures/gh.log"
    status=0
    (
      cd "$scratch/manifest/$side/deployment.$instance"
      export PATH="$fakes:$PATH" GH_FIXTURES="$fixtures" GH_LOG="$fixtures/gh.log"
      if [[ "$side" == "old" ]]; then
        deploy/scripts/release-manifest.sh "$@"
      else
        "$kit_dir/bin/catalyst-deploy" manifest "$@"
      fi
    ) > "$scratch/manifest/$side.result" 2>&1 || status=$?
    { echo "exit $status"; echo "gh calls:"; cat "$fixtures/gh.log"; } >> "$scratch/manifest/$side.result"
  done
  compare "$label" "$scratch/manifest/old.result" "$scratch/manifest/new.result"
}
both_manifest "check: valid manifest" check "$scratch/manifest/valid.json" --commit "$commit"
both_manifest "check: other deployment commit" check "$scratch/manifest/valid.json" \
  --commit "$(printf '%040d' 9)"
for filter in 'del(.images.runner)' '.images.api = "example/api:latest"' '.schema = 2' \
  '.release = "v2026.10.06-1"' '.commits.platform = "main"'
do
  jq "$filter" "$scratch/manifest/valid.json" > "$scratch/manifest/invalid.json"
  both_manifest "check: $filter" check "$scratch/manifest/invalid.json"
done
for state in success failure; do
  printf '[{ "state": "in_progress" }, { "state": "%s" }]\n' "$state" > "$fixtures/statuses.json"
  both_manifest "staging-deployed: staging deployment ended in $state" \
    staging-deployed "$scratch/manifest/valid.json"
done
cp "$scratch/manifest/valid.json" "$fixtures/release-manifest.json"
both_manifest "fetch" fetch staging-2026.10.06-1 "$scratch/manifest/fetched.json"
rm "$fixtures/release-manifest.json"
both_manifest "fetch: release without manifest" fetch staging-2026.10.06-1 "$scratch/manifest/fetched.json"

section "publish: tags and GitHub calls"
# Runs one publish scenario on both sides in fresh repo pairs. PREPARE is evaluated
# in each deployment copy before the publish; the gh fixtures come from the caller.
scenario=0
both_publish() {
  local label="$1" prepare="$2" side status tree
  shift 2
  scenario=$((scenario + 1))
  make_pair "publish-$scenario"
  for side in old new; do
    tree="$scratch/publish-$scenario/$side/deployment.$instance"
    mkdir -p "$scratch/publish-$scenario/$side/gh"
    cp "$scratch/publish-gh/"* "$scratch/publish-$scenario/$side/gh/" 2>/dev/null || true
    status=0
    (
      cd "$tree"
      export PATH="$fakes:$PATH" GH_FIXTURES="$scratch/publish-$scenario/$side/gh"
      export GH_LOG="$scratch/publish-$scenario/$side/gh.log"
      : > "$GH_LOG"
      eval "$prepare"
      if [[ "$side" == "old" ]]; then
        deploy/scripts/publish.sh "$@"
      else
        "$kit_dir/bin/catalyst-deploy" publish "$@"
      fi
    ) > "$scratch/publish-$scenario/$side/output" 2>&1 || status=$?
    {
      echo "exit $status"
      echo "output:"
      # Temp paths and abbreviated hashes differ per side by construction.
      sed -e "s#$scratch/publish-$scenario/$side#<fixture>#g" \
        -e 's#/[^ ]*/release-manifest\.json#<temp>/release-manifest.json#g' \
        "$scratch/publish-$scenario/$side/output"
      echo "gh calls:"
      sed -e 's#/[^ ]*/release-manifest\.json#<temp>/release-manifest.json#g' \
        "$scratch/publish-$scenario/$side/gh.log"
      echo "tags on origin (name, commit, message):"
      git -C "$scratch/publish-$scenario/$side/origin.git" for-each-ref refs/tags \
        --format='%(refname:short) %(*objectname) %(contents:subject)'
      echo "main on origin: $(git -C "$scratch/publish-$scenario/$side/origin.git" rev-parse main)"
    } > "$scratch/publish-$scenario/$side/result"
  done
  compare "$label" "$scratch/publish-$scenario/old/result" "$scratch/publish-$scenario/new/result"
}

mkdir "$scratch/publish-gh"
both_publish "staging: tags main" ":" staging --skip-local-checks --tag staging-2026.10.06-1
both_publish "staging: next date-based tag" ":" staging --skip-local-checks
both_publish "staging: unpushed commit on main is pushed first" \
  'git commit -q --allow-empty -m ahead' staging --skip-local-checks --tag staging-2026.10.06-1
both_publish "staging: refuses a dirty tree" 'echo dirty > untracked-file' \
  staging --skip-local-checks
both_publish "staging: refuses another branch" 'git switch -q -c feature' staging --skip-local-checks
both_publish "staging: refuses main behind origin" \
  'git commit -q --allow-empty -m ahead && git push -q origin main && git reset -q --hard HEAD~1' \
  staging --skip-local-checks
both_publish "staging: refuses an existing tag" 'git tag staging-2026.10.06-1' \
  staging --skip-local-checks --tag staging-2026.10.06-1
both_publish "staging: refuses a v tag" ":" staging --skip-local-checks --tag v2026.10.06-1
both_publish "staging: refuses --release" ":" staging --skip-local-checks --release staging-1

staging_release='git tag -a staging-2026.10.06-1 -m staging && git push -q origin staging-2026.10.06-1'
later_commit='git commit -q --allow-empty -m later && git push -q origin main'
write_manifest "$scratch/publish-gh/release-manifest.json" staging-2026.10.06-1 "$commit"
jq -n '[{ id: 7, ref: "staging-2026.10.06-1" }]' > "$scratch/publish-gh/deployments.json"

printf '[{ "state": "failure" }]\n' > "$scratch/publish-gh/statuses.json"
both_publish "production: refuses a release whose staging deployment failed" "$staging_release" \
  production --tag v2026.10.06-1
printf '[]\n' > "$scratch/publish-gh/deployments.json"
both_publish "production: refuses a release that staging never deployed" "$staging_release" \
  production --tag v2026.10.06-1
jq -n '[{ id: 7, ref: "staging-2026.10.06-1" }]' > "$scratch/publish-gh/deployments.json"
printf '[{ "state": "success" }]\n' > "$scratch/publish-gh/statuses.json"
both_publish "production: promotes the staging release of origin/main" "$staging_release" \
  production --tag v2026.10.06-1
both_publish "production: --release promotes an earlier staging release, --watch" \
  "$staging_release && $later_commit" \
  production --watch --release staging-2026.10.06-1
both_publish "production: refuses when origin/main has no staging release" \
  "$staging_release && $later_commit" production
both_publish "production: refuses a release that is no staging tag" "$staging_release" \
  production --release v2026.10.01-1
both_publish "production: refuses an unknown staging release" ":" \
  production --release staging-unknown
write_manifest "$scratch/publish-gh/release-manifest.json" staging-2026.10.06-1 "$(printf '%040d' 9)"
both_publish "production: refuses a manifest built from another commit" "$staging_release" \
  production --tag v2026.10.06-1
rm "$scratch/publish-gh/release-manifest.json"
both_publish "production: refuses a release without manifest" "$staging_release" \
  production --tag v2026.10.06-1

printf '\n%s difference(s)\n' "$differences"
[[ "$differences" -eq 0 ]]
