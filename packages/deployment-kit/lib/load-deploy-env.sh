#!/usr/bin/env bash

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "Source this file instead of executing it:" >&2
  echo "  source ${BASH_SOURCE[0]}" >&2
  exit 1
fi

deploy_env_file="${1:-../../.env.deploy}"

if [[ ! -f "$deploy_env_file" ]]; then
  echo "Missing deploy env file: $deploy_env_file" >&2
  return 1
fi

set -a
# shellcheck disable=SC1090
. "$deploy_env_file"
set +a

export HCLOUD_TOKEN="${HCLOUD_TOKEN:-${HETZNER_API_TOKEN:-}}"
export TF_VAR_cloudflare_zone_id="${TF_VAR_cloudflare_zone_id:-${CLOUDFLARE_ZONE_ID:-}}"
export TF_VAR_hetzner_object_storage_access_key="${TF_VAR_hetzner_object_storage_access_key:-${HETZNER_OBJECT_STORAGE_ACCESS_KEY:-}}"
export TF_VAR_hetzner_object_storage_secret_key="${TF_VAR_hetzner_object_storage_secret_key:-${HETZNER_OBJECT_STORAGE_SECRET_KEY:-}}"

if [[ -z "${HCLOUD_TOKEN:-}" ]]; then
  echo "HCLOUD_TOKEN is empty. Set HCLOUD_TOKEN or HETZNER_API_TOKEN." >&2
  return 1
fi
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "CLOUDFLARE_API_TOKEN is empty." >&2
  return 1
fi
if [[ -z "${TF_VAR_cloudflare_zone_id:-}" ]]; then
  echo "TF_VAR_cloudflare_zone_id is empty. Set CLOUDFLARE_ZONE_ID." >&2
  return 1
fi
if [[ -z "${TF_VAR_hetzner_object_storage_access_key:-}" ]]; then
  echo "TF_VAR_hetzner_object_storage_access_key is empty. Set HETZNER_OBJECT_STORAGE_ACCESS_KEY." >&2
  return 1
fi
if [[ -z "${TF_VAR_hetzner_object_storage_secret_key:-}" ]]; then
  echo "TF_VAR_hetzner_object_storage_secret_key is empty. Set HETZNER_OBJECT_STORAGE_SECRET_KEY." >&2
  return 1
fi
