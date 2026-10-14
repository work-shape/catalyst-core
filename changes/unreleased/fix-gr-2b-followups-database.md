---
section: Database
---

- **`0080_guardrail_hits_converted_from`:** adds the nullable column `converted_from` to
  `guardrail_hits`, without a default and without a scan. A release before this one writes no
  value and reads none, so a rollback of the app keeps working on the migrated database.
