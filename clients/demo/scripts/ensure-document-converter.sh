#!/bin/sh
set -eu

MARKITDOWN_VERSION="${MARKITDOWN_VERSION:-0.1.6}"
VENV_DIR="${DOCUMENT_CONVERTER_VENV:-.venv}"

if command -v markitdown >/dev/null 2>&1; then
  exit 0
fi

if [ -x "$VENV_DIR/bin/markitdown" ]; then
  exit 0
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "Document uploads require MarkItDown. Install 'markitdown' on PATH, or install 'uv' so the demo can create $VENV_DIR." >&2
  exit 1
fi

echo "Installing MarkItDown $MARKITDOWN_VERSION into $VENV_DIR for local document uploads..."
uv venv "$VENV_DIR" >/dev/null
uv pip install --python "$VENV_DIR/bin/python" "markitdown==$MARKITDOWN_VERSION"
