---
section: Database
---

- Migration `0126_operation_run_admitted` adds the nullable `operation_runs.admitted_at` and the concurrent partial index `operation_runs_admitted_idx`; a `mail.send` call holds its place in `outbound.limits` by it. Additive and repeatable after an interrupted build; apply it before startup. The previous release ignores the column, so a rollback sends without limits again.
