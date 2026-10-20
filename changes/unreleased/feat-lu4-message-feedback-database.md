---
section: Database
---

- Add the table `feedback` (0136, additive). Apply the migration before startup; the previous release does not read the table, so a rollback keeps the comments and shows none of them until the release is back.
