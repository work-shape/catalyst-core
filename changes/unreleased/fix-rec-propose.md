---
section: Fixed
---

- Records proposals run no schema or role DDL. Customer stores install the content hash column and persistent app-privilege projection frame in their existing publish/provision schema step, under the per-store transaction lock. Owned-store release 12 installs the frame through the existing scheduled upgrade path; release 11 supplies the column. Existing customer stores require a publish, even with unchanged migrations. Until then proposals refuse: `Data Store '<name>' needs its upgrade for records.propose. Upgrade or publish the store again.` / `Der Data Store '<name>' benötigt sein Upgrade für records.propose. Aktualisieren oder veröffentlichen Sie den Store erneut.` Rollback leaves the additive column and frame in place; older binaries still execute proposal-time DDL.
- Owned schema creation and grants share the store setup lock. Gapped owned releases show as provisioning in the Data Store list. Proposals whose source and destination share an owned database reuse their transaction connection.
- Records proposals use search's source-visibility decision and record a per-item failure for withdrawn, unavailable, or narrowed documents, including while cleanup is pending. Other items continue.
- Publishing refuses `extraction.budget.maxTokensPerDocument` below the shared 512-token extraction reserve, naming the field, supplied value, and minimum: `extraction.budget.maxTokensPerDocument: <value> is below the extraction minimum 512.` / `extraction.budget.maxTokensPerDocument: <value> ist kleiner als das Minimum 512 für die Extraktion.`
