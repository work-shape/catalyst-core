#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
CLIENT_DIR="$(dirname "$SCRIPT_DIR")"

if [ -d /opt/homebrew/bin ]; then
  PATH="/opt/homebrew/bin:$PATH"
fi
if [ -d /usr/local/bin ]; then
  PATH="/usr/local/bin:$PATH"
fi
export PATH

cd "$CLIENT_DIR"
sh scripts/ensure-document-converter.sh
export PATH="$CLIENT_DIR/.venv/bin:$PATH"

exec pnpm exec tsx watch --conditions=development --clear-screen=false --include ../../packages --include tools --include agents --include config --include ../../.env --include .env src/server.ts
