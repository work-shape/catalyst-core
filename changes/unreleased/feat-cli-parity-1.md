---
section: Added
---

- Added `catalyst call <operation>` with file or stdin JSON input, JSON output and the existing API authorization and exit codes, plus write-only Connection secret entry and Connection test, discovery and tool-list commands.
- Fixed hidden secret prompts keeping the CLI process alive after Enter or Ctrl-C, reused the write's idempotency key for retries, and documented stdin for multi-line secrets.
