---
section: Changed
---

- **A Workflow's page says whom it runs as (WF-RUNAS-1):** the first line under its head reads
  "Runs as <account>" ("Läuft als <account>"), by the label of the service principal every run
  acts as, never by the definition's name for it. `workflows.list` names that label in the new
  optional field `runsAs` of each Workflow; it is missing where the principal is disabled or gone,
  which the Workflow's `reasons` already say. The list reads each principal once for both.
