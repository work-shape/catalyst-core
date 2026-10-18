---
section: Changed
---

- Check passes its build between jobs through a cache scoped to the run and commit, with a required exact cache hit that survives re-running failed jobs. Diagnostic artifact uploads no longer fail checks when artifact storage is unavailable; durations and screenshot evidence expire after three days, and failed-run traces after seven days. Shard balancing continues to use committed duration measurements.
