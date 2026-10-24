---
section: Added
---

- **Data Stores:** "Review" (German "Prüfen") on the page of a store with records rules lists the fields the documents do not settle on their own: where evidence disagrees, where no candidate's quote stands on its page, and where the rule asks a person to confirm. Each object shows its flagged fields, and each field its candidates side by side, each with a chip that opens the cited page. A person confirms a candidate, corrects it to the value the page holds, or assigns a document whose path names no object to one. A confirmed or corrected value stays through later syncs. Candidates are shown only from Knowledge Bases the reader may use.
- **Data Stores:** `data_store.<store>.records.flagged` and `.records.decide`, with `GET /api/v1/data-stores/:store/records/flagged` and `POST /api/v1/data-stores/:store/records/decide`. Both need `data_store.records` on the store; a decision that cites a document also needs `knowledge_base.use` on its Knowledge Base. The audit event `data_store.record_decided` names the table, field and action, never the value or key.
- **Data Stores:** A sync that leaves fields waiting files one Inbox notice per store for whoever may decide them, with the number of fields that wait when it is read. A store with a pending notice gets no second one.
- **CLI:** `catalyst data-store review list <store>` and `catalyst data-store review decide <store> --table --key --field --action confirm|correct|assign` do what the page does.
