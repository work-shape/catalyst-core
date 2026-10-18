---
section: Fixed
---

- Records proposals run no schema or role DDL. Customer stores install the content hash column and persistent app-privilege projection frame in their existing publish/provision schema step, under the per-store transaction lock. Owned-store release 12 installs the frame through the existing scheduled upgrade path; release 11 supplies the column. Existing customer stores require a publish, even with unchanged migrations. Until then proposals refuse: `Data Store '<name>' needs its upgrade for records.propose. Upgrade or publish the store again.` / `Der Data Store '<name>' benötigt sein Upgrade für records.propose. Aktualisieren oder veröffentlichen Sie den Store erneut.` Rollback leaves the additive column and frame in place; older binaries still execute proposal-time DDL.
- Owned schema creation and grants share the store setup lock. Gapped owned releases show as provisioning in the Data Store list. Proposals whose source and destination share an owned database reuse their transaction connection.
