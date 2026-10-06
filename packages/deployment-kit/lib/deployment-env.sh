#!/usr/bin/env bash
# shellcheck disable=SC2034  # the variables are read by the scripts that source this file
# Sourced by the kit commands. Finds the deployment checkout and reads its one
# input file, deploy/deployment.env. Everything else is derived from INSTANCE.

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "deployment-env.sh is sourced by the kit commands, not executed." >&2
  exit 1
fi

deployment_env_fail() {
  echo "catalyst-deploy: $*" >&2
  exit 1
}

# DEPLOYMENT_ROOT wins; otherwise the nearest directory at or above the current
# one that holds deploy/deployment.env.
find_deployment_root() {
  local directory
  if [[ -n "${DEPLOYMENT_ROOT:-}" ]]; then
    [[ -d "$DEPLOYMENT_ROOT" ]] \
      || deployment_env_fail "deployment root does not exist: $DEPLOYMENT_ROOT"
    (cd "$DEPLOYMENT_ROOT" && pwd)
    return
  fi
  directory="$PWD"
  while [[ ! -f "$directory/deploy/deployment.env" ]]; do
    [[ "$directory" != "/" ]] \
      || deployment_env_fail "no deploy/deployment.env here or above; run this from the deployment repo"
    directory="$(dirname "$directory")"
  done
  printf '%s\n' "$directory"
}

load_deployment_env() {
  local file line key value
  DEPLOYMENT_ROOT="$(find_deployment_root)"
  file="$DEPLOYMENT_ROOT/deploy/deployment.env"
  [[ -f "$file" ]] || deployment_env_fail "missing $file"

  INSTANCE=""
  IMAGE_REPOSITORY=""
  APP_PACKAGE=""
  EXECUTION_WORKSPACES=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && continue
    [[ "$line" =~ ^([A-Z_]+)=(.*)$ ]] \
      || deployment_env_fail "$file: expected KEY=value, got: $line"
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    case "$key" in
      INSTANCE) INSTANCE="$value" ;;
      IMAGE_REPOSITORY) IMAGE_REPOSITORY="$value" ;;
      APP_PACKAGE) APP_PACKAGE="$value" ;;
      EXECUTION_WORKSPACES) EXECUTION_WORKSPACES="$value" ;;
      *) deployment_env_fail "$file: unknown key $key" ;;
    esac
  done < "$file"

  [[ "$INSTANCE" =~ ^[a-z][a-z0-9-]*$ ]] \
    || deployment_env_fail "$file: INSTANCE must be lowercase letters, digits and dashes"
  [[ "$IMAGE_REPOSITORY" =~ ^[a-z0-9][a-z0-9./_-]*$ ]] \
    || deployment_env_fail "$file: IMAGE_REPOSITORY must be an image name without tag"
  [[ "$APP_PACKAGE" =~ ^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$ ]] \
    || deployment_env_fail "$file: APP_PACKAGE must be an npm package name"
  [[ "$EXECUTION_WORKSPACES" =~ ^[01]$ ]] \
    || deployment_env_fail "$file: EXECUTION_WORKSPACES must be 0 or 1"

  REMOTE_APP_DIR="/opt/vivd-catalyst/$INSTANCE"
  REMOTE_ENV_FILE="/etc/vivd-catalyst/$INSTANCE/app.env"
}

# The stitched workspace is the parent directory; image builds and the lockfile
# address the deployment as deployment.<instance> inside it.
require_workspace_layout() {
  [[ "$(basename "$DEPLOYMENT_ROOT")" == "deployment.$INSTANCE" ]] \
    || deployment_env_fail "the deployment checkout must be named deployment.$INSTANCE: $DEPLOYMENT_ROOT"
  WORKSPACE_ROOT="$(cd "$DEPLOYMENT_ROOT/.." && pwd)"
}
