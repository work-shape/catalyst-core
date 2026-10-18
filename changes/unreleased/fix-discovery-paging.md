---
section: Fixed
---

- **Discovery:** Discovery lists use cursor pages instead of limiting the number of published Workflows, App actions, or stores an instance can reach. Workflow schedule repair and store maintenance retain a continuation between bounded jobs. Studio choosers, the uploaded file picker, and Workflow run steps retain cursors so later items remain reachable.

- **API:** `workflows.list` and `apps.actions.list` accept `limit` and `cursor`; readers must follow `nextCursor`. The App actions `truncated` field remains for compatibility and reports whether another page follows. No database migration is needed. The CLI `app actions` follows every page. Store scans run as retryable page jobs, including their first page, and recover after an expired worker lease. New store tick/page kinds and the Workflow schedule-repair kind must drain before rollback; older workers cannot serve them. Legacy empty store ticks remain registered for rolling upgrades.

- **Extensions:** Custom `WorkflowDefinitionSource.list` readers must honor the supplied `StorePage` limit and exclusive Workflow-id cursor. Built-in asset and folder readers implement that contract.

- **Maintenance:** Call-ledger setup shares the existing database grant turn with store migration and provisioning, so concurrent maintenance cannot race on Postgres schema catalog grants.

- **Workflow runs:** The run page reads every step page automatically, drawing steps as pages arrive.
