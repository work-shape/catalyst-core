# @work-shape/catalyst-data-stores

Data Stores of Workshape Catalyst: the module `dataStores`, switched with `modules.dataStores.enabled`. The names and shapes other packages read are in `@work-shape/catalyst-core` (`src/data-stores.ts`); the design is in `docs/planning/specs/data-stores-and-knowledge-bases.md`.

A Data Store is an asset of kind `data_store`: a folder with `store.yaml` (`id`, `name`, `description`, `scope`, `sizeLimit`; an unknown key is refused) and SQL files under `migrations/`, with a draft and a published revision. Publishing a revision creates the store's own Postgres database on the platform's server, or applies the migrations that database lacks.

## What a store is in Postgres

- One database per store, named from the instance and the asset id. The platform's role owns it.
- Two login roles per store. The **app role** reads and writes rows of the tables in `public` and owns nothing: it cannot create, alter or drop. The **migration role** creates and changes objects in `public` and applies the migration files.
- Statement timeout and connection limit are set on each role in Postgres (app role 15 seconds and 10 connections, migration role 10 minutes and 2), so they hold when the platform's own checks fail. With them go `work_mem` (16 MB, a default the role may raise for its session) and, where the platform's role is a superuser, `temp_file_limit` (1 GiB, which the role cannot raise). Where it is not, the store's record carries the condition `temp_files_unbounded`.
- `PUBLIC` loses every privilege on the store's database and on its schema `public`, and `CONNECT` on the platform's database. A store role therefore reaches its own database and nothing else the platform owns.
- The platform's own record of the store (`data_stores`) says which migrations are applied. Each migration also writes a row into the store's database (`catalyst.migrations`), in its own transaction, signed with a key only the platform holds; the migration role may add rows and neither read nor change them. Before a migration runs, the signed rows have to bear out the platform's record. Where the key cannot be read (`ledger_key_lost`) or the rows fall short of the record (`ledger_mismatch`), nothing is run. A key is made only for a store that has applied nothing.
- A migration runs as one statement of a block, so Postgres itself refuses whatever would end or split its transaction: nothing of a migration stays unless all of it does. Text that holds transaction control or a role statement is refused when it is written; a word in a quoted value is no statement, the body of a function or of a `do` block is. Before a migration is kept, the size of the store's database is read on a connection of the platform's own: a migration that would leave the store over its size limit is rolled back and refused (`data_store_size_limit`).
- A role may change its own password and settings, in a migration as in a trigger that fires on an insert; Postgres gives no way to forbid that. Before every job and every call that connects as a role of a store, the platform asks Postgres with one statement what both roles carry and compares it, text against text, with what it would write: settings and connection limit always, the password where the platform's role is a superuser and is shown it. Nothing is worked out from what a role wrote. What differs is set again in one transaction. Any other platform role learns of a changed password when Postgres refuses the platform's connection (`28P01`); it then sets both roles again and runs the call once more. An error a statement raises is never taken for that. **A window stays and cannot be closed:** between the look and the connection, and for as long as a session lasts, a role is what it last made of itself, because a role can always change its own password. So **the Postgres port of the server must not be reachable by tenants.** The look costs one read on the platform's own database per call, about a millisecond.
- Where the platform's role is a superuser, no role of a store lists sessions, reads another session's statement or ends one in the store's database: the functions that read the sessions of the server (`pg_stat_get_activity`, every `pg_stat_get_backend_...`), `pg_terminate_backend`, `pg_cancel_backend` and the views over them are taken from `PUBLIC` there. Where it is not, a query of a store can see sessions and end another query of the same store, since both run as the app role; the store's record then carries the condition `sessions_open`.
- The platform changes no grant of another database of the server, which others may share. So a store role can connect to every database of the server that lets `PUBLIC` in, `postgres` and `template1` among them, where it reads the catalog and nothing of the platform or of a store. Closing that is an operator's step, which every job of the store looks for and reports: while a store role may connect to any database but its own, the store's record carries the condition `server_databases_open`, and loses it at the next job once that is closed. Either `REVOKE CONNECT ON DATABASE ... FROM PUBLIC` for each such database on a server that is the instance's alone, or this line in `pg_hba.conf` above the lines that let the platform in, which Postgres shows to no role and the condition therefore cannot see: `host all /^catalyst_ds_ all reject` below a line that admits each store role to its own database, or `host postgres,template1 /^catalyst_ds_ all reject` for those two alone.

