---
section: Changed
---

- **A Workflow's page says whom it runs as (WF-RUNAS-1):** the first line under its head reads
  "Runs as <account>" ("Läuft als <account>"), by the label of the service principal every run
  acts as, never by the definition's name for it. `workflows.list` names that label in the new
  optional field `runsAs` of each Workflow; it is missing where the principal is disabled or gone,
  which the Workflow's `reasons` already say. The list reads each principal once for both.
- **An unpublished draft names its account too:** `assets.get` returns the active configured
  account's label in optional `runsAs`, only after the asset read is authorized. The header
  uses it when the Workflow has no published entry. Disabled or missing accounts have no label.
