---
section: Fixed
---

- **Knowledge Bases:** The documents page no longer offers Remove for a document synced from a source, because source withdrawal removes it and the instance refuses a manual remove. Where a remove is still refused with `knowledge_synced_document_remove_refused`, the page says why in the reader's language instead of the instance's English sentence. `knowledge_bases.list_documents` names the source of a synced document in `sourceId`.

- **Tests:** The large-source sync test imports 1,250 items instead of 10,000. That still crosses 13 listing pages and 13 fetch batches, and the test no longer runs at its drain limit.