All roles, the database and its grants are created in one function, `provisionDataStore` (`src/provisioning.ts`).

## What the platform's database role needs

`CREATEDB` and `CREATEROLE`, and ownership of the platform's database (to take `CONNECT` on it from `PUBLIC`). On an instance that exists, an operator runs once, as a superuser:

```sql
ALTER ROLE <platform role> CREATEDB CREATEROLE;
```

For pgvector, which a store of a Knowledge Base with semantic search needs (`ensureVectorExtension`), the server needs the extension and the platform's role has to be a superuser: on the instance's own Postgres image (`docker/postgres/`) `vector` is not a trusted extension, so only a superuser creates it. The platform creates it in that store's database alone, in the schema `public`, and owns it; the roles of the store use its types and operators and cannot create, change or drop it. A store role holds no `CREATE` on its database, and where `vector` is trusted on a server the platform takes it from both roles again when it creates the extension. Without pgvector on the server the call stops with `vector_extension_missing`, and with a platform role that may not create it with `vector_extension_not_permitted`.

An instance whose `secretStore.keys` is empty does not start with the module on: the passwords of the store roles are kept in the Secret Store.

## Assumptions of this data flow

**Authorization.** Every call of a store's rows is an operation: `query`, `describe` and `preview_rows` of `data_store.<id>.<verb>` need `data_store.read` on the store, and `insert` needs `data_store.insert`, the right on rows, which `data_store.write` does not give. `load` needs `data_store.insert` too, and `data_store.execute` as well where it changes or removes rows that are stored (`onConflict: update`, `replace`); the refusal names the right that lacks. The routes `data_stores.<verb>` of the HTTP API name the store in their path and run as that same operation, so a call has one name in its policy, its run and its audit trail whoever makes it. A key needs the scope the contract names per verb (`data_store_rows:read`, `data_store_rows:write`, and `config_assets:read` for `describe`). Writing the definition needs `data_store.write`, publishing it `data_store.publish`, deleting it `data_store.delete`. The right is checked by the call path before the policy. Behind it the database decides: a query runs as the app role in a read-only transaction, an insert as the app role, a migration as the migration role. The screening of a query's text is a courtesy beside that boundary.

**A step of a Workflow Run.** A step calls `data_store.<id>.query` and `data_store.<id>.insert` through `runOperation()` as the service principal its Workflow names under `runAs`, from the origin `workflow`, with the id of its step run as idempotency key. The rights are that principal's alone, granted on the store: what the person who started the run or published the Workflow holds is not asked. `query`, `describe` and `preview_rows` are `reading` and recorded on every call; `insert` and `load` are `changing`. No verb names a policy of its own: what a changing call waits for is the instance's to say (`policy.defaults.changing`, `confirm` where it says nothing), for every caller. A step of a run of a published Workflow revision runs a `confirm`: publishing the Workflow was the confirmation, and the call's Operation Run records the decision reason `workflow_publish`. No call of a service principal can be held for an approval yet, so under `approval`, under a floor of the operation and behind a guardrail that asks for an approval the `insert` and `load` of a step are refused as `POLICY_DENIED` with `details.reason: approval_unavailable` (and `details.guardrailId` where a guardrail asked); under `deny` they are refused. A step of a test run of a draft acts as its tester (ADR-0031) and is unchanged. Granting a right on a store to a service principal through the access administration follows with that slice; until then the grant row is written by an operator.

**A call that is tried again.** Everything `insert` and `load` do to a store is one transaction. A call that fails before that transaction is being kept has left nothing, and says so (`AppError.changedNothing`): the call path then runs the same call again under its idempotency key, as it does for a call that failed before its implementation started. So a step that is tried again after a refusal for size, a constraint, a timeout of a statement or a store that was not ready adds its rows once the cause is gone. A call that completed is answered again from its run and adds nothing twice. Only a failure while the transaction was being kept, of a call without a key, is not run again: whether its rows are stored is not known.

