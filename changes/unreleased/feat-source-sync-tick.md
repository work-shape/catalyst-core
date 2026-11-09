---
section: Added
---

- A synced source of a Knowledge Base keeps itself current: the knowledge worker asks it for its changes every `knowledge.sourcePollMinutes` (per connector type, 15 by default) and runs its full pass at the new `schedule.full` of the source (a cron expression in the instance's time zone, `0 2 * * *` unless set). After downtime one full pass runs, not one per missed night. A source without a change feed is listed only at its full pass. A source whose first import has not finished, or whose sync waits for a confirmation, is left as it is. A poll that finds nothing writes no audit event, so it starts no Workflow on `knowledge_base.sync_finished`.
