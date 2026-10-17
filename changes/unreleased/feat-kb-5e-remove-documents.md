---
section: Added
---

- **Knowledge Bases:** Withdraw removed documents immediately and purge their unshared chunks, vectors, extraction results and owned files with a retryable job. Deleting a Knowledge Base cleans its files before dropping its store. Removal requires `knowledge_base.write`; deletion counts are audited without document text or file names.
