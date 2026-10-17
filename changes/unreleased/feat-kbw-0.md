---
section: Added
---

- Freeze the Knowledge Base write contracts for data Workflows: ingestion and withdrawal, pending documents, processor write-back and field extraction; batch descriptors and per-item failure datasets; Workflow `process`/`data` kind (default `process`). These contracts add no executable operations. `fetch` is refused with `not_supported_yet` until CONN-DL. `records` in `kb.yaml` is refused with a pointer to `store.yaml`.
- Owned Knowledge Base stores advance to `catalyst_kb` migration 6 (`workflow_sources`), after SRC-3a's migration 5: connector cursors retain their data and gain a kind; Workflow sources reserve `workflow:<workflowId>`. No platform migration. Older releases can read the existing connector rows; they cannot operate Workflow-fed sources once those are introduced by KBW-1.
- Ingestion and materialized processor text reuse the existing 25 MiB per-document file limit; names, paths and origin links follow the connector bounds (1,000 characters for names, 4,000 for absolute paths and HTTP(S) links). Processor write-back takes page text only as a dataset reference, as pending does. Page count is enforced at runtime by `knowledge.maxPagesPerDocument` (KB-ISO-3a); the schema adds no fixed count. Omitted Workflow kind stays absent in the parsed manifest to preserve revision fingerprints; lists present it as `process`.
