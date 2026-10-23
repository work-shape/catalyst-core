---
section: Changed
---

- The landing tooling is gone: affected-test selection (`pnpm check:affected`), duration sharding and its measured durations, the hosted path selection, the image retry wrapper, and the baseline and check-limit guards. The hosted Check runs every job on each release run and shards the browser suite with Playwright's `--shard`; `pnpm test:agent-stories` no longer needs the workspace browser lane helper.
- A quality baseline count is now a ceiling: a count above its entry fails, a count below it passes, so a repair needs no baseline edit.
