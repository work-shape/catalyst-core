---
section: Fixed
---

- **Knowledge Bases:** Deleting a large Knowledge Base finishes. The purge goes in pages of 100 documents, each committed on its own, so an attempt that fails keeps what it deleted and the next attempt continues where it stopped. A missing object counts as deleted, and an object that cannot be deleted keeps only the rows that lead to it while the rest is purged. Such a deletion ends failed with `knowledge_purge_incomplete` on the store and in the audit event, and its job can be retried; the store is dropped only after its objects are gone. Removed copies no longer leave a Managed File row with their file name and checksum behind.