**A call that carries an idempotency key.** The rows of a call are kept in the store's database and its Operation Run in the platform's, so the two cannot be kept together: a process that dies between them leaves rows whose call has no outcome. So every changing call that carries a key (`insert`, `load`, with `replace.by` or without) records the key in the store's own database, in the transaction of its rows: one row of `catalyst.calls` with a SHA-256 over the caller and the key, the name of the operation, a SHA-256 of the input and what the call answered, which is counts and never a row. A second call under the same key with the same input changes nothing and is answered what the first was answered, also where the store has since become full. The same key with another input or another operation is refused as `CONFLICT` with the reason `data_store_key_reused`. Two calls under one key at the same moment take the key in turn (an advisory transaction lock), so one of them writes and both are answered the same. The operations therefore declare `repeatsUnderKey`: after a dead worker the Workflow engine makes a step's call again under the key of its step run, and with a key every failure of a call may be run again. A call without a key, such as an agent's or one over HTTP that sends none, records nothing and is never made again by itself, as before.

The table is the platform's, in the schema `catalyst`, which no migration may name; a store's own tables stay the customer's. The app role holds nothing on the table: it reads the record of one key and adds one through two functions of the platform's (`catalyst.recorded_call`, `catalyst.record_call`), so a statement of a query or of an `sql` action of an App reads no record it does not hold the key hash of, and a query, which is read-only, adds none. The store's own code runs as that role too: a trigger of the store can add a record through that function and so have a later call under that key answered without rows, in its own store and nowhere else. The key itself is not kept, so whoever may read the rows of a store learns no key and no caller from the records. A store that was provisioned before the table existed gets it at its next job or at its first call with a key. A record is kept for 30 days (`DATA_STORE_CALL_RECORD_RETENTION_DAYS`), as long as the data of a step is meant to be kept, and removed by the daily job that measures the stores; the engine has no job yet that removes step data, which is why the store's own daily job does it. A call whose record is gone is answered by its Operation Run while that is there.

**An App.** An App reaches a store through its `sql` named actions, which run as the store's app role. Publishing checks the publisher's `data_store.read` for reading actions and `data_store.insert` for changing actions. Everyone who may use the published App can read or add what those actions select or insert, without a store right of their own. A draft uses its caller's store rights. Live Connection actions still use the viewer's rights.

**Credentials.** The password of each store role is random, made at provisioning, and kept encrypted in the Secret Store, bound to the store's asset and the role. Postgres is sent its SCRAM verifier, never the password. A password is read only when a connection to the store opens. No error, log line, job row or audit row holds one.

**Audit.** A changing call leaves one Operation Run and its audit rows; so does every query (`recordsEveryCall`), because it reads a customer's data. Run and audit rows carry the store's name and id, the table and counts. They never carry a row value, SQL text or a parameter. Provisioning, a migration and a failed migration are audit events with the store, the level and, for a failure, the SQLSTATE.

**Retention.** Rows live as long as the store's database. Deleting the store's asset retires the store: its operations are gone, its database, roles and rows stay, and its id is not free for another store. Nothing in this package drops a database. The platform's backup must include the store databases; until it does, a restore of the platform database alone brings back records of stores whose rows are gone.

**Region.** A store lives on the Postgres server of the instance, so its rows are where the platform's own rows are and no provider is involved. The recorded location (`host`, `port`, `database`) is where a later slice points a store at another server; this slice writes the platform's own server there and reads the address from the record on every call.

**Size.** A store is measured when it is provisioned, after every migration, kept or not, and once a day, for what is shown of it. An insert does not go by that. The size of the store's database is read on a connection of the platform's own, which nothing the store runs can touch, before the rows are written and again once they are, after everything the store left to the end of the transaction has happened. An insert that took the store past its limit is rolled back. So no row that is kept lies beyond the limit, whatever a default or a trigger wrote beside the rows. The two reads cost about half a millisecond each for a store of some hundred files and some milliseconds for one of thousands.

