---
section: Database
---

- **Workflows:** Migration `0140_workflow_run_started_from` adds the nullable column `workflow_runs.started_from` (jsonb): the App draft, action and Workflow revision that started a test run, by name. Apply it before starting the new API. It preserves compatibility with the previous release and moves no data. Rolling back the application leaves the column unread; remove it only through a later committed migration.
