---
section: Added
---

- **Test copy of a Data Store (DT-2):** A draft's call that changes a published store now runs against the store's test copy instead of a dry run. The copy is a scratch database on the same server, built from the draft's migrations (draft ones included) and its `seed/*.sql` files. It never holds a live row. The platform makes it at the draft's first changing call; draft reads go to it once it exists.
- The copy is brought to the draft at each call. A migration the draft adds is applied on top. A changed or removed migration, a changed seed file or a lost database rebuilds it. A failed build drops what it made and names the seed file and the number of the statement it stopped at, never its text.
- A call that needs the copy while it is being built, reset or deleted is refused with "try again in a moment" (`test_copy_busy`) instead of waiting, so parallel draft calls hold no platform connection. A call to the copy holds its Idempotency-Key apart from live calls: a live call under the same key runs live.
- Reset and delete it with `data_stores.test_copy_reset` and `data_stores.test_copy_delete`, with `catalyst data-store test-copy reset|delete <store>`, or on the Data Store page's new "Test copy" section, which shows its level, seed files and size. Both need `data_store.write`. Builds, failures and drops are audited without row values or SQL.
- The copy has its own size limit, `dataStores.testCopySizeLimit` of release config (default `500MB`), never above the store's. Retiring a store drops its copy. The deployment kit's Postgres backup leaves test copies out.
- **Database:** migration `0179_data_store_test_copies` adds the table `data_store_test_copies`, one row per copy, removed with its store.
