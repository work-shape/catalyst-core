---
section: Changed
---

- **Knowledge Bases:** Synced Knowledge Base documents release their original bytes once indexing succeeds or fails. Their Managed File records and extracted text remain; re-indexing uses that text without fetching the original. Files added by hand retain their own copy, including files with the same content hash. Released originals remain at the source. No migration is required. Rolling back does not restore released bytes; recovering them requires a source retry.

- Retrying shared content uses an available document copy even when an earlier synced original was released. If extraction has neither retained text nor an available original, indexing fails with `knowledge_file_missing`; delayed extraction jobs requeue indexing without overwriting retained results.
