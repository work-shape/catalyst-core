---
section: Database
---

- **Usage:** Migration `0147_usage_spend_limits` adds `usage_spend_limits`: the spend limits an admin sets per UTC day and month for the instance, as a default for every shared workspace and every user, and for one workspace or one user. A value of a workspace or a user is removed with it. Admission keeps counters of shared workspaces in the existing `model_usage_counters` under the scope `workspace`.
