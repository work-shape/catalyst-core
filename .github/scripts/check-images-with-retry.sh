#!/usr/bin/env bash
# Retry only registry/network failures. A failed build or image contract stays red immediately.
set -euo pipefail
log=$(mktemp)
trap 'rm -f "$log"' EXIT
for round in 1 2 3; do
  if bash scripts/check-image-build.sh 2>&1 | tee "$log"; then
    exit 0
  else
    status=${PIPESTATUS[0]}
  fi
  if [[ $round -eq 3 ]] || ! grep -Eiq \
    'failed to resolve source metadata|failed to fetch (anonymous|oauth) token|toomanyrequests|registry[^[:space:]]*.*(timeout|temporarily unavailable)|unexpected status.*(429|500|502|503|504)|TLS handshake timeout|failed to do request.*(EOF|timeout|connection reset)' "$log"; then
    exit "$status"
  fi
  echo "Image registry request failed; retrying the image check (attempt $((round + 1))/3)."
  sleep $((round * 15))
done
