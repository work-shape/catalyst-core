---
section: Added
---

- Freeze Data Store records rules, evidence and operation contracts (`records.propose`, `records.decide`, `records.flagged`), the `data_store.records` right, and the transaction-bound withdrawal outbox port. These contracts register no callable records handlers yet; merge/projection, decisions, withdrawal delivery and review arrive in REC-1a/1b/2.
- Provision platform-owned `catalyst.record_fields` provenance SQL in each Data Store. Document identity includes both Knowledge Base and document IDs, including uniqueness. No core or Knowledge Base owned-store migration is added.
- Publish table/key migrations and records rules together. Every migration checks the latest published records keys inside its own transaction, after its SQL and deferred triggers, coordinated with concurrent publishes by the store lock. A broken key rolls back the migration with `record_key_invalid`, naming `records.<table>.key.<column>` and saying `Nothing of it was applied.` Rules published while migrations are queued are checked against the schema they actually meet. Without pending migrations, invalid keys still refuse publish immediately.
- Records calls accept at most 1,000 proposal items per batch, 1,000 fields per item, and 10,000 flagged fields per page. Split larger proposals into batches and follow `nextCursor` for further flagged pages; these bounds do not limit stored capacity. Export `RecordColumn` for `itemSchemaFor` consumers.
- Rollback: remove the records block before running a release whose strict manifest schema predates it; the unused provenance table can remain. A refused migration leaves its schema and signed ledger unchanged; correct the pending migration and republish.
