---
section: Changed
---

- A Knowledge Base row in Build says how many documents were not ingested, as a warning ("9 not ingested"), where others were. It says "Ingestion failed" only where no document was ingested. The page of a Knowledge Base with more documents than it has read counts them too ("9 could not be read.").
- `knowledge_bases.list_documents` answers `summary.failed`, the number of retained documents that failed.
