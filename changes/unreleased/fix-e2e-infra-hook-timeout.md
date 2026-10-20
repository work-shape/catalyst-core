---
section: Fixed
---

- The browser tests that start a second API (infrastructure, knowledge fields, knowledge upload, modules) give that setup two minutes instead of the default 30 seconds, so a busy suite no longer fails them while they wait for their turn.
- The browser test of a queued job whose module is off no longer fails when the jobs list is still loading as the page reloads.
