---
section: Changed
---

- **Knowledge Bases:** An `ingest` pass now asks its Workflow account for `knowledge_base.ingest`, not `knowledge_base.write`, before every page and before a complete pass withdraws. A Workflow account that holds `knowledge_base.write` from a grant written by hand, and no `knowledge_base.ingest`, is refused from the next page on; grant it `knowledge_base.ingest` on the Knowledge Base, or publish the Workflow again.
