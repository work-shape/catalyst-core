---
section: Changed
---

- **Checks:** Fail ordinary Vitest runs above 20 seconds per file or 5 seconds per test, and browser runs above 60 seconds of reported work per spec. Measured existing exceptions require a reason in `scripts/test-duration-budget.allowlist.json`; scale tests are exempt. The release policy also caps planned browser shards at ten minutes.
