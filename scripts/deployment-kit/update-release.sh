#!/usr/bin/env bash
# Moved to packages/deployment-kit. This path stays for callers that pin an older layout.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../packages/deployment-kit/lib" && pwd)/update-release.sh" "$@"
