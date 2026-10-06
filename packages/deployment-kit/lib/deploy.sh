#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  catalyst-deploy deploy --host HOST --manifest FILE

Deploys the images of one release by digest. Fetch the manifest of a release with
catalyst-deploy manifest fetch TAG FILE.

The host is reached as the SSH user "deploy". The instance in deploy/deployment.env
decides the rest: the app lives in /opt/vivd-catalyst/INSTANCE, its env file is
/etc/vivd-catalyst/INSTANCE/app.env, and EXECUTION_WORKSPACES=1 also pulls and
starts the workspace worker and runner.

Options:
  --host HOST       VPS hostname or IP address.
  --manifest FILE   Release manifest to deploy.
USAGE
}

host=""
manifest=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      host="${2:-}"
      shift 2
      ;;
    --manifest)
      manifest="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$host" || -z "$manifest" ]]; then
  usage >&2
  exit 2
fi

kit_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deployment-env.sh
source "$kit_dir/lib/deployment-env.sh"
load_deployment_env
app_root="$DEPLOYMENT_ROOT"
remote_app_dir="$REMOTE_APP_DIR"
remote_env_file="$REMOTE_ENV_FILE"
ssh_target="deploy@${host}"

bash "$kit_dir/lib/release-manifest.sh" check "$manifest"
image_tag="$(jq -r '.release' "$manifest")"
image_repository="$IMAGE_REPOSITORY"

# Compose builds every image reference as REPOSITORY-SUFFIX:TAG@DIGEST. Take the
# digest of each image from the manifest and refuse a manifest whose image names
# do not follow that scheme.
image_digest() {
  local key="$1" suffix="$2" reference
  reference="$(jq -r --arg key "$key" '.images[$key]' "$manifest")"
  if [[ "${reference%@*}" != "$image_repository-$suffix" ]]; then
    echo "Unexpected image name for $key in $manifest: $reference" >&2
    exit 1
  fi
  printf '%s\n' "${reference##*@}"
}
api_image_digest="$(image_digest api api)"
ui_image_digest="$(image_digest ui ui)"
doc_worker_image_digest="$(image_digest doc-worker doc-worker)"
workspace_command_worker_image_digest="$(image_digest workspace-command-worker workspace-command-worker)"
artifact_preview_worker_image_digest="$(image_digest artifact-preview-worker artifact-preview-worker)"
runner_image_digest="$(image_digest runner catalyst-runner-base)"

# The files under host/ are templates. The host gets them with the instance
# filled in, so the backup scripts and units work there without arguments.
host_files="$(mktemp -d)"
trap 'rm -rf "$host_files"' EXIT
mkdir -m 0755 "$host_files/systemd"
instance_title="$(printf '%s' "$INSTANCE" | awk '{ print toupper(substr($0, 1, 1)) substr($0, 2) }')"
render_host_file() {
  sed -e "s/@INSTANCE@/$INSTANCE/g" -e "s/@INSTANCE_TITLE@/$instance_title/g" \
    "$kit_dir/host/$1" > "$host_files/$2"
  chmod "$3" "$host_files/$2"
}
render_host_file backup-postgres.sh backup-postgres.sh 0755
render_host_file restore-postgres.sh restore-postgres.sh 0755
for unit in service timer; do
  render_host_file "systemd/backup.$unit" "systemd/vivd-catalyst-$INSTANCE-backup.$unit" 0644
done

echo "Deploying $image_tag to $host"

ssh "$ssh_target" "mkdir -p '$remote_app_dir/deploy/scripts' '$remote_app_dir/deploy/systemd'"

rsync -az "$app_root/docker-compose.prod.yml" "$ssh_target:$remote_app_dir/"
rsync -az "$app_root/deploy/Caddyfile" "$ssh_target:$remote_app_dir/deploy/"
rsync -az \
  "$host_files/backup-postgres.sh" \
  "$host_files/restore-postgres.sh" \
  "$ssh_target:$remote_app_dir/"
rsync -az "$host_files/systemd/" "$ssh_target:$remote_app_dir/deploy/systemd/"

# The remote script is passed as an argument, never on stdin: with "bash -s" any
# command that reads stdin (docker compose exec does) swallows the rest of the
# script and the deploy ends early with exit code 0.
remote_script=""
IFS= read -r -d '' remote_script < "$kit_dir/lib/deploy-remote.sh" || true

# shellcheck disable=SC2029
ssh "$ssh_target" \
  "REMOTE_APP_DIR=$(printf '%q' "$remote_app_dir") \
REMOTE_ENV_FILE=$(printf '%q' "$remote_env_file") \
IMAGE_REPOSITORY=$(printf '%q' "$image_repository") \
IMAGE_TAG=$(printf '%q' "$image_tag") \
API_IMAGE_DIGEST=$(printf '%q' "$api_image_digest") \
UI_IMAGE_DIGEST=$(printf '%q' "$ui_image_digest") \
DOC_WORKER_IMAGE_DIGEST=$(printf '%q' "$doc_worker_image_digest") \
WORKSPACE_COMMAND_WORKER_IMAGE_DIGEST=$(printf '%q' "$workspace_command_worker_image_digest") \
ARTIFACT_PREVIEW_WORKER_IMAGE_DIGEST=$(printf '%q' "$artifact_preview_worker_image_digest") \
RUNNER_IMAGE_DIGEST=$(printf '%q' "$runner_image_digest") \
EXECUTION_WORKSPACES=$(printf '%q' "$EXECUTION_WORKSPACES") \
bash -c $(printf '%q' "$remote_script")" \
  < /dev/null
