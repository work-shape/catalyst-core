# @vivd-catalyst/data-stores

Data Stores of Workshape Catalyst: the module `dataStores`, switched with `modules.dataStores.enabled`. The names and shapes other packages read are in `@vivd-catalyst/core` (`src/data-stores.ts`); the design is in `docs/planning/specs/data-stores-and-knowledge-bases.md`.

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

An instance whose `secretStore.keys` is empty does not start with the module on: the passwords of the store roles are kept in the Secret Store.

## Assumptions of this data flow

**Authorization.** Every call of a store's rows is an operation: `query`, `describe` and `preview_rows` of `data_store.<id>.<verb>` need `data_store.read` on the store, and `insert` needs `data_store.insert`, the right on rows, which `data_store.write` does not give. `load` is reserved and refused as `not_supported_yet`. The routes `data_stores.<verb>` of the HTTP API name the store in their path and run as that same operation, so a call has one name in its policy, its run and its audit trail whoever makes it. A key needs the scope the contract names per verb (`data_store_rows:read`, `data_store_rows:write`, and `config_assets:read` for `describe`). Writing the definition needs `data_store.write`, publishing it `data_store.publish`, deleting it `data_store.delete`. The right is checked by the call path before the policy. Behind it the database decides: a query runs as the app role in a read-only transaction, an insert as the app role, a migration as the migration role. The screening of a query's text is a courtesy beside that boundary.

**Credentials.** The password of each store role is random, made at provisioning, and kept encrypted in the Secret Store, bound to the store's asset and the role. Postgres is sent its SCRAM verifier, never the password. A password is read only when a connection to the store opens. No error, log line, job row or audit row holds one.

**Audit.** A changing call leaves one Operation Run and its audit rows; so does every query (`recordsEveryCall`), because it reads a customer's data. Run and audit rows carry the store's name and id, the table and counts. They never carry a row value, SQL text or a parameter. Provisioning, a migration and a failed migration are audit events with the store, the level and, for a failure, the SQLSTATE.

**Retention.** Rows live as long as the store's database. Deleting the store's asset retires the store: its operations are gone, its database, roles and rows stay, and its id is not free for another store. Nothing in this package drops a database. The platform's backup must include the store databases; until it does, a restore of the platform database alone brings back records of stores whose rows are gone.

**Region.** A store lives on the Postgres server of the instance, so its rows are where the platform's own rows are and no provider is involved. The recorded location (`host`, `port`, `database`) is where a later slice points a store at another server; this slice writes the platform's own server there and reads the address from the record on every call.

**Size.** A store is measured when it is provisioned, after every migration, kept or not, and once a day, for what is shown of it. An insert does not go by that. The size of the store's database is read on a connection of the platform's own, which nothing the store runs can touch, before the rows are written and again once they are, after everything the store left to the end of the transaction has happened. An insert that took the store past its limit is rolled back. So no row that is kept lies beyond the limit, whatever a default or a trigger wrote beside the rows. The two reads cost about half a millisecond each for a store of some hundred files and some milliseconds for one of thousands.

What a refused insert wrote is no row, and still fills the files. The platform gives it back at once, with a `VACUUM` of the store's database as its own role, and does the same after an insert that the database ended for its time. Postgres returns to the disk what lies at the end of a table; the rest is free for later rows. A store that is within one insert of its limit therefore stays refused until rows are removed or the limit is raised: it is full.

Postgres has no limit on what one statement writes. What bounds a runaway statement, such as a trigger that writes without end, is the statement timeout of the app role times the rate the disk takes: at most 10 statements at once, 15 seconds each. Until the vacuum after it has run, the files can be larger than the limit by that much, and the store takes no insert. Temporary files are bounded by `temp_file_limit` where the platform's role is a superuser. For rows alone, without such a trigger, the files pass the limit by less than 256 MiB.

**Shared server.** Stores share CPU, memory, disk and connection slots with the platform database. The limits on the roles, the bounded pool per store (`dataStores.poolMaxConnections` of release config, 5 by default), the caps on every result and the size limit are the protection; each limit is a named constant at the top of the module that enforces it.

## Release config

`dataStores.sizeLimit` (default `5GB`) is the most one store may hold; a store's `sizeLimit` names less and never more. `dataStores.poolMaxConnections` (default 5, at most 10) is the most connections one process holds to one store.

## The schema `catalyst`

The platform keeps what it records in a store's database in the schema `catalyst` (`DATA_STORE_RESERVED_SCHEMA`). A migration that names that schema is refused when it is written. `describe` and `preview_rows` read the schema `public` only.

## Adding the same rows twice

`insert` takes `onConflict`. With `skip` a row that a unique constraint of the table refuses is left out and counted in `skipped`, so a rerun of a run, and the next run over the same rows, add only what is new. The rule is one. `skip` goes by a unique key that holds for all rows, is not deferrable, and whose columns every row of the call gives; a column the database computes from given columns counts as given, a column an index only carries (`INCLUDE`) is no key. A call that gives the columns of no such key is refused (`skip_without_key`): a key left to its default may be another one every time, an index over a part of the rows binds no row for certain, and a table without a unique key skips nothing. A table with a deferrable unique constraint is refused (`skip_deferrable_key`), because Postgres skips on none. Then the database works each key out for each row: a row whose key is empty in every such index, also where an expression makes it so, is refused (`nullable_key`), unless the index is `NULLS NOT DISTINCT`. That is the one way this package has for it. A repeated call with the same idempotency key is answered by the call path with the first answer, as for every changing operation.

## What stays open by the nature of Postgres

- A role changes its own password and its own settings; nothing forbids it. The platform sets both again before it connects as the role, and a platform role that is no superuser cannot see that a password was changed until Postgres refuses it. Whoever reaches the Postgres port in between can log in with what the role set. Postgres itself works out a verifier a role sets, with as many rounds as the verifier names, so a role can keep one process of the server busy for as long as its statement runs.
- What a migration leaves in the database stays for the ones after it: a change of the migration role's default privileges, and a `SECURITY DEFINER` function, which runs as the migration role for whoever may call it. Both are the author's to review; neither reaches beyond the store's own database.
- A role may end sessions of its own role, and all queries of a store run as its app role. Where the platform's role is no superuser, a query of a store can therefore see the sessions of the server in `pg_stat_activity`, with the statements of its own role's sessions, and end one of its store.
- Without a `pg_hba.conf` line or a revoke as above, a store role connects to every database of the server that lets `PUBLIC` in.
- An advisory lock is the database's own, and each store has a database of its own: a store that takes such locks and keeps them hinders its own calls and nobody else's.
- Nothing limits what one statement writes to the disk but its time.
