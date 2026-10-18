---
section: Fixed
---

- Serialize unscoped replacement loads on each Data Store table before taking group locks, so concurrent streamed loads with reversed groups across chunks both complete without a deadlock. Unscoped replacements of one table now take turns; scoped replacements of disjoint groups still run concurrently. Lock waits count against `limits.timeoutMs` (`dataStores.load.timeoutMs`, default 600 s).
- A table-lock timeout answers `load_replace_timeout`: "Another replacement of table '<table>' was running. Waiting reached limits.timeoutMs (<limit> ms, dataStores.load.timeoutMs). Safe to retry." A row deadlock answers `load_concurrent_rows`: "The load ran into a concurrent load of the same rows. Nothing was loaded; safe to retry." Both have English and German messages; rolled-back loads remain eligible for the existing Workflow step retry. No migration; rollback restores the earlier lock behavior and generic database errors.
