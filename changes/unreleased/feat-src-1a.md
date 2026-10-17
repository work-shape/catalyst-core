---
section: Added
---

- **Knowledge Bases:** Synced Knowledge Base sources import initial and full listings in resumable pages and fetch batches of 100, with per-item retries, size checks and content deduplication. TXT and Markdown extraction results remain available for later reindexing. Source operations and publishing remain gated until SRC-1b.

- Fetch batches record terminal item failures and end a failed run after executor exhaustion. Listing resumes remember queued items, fetches claim individual items, and failed handoffs clean unadopted Managed Files. Cross-store writes use the owned-store-before-platform lock order.
- Removing a synced document locally is refused with `knowledge_synced_document_remove_refused`: "Synced documents cannot be removed locally. Remove them in the source or change the published source boundary." Fixture paths are relative to the boundary folder.
- Owned Knowledge Base migration 3 (`source_fetch_claims`) adds queue and claim markers. Apply through the existing owned-store upgrade job before serving source imports; rollback leaves these additive columns in place and must drain source jobs first. No platform migration.
