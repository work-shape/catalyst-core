---
section: Database
---

- Add the column `always_ask` (boolean, default false) to `shipped_guardrail_switches` (0184, additive). Apply the migration before startup. The previous release ignores the column and asks on every publish, so a rollback needs no step.