What a refused insert wrote is no row, and still fills the files. The platform gives it back at once, with a `VACUUM` of the store's database as its own role, and does the same after an insert that the database ended for its time. Postgres returns to the disk what lies at the end of a table; the rest is free for later rows. A store that is within one insert of its limit therefore stays refused until rows are removed or the limit is raised: it is full.

Postgres has no limit on what one statement writes. What bounds a runaway statement, such as a trigger that writes without end, is the statement timeout of the app role times the rate the disk takes: at most 10 statements at once, 15 seconds each. Until the vacuum after it has run, the files can be larger than the limit by that much, and the store takes no insert. Temporary files are bounded by `temp_file_limit` where the platform's role is a superuser. For rows alone, without such a trigger, the files pass the limit by less than 256 MiB.

**Shared server.** Stores share CPU, memory, disk and connection slots with the platform database. The limits on the roles, the bounded pool per store (`dataStores.poolMaxConnections` of release config, 5 by default), the caps on every result and the size limit are the protection; each limit is a named constant at the top of the module that enforces it.

## The state of a store

`data_store.<id>.state`, which the route `data_stores.get` (`GET /api/v1/data-stores/:store`) runs as, answers in one read what a screen shows of a store: `status`, the migration `level` and the `publishedLevel`, the size of the last measurement against the limit with `nearLimit` from 80 percent, each condition the server leaves open with a sentence that says what an operator does about it, and `lastMigration`: `applied`, `pending`, `failed` with the migration and the code and sentence of its failure, or `none`. It needs `data_store.read` on the store and the scope `config_assets:read`. It reads the platform's record and the published definition and no database of a store, so it answers while a store is being provisioned and while its database is away; it reads no row, so a call that completes leaves no run. The size is the one of the last measurement (`measuredAt`), not of this moment: an insert goes by the size it reads itself.

## The reads of a store's page

Four reads serve the screen that lists the stores and the page of one. Each store read is the store's own operation `data_store.<id>.<part>`, which the route of its name runs as, and none is a verb of the contract: no agent and no Workflow step is offered one.

- **`data_stores.list`** (`GET /api/v1/data-stores`): the published stores the caller holds `data_store.read` on, each with its status and level and what its last measurement found: `sizeBytes`, `tableCount` and `rowEstimate`, with `measuredAt`. The measurement runs when a store is provisioned, after every migration and once a day, and reads the two numbers from the catalog as the platform's role; `rowEstimate` is the planner's estimate over all tables, not a count, and a table the database has not analyzed counts as empty. Each is absent until a measurement read it. The list asks no database of a store.
- **`data_stores.rows`** (`GET /api/v1/data-stores/:store/rows`, `data_store.<id>.rows`): one page of one table, at most 50 rows (`DATA_STORE_ROWS_PAGE_MAX`), in the order of the table's primary key, by keyset: `after` takes `next` of the page before, and no page costs more for being far into the table. A table without a key that holds for all its rows is paged in the order its rows lie in, and `order.by` says `physical`: by the part of the table a row is in and its place there (`tableoid`, `ctid`), since a place alone repeats across the partitions of a partitioned table and the children of an inherited one. That is every table without a primary key, and a table other tables inherit from, whose key does not hold for the rows of its children. While nothing changes every row comes once, at any page size; a change of a row or a rewrite of the table moves rows, so a page may then show one twice or miss one. Each such page sorts the table by place, so it costs a pass over the table; a table that is read often wants a primary key. A value longer than 1,000 characters as text (`DATA_STORE_ROW_VALUE_MAX_CHARS`) is cut there and its column named in `cut` of its row. The cut is made in the database, on the rows of the page alone: a text is read up to one character past the cut, which reads the beginning of a long value and not the rest; a value of another type has to be read whole to become text, so one stored above 64 kB (`DATA_STORE_ROW_VALUE_READ_MAX_BYTES`) is not read at all and is answered as an empty text, named in `cut`. A page therefore never reads a long value, whatever the rows hold. `preview_rows` is unchanged and cuts nothing, which is why this is a sibling of it and no extension.
- **`data_stores.value`** (`GET /api/v1/data-stores/:store/value`, `data_store.<id>.value`): one value of one row whole, by `at` of the row. A row that is gone answers `row_gone`, a value past the byte ceiling of a read `value_too_large`.
- **`data_stores.used_by`** (`GET /api/v1/data-stores/:store/used-by`, `data_store.<id>.used_by`): the published Apps whose `sql` actions name the store and the published Workflows whose operation steps, also inside a loop, call one of its operations or whose agent steps may call one as a tool (`tools`), each with id, name and title. The steps are walked by the definition's own walker (`workflowStepsDeep` of core): the steps of a `loop`, both sides of a `condition` and every branch of a `parallel`. An App or a Workflow is named to whoever holds its read or its use right, as its own list shows it; of the others `hidden` holds a count and nothing else. It is read from the published definitions at each call, two reads of the platform's database for up to 1,000 Apps and 1,000 Workflows (`DATA_STORE_USED_BY_MAX_ASSETS`), and keeps no table of its own.

