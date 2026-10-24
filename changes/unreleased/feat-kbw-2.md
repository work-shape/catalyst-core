---
section: Added
---

- **Knowledge Bases:** An `ingest` pass asks its Workflow account's grants afresh before every page and before a complete pass withdraws (KBW-2a). A pass whose account lost `knowledge_base.write` writes no further page and ends `failed` with `knowledge_source_refused`; what it wrote stays, and it withdraws nothing. A `fetch` item is checked against the account's `connection.use` on the page that reads it, so taking the right away mid-pass fails the remaining items of that Connection with `knowledge_fetch_not_allowed`.
