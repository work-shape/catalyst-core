---
section: Database
---

- **Workflows:** Migration `0081_test_run_targets` adds `workflow_step_runs.target` and
  `workflow_step_runs.published_would_ask`, both nullable and checked. It gives
  `live_once_switches` the owner in its key (`asset_id`, `part`, `switched_by_id`), and adds the
  table `live_once_runs`, which records the step of a test run a switch made live and is removed with the run. Rollback: a
  release without 0081 ignores the new columns and the new table. Released versions up to v0.6.4
  have no "Run live once" at all. A build between 0073 and 0081 sets a switch with a conflict on
  (`asset_id`, `part`), which no longer has a unique key, so its "Run live once" fails. Before
  going back to such a build, delete the rows of `live_once_switches` and restore the old key:
  `ALTER TABLE live_once_switches DROP CONSTRAINT live_once_switches_owner_pk, ADD CONSTRAINT
  live_once_switches_pk PRIMARY KEY (asset_id, part)`.