`rows` and `value` need `data_store.read` and the scope `data_store_rows:read`, run as the app role in a read-only transaction under the row, byte and time ceilings of every read, and are recorded on every call like every read of a customer's rows. `list` and `used_by` read no row, need `config_assets:read`, and leave no run.

## Release config

`dataStores.sizeLimit` (default `5GB`) is the most one store may hold; a store's `sizeLimit` names less and never more. `dataStores.poolMaxConnections` (default 5, at most 10) is the most connections one process holds to one store.

## The schema `catalyst`

The platform keeps what it records in a store's database in the schema `catalyst` (`DATA_STORE_RESERVED_SCHEMA`). A migration that names that schema is refused when it is written. `describe` and `preview_rows` read the schema `public` only.

## Adding the same rows twice

`insert` takes `onConflict`. With `skip` a row that a unique constraint of the table refuses is left out and counted in `skipped`, so a rerun of a run, and the next run over the same rows, add only what is new. The rule is one. `skip` goes by a unique key that holds for all rows, is not deferrable, and whose columns every row of the call gives; a column the database computes from given columns counts as given, a column an index only carries (`INCLUDE`) is no key. A call that gives the columns of no such key is refused (`skip_without_key`): a key left to its default may be another one every time, an index over a part of the rows binds no row for certain, and a table without a unique key skips nothing. A table with a deferrable unique constraint is refused (`skip_deferrable_key`), because Postgres skips on none. Then the database works each key out for each row: a row whose key is empty in every such index, also where an expression makes it so, is refused (`nullable_key`), unless the index is `NULLS NOT DISTINCT`. That is the one way this package has for it. A repeated call with the same idempotency key is answered by the call path with the first answer, as for every changing operation.

## Loading a dataset

`load` takes the rows of a dataset of a Workflow Run into one table in one transaction as the app role. A reader of the table sees the rows as they were until the load is kept and all of it from then on, also where the load replaces rows; a load that fails or is refused keeps none of its rows.

