---
section: Database
---

- **Workflows:** migration 0209 `workflow_failure_notice_coalesce` adds the nullable column
  `workflow_failure_notices.notice_id`, a reference to `approval_requests` added `NOT VALID` and
  set to null when the notice is deleted, and the column `failures` (`integer`, default `0`). No
  row is rewritten and it gives up after a 5 s `lock_timeout`. Migration 0210
  `workflow_failure_notice_index` builds the index `workflow_failure_notices_notice_idx`
  concurrently. A rollback needs no step: an older release does not read the columns and sends
  one notice per failing run again.
