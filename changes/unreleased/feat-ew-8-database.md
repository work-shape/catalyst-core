---
section: Database
---

- Migration `0124_scheduled_agent_starts` adds saved scheduled prompts and their run history, plus the default-false `model_usage_events.unattended` flag that retains owner attribution while applying unattended safeguards. Apply it before app and worker startup; a database behind refuses startup with the missing migration name. The previous release can run with these additive tables and column. Roll back application code without dropping the tables; dropping them deletes saved schedules and their history.