- **Bound of one call:** at most 100,000 rows (`DATA_STORE_LOAD_MAX_ROWS`) and 64 MiB of rows as JSON (`DATA_STORE_LOAD_MAX_BYTES`). What the reference of the dataset says is refused before a row is read; what the dataset holds is counted as it is read, and a load that passes the bound is rolled back (`load_too_large`). A larger dataset is loaded in several calls. One load, including lock waits, is bounded by `limits.timeoutMs` (`dataStores.load.timeoutMs`, default 600 s); its statements of at most 1,000 rows use that timeout instead of the app role’s ordinary statement timeout.
- **Columns:** `columns` names the column for each field of a row; other fields are left out, and a field a row lacks is empty in that row. Without it every row names the same fields, each the name of a column (`rows_differ`). An unknown table or column is refused by name (`table_unknown`, `column_unknown`, `column_twice`).
- **Key:** `key` names the columns that tell two rows apart. It needs a unique constraint over exactly those columns that holds for all rows and is not deferrable (`key_without_constraint`), and every row gives every column of it (`key_not_loaded`, `nullable_key` unless the constraint is `NULLS NOT DISTINCT`). A dataset holds each key once, in whichever part of it the second row comes (`duplicate_key`): the database itself compares the keys.
- **`onConflict`:** `fail` adds no row where a unique constraint refuses one. `skip` leaves out a row whose key is stored. `update` writes the columns the load sets over the row whose key is stored and leaves its other columns. Loads that encounter a row deadlock with a concurrent write roll back and answer `load_concurrent_rows`: safe to retry, including through the existing Workflow step retry.
- **`replace.by`:** deletes the stored rows whose values of these columns occur in the dataset, then adds the dataset, in that one transaction. With `by: [month]` a monthly run replaces its month and leaves every other month. Two loads that replace the same value at once do not mix: a load holds an advisory lock in the store's database for each value of `by` until it is kept or rolled back, so the later one waits, deletes what the earlier stored and reports it in `deleted`. Unscoped replacements of the same table take turns before taking any group locks; scoped replacements of disjoint values run concurrently and those of the same value wait on their group. Waiting counts against `limits.timeoutMs` (`dataStores.load.timeoutMs`, default 600 s). A table-lock wait that reaches that limit refuses the whole load as `load_replace_timeout`, names the limit, and can safely be retried.
- **Empty reruns:** name an explicit group with `replace: { by: [client_id, month, rules_revision], values: { client_id: "1001", month: "2026-09", rules_revision: "r2" } }`. `values` gives exactly the `by` columns as non-null scalars. An empty dataset clears only that group; other clients, months and revisions stay. Every incoming row, after column mappings and conversion to the table's types, must match the group (`replace_scope_mismatch`); a mismatch rolls back the whole load. Without `values`, only groups present in the dataset are replaced, so an empty dataset deletes nothing. Explicit and dataset-derived loads of the same group share their lock and once-per-step transaction.
- **Size and roles:** as for an insert. The size of the store's database is read on the platform's own connection before the first row, after every statement and once more after everything the store left to the end of the transaction has happened; a load that takes the store past its limit is rolled back (`data_store_size_limit`) and what it wrote is given back with a `VACUUM`, as after any load that failed. The roles are held before the call as before every call.
- **Once per step run:** the call path answers a repeated call of one idempotency key with the first answer, and a Workflow step sends the id of its step run as that key.

The rows come from a dataset reader that the slice bringing the datasets of Workflow Runs gives to `createDataStores` (`datasets`). Until an assembly gives one, `load` is refused as `not_supported_yet`, and rows are added with `insert`.

## What stays open by the nature of Postgres

- A role changes its own password and its own settings; nothing forbids it. The platform sets both again before it connects as the role, and a platform role that is no superuser cannot see that a password was changed until Postgres refuses it. Whoever reaches the Postgres port in between can log in with what the role set. Postgres itself works out a verifier a role sets, with as many rounds as the verifier names, so a role can keep one process of the server busy for as long as its statement runs.
- What a migration leaves in the database stays for the ones after it: a change of the migration role's default privileges, and a `SECURITY DEFINER` function, which runs as the migration role for whoever may call it. Both are the author's to review; neither reaches beyond the store's own database.
- A role may end sessions of its own role, and all queries of a store run as its app role. Where the platform's role is no superuser, a query of a store can therefore see the sessions of the server in `pg_stat_activity`, with the statements of its own role's sessions, and end one of its store.
- Without a `pg_hba.conf` line or a revoke as above, a store role connects to every database of the server that lets `PUBLIC` in.
- An advisory lock is the database's own, and each store has a database of its own: a store that takes such locks and keeps them hinders its own calls and nobody else's.
- Nothing limits what one statement writes to the disk but its time.

Workflow dataset consumers: `data_store.<id>.load` reads only datasets the calling run may read (or, for a direct caller, datasets covered by `workflow.read_run_data`). It records the first result per step run in `catalyst.loads` in the same transaction as the table rows. A retry returns that result even under another attempt key. The internal table is added to existing stores on first load; store migrations cannot name `catalyst`.

`dataStores.load.rows`, `dataStores.load.bytes` and `dataStores.load.timeoutMs` set the operator ceilings for one atomic load (100,000 rows, 64 MiB and 10 minutes by default). Raise them when the instance can handle a larger call, or produce smaller datasets upstream for separate loads. A load takes the store's size limit before and after its writes. A Workflow query with `dataset: { at: rows }` reads its complete result through a cursor; other callers keep the inline query caps. `dataStores.queryTimeoutMs` bounds the complete streamed read (10 minutes by default).

