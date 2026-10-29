---
section: Changed
---

- **Knowledge Bases:** an index job writes a document's passages in transactions of at most 500 passages and 30 seconds each, beside the passages search reads, and then switches to them in one short transaction. A search never waits long behind an index write, a document half written by a stopped worker stays invisible until its next attempt finishes it, and a re-index keeps answering with the old passages until the switch. A batch of vectors is bounded at 30 seconds instead of two minutes. The store of a Knowledge Base gets migration 17 (`chunk_switch_fetch_window`), which every store applies at its next start.
- **Knowledge Bases:** a Knowledge Base holds at most 2,000 fetched items, and at most 2 GiB, that are not yet indexed. A fetch batch that finds this window full waits 60 seconds without spending an attempt, so the object store and the spool stay bounded while indexing is paused or slower than fetching.
