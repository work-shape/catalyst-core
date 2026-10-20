---
section: Database
---

- **Workflows:** Migration `0129_workflow_agent_usage` adds a concurrent partial index on model usage by instance and Agent Run, used by Workflow agent-step usage summaries. Apply it before starting the new API and workers. It preserves compatibility with the previous release and moves no data. Rolling back the application may leave the index in place; remove it only through a later committed migration.