Result downloads use `GET /api/v1/workflow-runs/<run>/datasets/<dataset>?format=jsonl|csv`. Only result datasets are exposed, to the run starter or a holder of `workflow.read_run_data`. JSON Lines preserves arbitrary object rows; CSV quotes every cell and JSON-encodes nested values. Dataset storage, retention and region are unchanged.

### Records contract (REC-0)

`store.yaml` may hold a `records` array. Each entry names a `table`, a `key` with
`column` and either `fromPath` (one `{column}` capture) or `fromField`, evidence
`precedence` (strongest first), `review.always`, and `retainWithoutSource` (false
by default). Publish table/key migrations and records rules together. Each migration
preserves the records keys that held before the batch and any already-valid keys
of rules published during it. The last migration checks every latest published rule.
These checks run inside the migration's transaction after its SQL and deferred
triggers have run. The key must have a valid, immediate, non-partial unique
index over that column alone. Included columns do not count as key columns. A
migration that breaks a rule rolls back, including its ledger entry, and fails with
`record_key_invalid`, naming `records.<table>.key.<column>`. Correct the pending
migration and republish. A publish without pending migrations checks the catalog
immediately and refuses an invalid rule.

Replace a records key's unique index or constraint inside **one migration**. Dropping
it in `0002` and adding its replacement in `0003` is refused at `0002`, even if the
final schema would be valid. Drop the old constraint and add the new unique key for
the same column in one SQL file so uniqueness holds when that migration commits.

Publish and migration share the store's row lock through the schema transaction's
commit and level update. Rules added while DDL is queued are checked against the
resulting schema; a publish racing running DDL waits for that store's migration.

The frozen `DATA_STORE_RECORD_OPERATIONS` inventory in core describes
`data_store.<id>.records.propose`, `.decide` and `.flagged`, all under the dedicated
`data_store.records` right. REC-1a registers `records.propose`; `decide` and `flagged`
remain contracts for REC-1b/REC-2. The proposal writer uses `propose.itemSchemaFor(catalogColumns)` on each
whole item before any write; its column parameter type is exported as `RecordColumn`.
A proposal accepts at most 1,000 items per call and 1,000 fields per item; send larger
work as further batches. `flagged` accepts at most 10,000 items per page; pass its
`nextCursor` as `cursor` to continue. These bounds do not limit stored capacity.
Unknown, duplicate, generated or incompatible fields
fail that item with `record_field_unknown`. Extraction's value/page/quote shape is
KBW-0's, reused directly. Evidence checks are necessary conditions, never confidence
scores. Cite both Knowledge Base ID and document ID, and require Knowledge Base
access before displaying a citation.

Provisioning creates `catalyst.record_fields` as platform-owned SQL, inaccessible
to the app and migration roles. Its unique document identity includes both IDs;
SQL NULL keys represent documents awaiting assignment. Values and quotes are
customer data under the spec's "Synced sources and records" retention table.
REC-1a adds the proposal writer. Pinned decisions and purge/recompute belong to REC-1b.
The frozen `DataStoreRecordWithdrawalOutbox` port is bound to the Knowledge Base's
withdrawal transaction. Its relay must queue `dataStoreRecordWithdrawalJob` after
commit, retaining the outbox row until acknowledgement. It must not directly enqueue
a separately committed platform job before the withdrawal commits. Delivery and
idempotent recomputation belong to REC-1b and work with every Workflow disabled.

### Records merge and projection (REC-1a)

`records.propose` validates each whole item against the published table and keeps its
Knowledge Base/document/content hash, page, quote, evidence result and date. Missing keys
remain SQL NULL for assignment. Eligible fields merge by evidence precedence and then the
document's date; an equal-rank/date disagreement clears the projected field and marks it
`conflict`. Failed evidence and `review.always` fields are withheld. Existing confirmed and
corrected candidates are preserved. A corrected candidate keeps what its document reads in
`value` and the person's value in `corrected_value` (REC-KEEP); it wins, and is compared with
other pinned candidates, by the person's value. Withdrawal changes belong to REC-1b.

