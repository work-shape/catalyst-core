#!/bin/sh
set -eu

MARKITDOWN_VERSION="${MARKITDOWN_VERSION:-0.1.6}"
VENV_DIR="${DOCUMENT_CONVERTER_VENV:-.venv}"

has_document_dependencies() {
  python_bin="$1"
  "$python_bin" - <<'PY'
import importlib.util
import sys

def module_exists(module):
    try:
        return importlib.util.find_spec(module) is not None
    except ModuleNotFoundError:
        return False

missing = [
    module
    for module in ("lxml", "mammoth", "pdfminer.high_level", "pdfplumber", "pypdf")
    if not module_exists(module)
]
sys.exit(1 if missing else 0)
PY
}

if command -v markitdown >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1 && command -v pdfinfo >/dev/null 2>&1 && command -v pdftoppm >/dev/null 2>&1 && has_document_dependencies python3; then
  exit 0
fi

if [ -x "$VENV_DIR/bin/markitdown" ] && has_document_dependencies "$VENV_DIR/bin/python"; then
  exit 0
fi

if ! command -v pdfinfo >/dev/null 2>&1 || ! command -v pdftoppm >/dev/null 2>&1; then
  echo "Document uploads require Poppler tools 'pdfinfo' and 'pdftoppm' on PATH." >&2
  exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "Document uploads require MarkItDown plus Python PDF dependencies. Install them on PATH, or install 'uv' so the demo can create $VENV_DIR." >&2
  exit 1
fi

echo "Installing MarkItDown $MARKITDOWN_VERSION with PDF and DOCX support into $VENV_DIR for local document uploads..."
if [ ! -x "$VENV_DIR/bin/python" ]; then
  uv venv "$VENV_DIR" >/dev/null
fi
uv pip install --python "$VENV_DIR/bin/python" "markitdown[pdf,docx]==$MARKITDOWN_VERSION" pdfplumber pypdf
