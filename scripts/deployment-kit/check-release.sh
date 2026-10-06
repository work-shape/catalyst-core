#!/usr/bin/env bash
# Moved to packages/deployment-kit. This path stays for callers that pin an older layout.
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../packages/deployment-kit/lib" && pwd)/check-release.sh" "$@"