The customer row uses the same SQL builder as `load`, with one key and `onConflict: update`.
The provenance and the customer row commit together. The app role's privileges, table and
deferred constraints, store size limit and operator `dataStores.load` ceilings still apply.
A temporary app-owned SECURITY DEFINER wrapper prevents a customer trigger from resetting
the platform connection's role; it is removed before commit. No grants or wrapper survive.
`catalyst.loads` keeps the projection counts and batch result per Workflow step so retries
replay without reading source documents or projecting again. Values and quotes are absent
from errors, logs and audit.

Owned-store migration 8 creates the provenance table if a pre-REC-0 store lacks it, then adds the nullable `content_sha256` column with `ADD COLUMN IF NOT
EXISTS`. Customer stores receive the same additive setup on their first proposal. The
`recordFailures.write` port stores retry items in a dataset; the standard assembly uses the
calling Workflow step's dataset owner. Proposals run only as a Workflow Run step and are
not offered as agent tools. Direct chat, App and CLI calls fail before store work with
`workflow_dataset_owner_required`: "`records.propose` runs only as a step of a Workflow Run."
The refusal follows the caller's EN/DE locale. The store's existing Filled by section
receives the published Workflow and the readable Knowledge Bases its operation steps name.

### Extraction by schema (PROC-2)

`knowledge.<id>.extract_fields({ documentId, schema })` reads an active indexed document
under `knowledge_base.read`. Use it in a data Workflow before `records.propose`; it returns
`path`, the document's own `date` (or null), its classified `type`, and `fields` keyed by
name with `{ value, page, quote }`. `droppedFields` counts unsupported schema fields.
`failedFields` counts evidence failures, which stay in the returned fields so
`records.propose` can recheck and retain them for review as “Nicht belegt”, without
projecting their values. Quotes and page text are normalized for Unicode NFC, whitespace,
soft hyphens and words split across lines. Numeric evidence uses the call's document locale
(`de` by default); the other separator convention is accepted only when unambiguous.
String evidence matches whole words; German dates accept single-digit days and months.
Evidence is checked again by records at its write boundary. A matching quote is a necessary condition, not proof of correctness.

The document-processing capability supplies its explicitly approved extraction binding.
That binding must support structured output and document input and process in `eu` (or
inside the instance). Its customer rate card supplies the currency. Page text is untrusted
data inside fixed instructions; calls carry a JSON-schema answer format, abort and deadline.
No prompt, page text, field value or quote is kept in logs, errors, audit or Operation Runs.
Only the owning Knowledge Base's retained text and the caller's returned result contain them.

`extraction.budget.perMonth` optionally limits this Knowledge Base's field extraction in
the instance usage currency. Publishing a monthly budget requires the extraction binding
to have a customer rate-card row; an unpriced binding does not prevent startup. `maxTokensPerDocument` defaults to 8000 and covers conservative
input tokens plus the maximum output. Input tokens are estimated as ceil(UTF-8 bytes / 4) over the serialized input and schema unless the binding supplies a tokenizer. A document is never silently truncated. Admission
reserves the maximum call cost in one monthly row before contacting the model; settlement
returns unused money, including when a provider returns invalid output or reports zero cost.
A content change before the provider call releases the full reservation. Only a call whose
cost is unknown (including a timeout or process crash) conservatively keeps its reservation. This can pause earlier than the provider's final invoice. A new
UTC month has its own counter. Raising and publishing the budget permits the next Workflow
call to continue; the Workflow controls retries and scheduling. A refusal marks the document
“Fields pending” / “Felder ausstehend”; it remains indexed and searchable. No per-document
or per-customer total count limit is added.

Owned-store migration 10 adds the monthly counter and the document's pending marker;
9 is reserved by SRC-3b. There is no core database migration. Old application versions may
run on the additive tables; keep the new migration recorded on rollback. Admission costs one
monthly-row lock plus an indexed document update; no list or sum grows with the corpus.

Field evidence in extraction and records proposals uses the instance `localization.defaultLocale`, never the caller’s interface language. Knowledge Base content/indexing languages are not supported in this release.
