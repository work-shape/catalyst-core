---
section: Added
---

- **CLI:** Use commands on a key's use level: `catalyst workflow start <name>`, `catalyst data-store rows|query|insert <name>` and `catalyst knowledge-base query <name>`. Each calls the existing operation (`workflows.start`, `data_stores.rows`, `data_stores.query`, `data_stores.insert`, `knowledge_bases.query`) with the person's rights, and a key without the level is refused with the missing right named. See the CLI reference ("Workflows, checks and lists").
- **Personal API keys:** A key that names `data_store.insert`, `data_store.execute` or `knowledge_base.use` carries the new operation scope `data_store_rows:use`, which only those four row operations accept from a key through their `personalKeyScope`. A key still reaches no update, delete, preview, value or flagged-record operation, and a test run or agent run started with a key still cannot read rows. No existing key changes unless it already named one of those rights.
