---
section: Added
---

- SRC-3a: synced sources apply change feeds, reconcile complete listings and withdraw documents with the existing purge job. Large full-pass withdrawals wait for publisher confirmation in the Inbox. Publishing a narrowed or removed source immediately excludes its documents from search. Runs and change cursors are pinned to their source boundary, so delayed confirmations and old cursors cannot apply to a changed definition.

The Knowledge Base owned-store migration is 5 (`source_withdrawal`), following 4 (`source_counts`); no platform-database migration is needed. Existing synced items remain searchable while their parent metadata is unknown (`parents: []`); include and exclude rules still apply. A complete pass learns their folder membership before folder narrowing can withdraw them. Connector items require at least one parent, so the empty list is reserved for unknown ancestry. Apply the owned-store upgrade before serving this release. Rollback keeps the added columns and triggers; it cannot restore purged documents, which must be fetched again from the source. Changing the Connection of an existing source id is refused with `knowledge_source_connection_changed`; remove it and add a new source id for a different Connection.
