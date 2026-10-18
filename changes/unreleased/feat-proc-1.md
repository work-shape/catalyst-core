---
section: Added
---

- **Document processing:** Knowledge Bases classify documents with `documentTypes` rules on path, name and MIME type, defaulting unmatched documents to `default`. Built-in `text` and `tables` processors share the frozen output validator and the instance page limit. Each type selects page, heading, sheet-row, section or whole-document chunking. JSON Schema files in CLI definitions are resolved locally and stored in the revision; fields outside the schema fail with `knowledge_processor_output_invalid`. Custom processors and `documentTypes[].workflow` are refused with guidance to use data Workflows; OCR remains unavailable until KB-9.

- **Document processing:** Owned-store migration **7, `document_processors`**, adds nullable type, processor `id@version` and processing fingerprint columns. No platform database migration. It runs through the existing owned-store upgrade path. Deploy core before the paired capabilities processor change. Rollback leaves additive columns in place; older workers can still read extraction pages but do not enforce typed processing, so drain older workers before confirming a processing change.

- **Document processing:** Publishing a changed type or processor revision first refuses with `knowledge_processing_confirmation_required`, stating the affected content count, local processing cost and estimated re-embedding cost. Review the statement and retry `assets.publish` with its `confirmProcessing` token, or `catalyst knowledge-base publish NAME --revision N --confirm TOKEN`. A stale token refuses the publish. After confirmation a durable job reprocesses only affected contents; released source originals are fetched again only when the processor changes. These reviews walk metadata in pages of 100 and cost O(contents + existing passage tokens), without loading document text.

- **Documentation:** Package guidance is in `packages/data-stores/knowledge-processors.md`.
