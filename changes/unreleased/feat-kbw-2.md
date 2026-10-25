---
section: Added
---

- **Knowledge Bases:** An `ingest` pass asks its Workflow account's grants afresh before every page and before a complete pass withdraws (KBW-2a). A pass whose account lost `knowledge_base.write` writes no further page and ends `failed` with `knowledge_source_refused`; what it wrote stays, and it withdraws nothing. A `fetch` item is checked against the account's `connection.use` on the page that reads it, so taking the right away mid-pass fails the remaining items of that Connection with `knowledge_fetch_not_allowed`.
- **Knowledge Bases:** A person who may change a Knowledge Base removes a Workflow-fed document by hand, with Remove on its page or `remove_documents` (KBW-2b). It leaves search at once, is purged as any removal is, and stays out: a later pass that names it reports `knowledge_item_removed` and leaves it out, and a complete pass does not count it as unnamed. Only someone who may publish the Knowledge Base lets it back in, with Allow again on the source or Retry on the source's items; the Workflow's own account cannot. `locate` shows when it was removed. The removal and the lifted hold are audited with the source and a count, never a name.
