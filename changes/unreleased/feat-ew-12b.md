---
section: Added
---

- Workflow result datasets can be downloaded as streamed JSON Lines or CSV by the run starter or a holder of `workflow.read_run_data`. Downloads and loads audit ids, counts and sizes without rows.
- Data Store queries with a Workflow `dataset` destination read the full cursor into dataset parts. Ordinary queries retain their inline result caps. `dataStores.queryTimeoutMs` sets the whole-cursor deadline (10 minutes by default).
- Data Store loads use the instance's authorized dataset reader and record one result per step run in the platform-owned `catalyst.loads` table, atomically with their rows. Existing stores create this additive internal table at first load; no platform migration or rollback data movement is required. Store migrations still refuse the reserved `catalyst` schema.
- Operators may set `dataStores.load.rows`, `.bytes` and `.timeoutMs` (defaults 100,000 rows, 64 MiB and 10 minutes). A call beyond the row or byte ceiling is refused with `load_too_large`; produce smaller datasets for separate calls or raise the operator ceiling. Rolling back removes these settings from release config first; the internal table may remain.
