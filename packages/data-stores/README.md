# @vivd-catalyst/data-stores

Data Stores of Workshape Catalyst: the module `dataStores`, switched with `modules.dataStores.enabled`. The names and shapes other packages read are in `@vivd-catalyst/core` (`src/data-stores.ts`); the design is in `docs/planning/specs/data-stores-and-knowledge-bases.md`.

A Data Store is an asset of kind `data_store`: a folder with `store.yaml` (`id`, `name`, `description`, `scope`, `sizeLimit`; an unknown key is refused) and SQL files under `migrations/`, with a draft and a published revision. Publishing a revision creates the store's own Postgres database on the platform's server, or applies the migrations that database lacks.

## What a store is in Postgres

- One database per store, named from the instance and the asset id. The platform's role owns it.
- Two login roles per store. The **app role** reads and writes rows of the tables in `public` and owns nothing: it cannot create, alter or drop. The **migration role** creates and changes objects in `public` and applies the migration files.
- Statement timeout and connection limit are set on each role in Postgres (app role 15 seconds and 10 connections, migration role 10 minutes and 2), so they hold when the platform's own checks fail.
- `PUBLIC` loses every privilege on the store's database and on its schema `public`, and `CONNECT` on the platform's database. A store role therefore reaches its own database and nothing else the platform owns.
- The platform's own record of the store (`data_stores`) says which migrations are applied. Each migration also writes a row into the store's database (`catalyst.migrations`), in its own transaction, signed with a key only the platform holds; the migration role may add rows and neither read nor change them. Before a migration runs, the signed rows have to bear out the platform's record. Where the key cannot be read (`ledger_key_lost`) or the rows fall short of the record (`ledger_mismatch`), nothing is run. A key is made only for a store that has applied nothing.
- A migration runs as one statement of a block, so Postgres itself refuses whatever would end or split its transaction: nothing of a migration stays unless all of it does. Text that holds transaction control or a role statement is refused when it is written.
- A role may change its own password and settings; Postgres gives no way to forbid that. A migration that changed the settings of a role is rolled back and refused. A changed password cannot be seen, so after every migration both roles get their password, connection limit and settings again.
- Where the platform's role is a superuser, no role of a store lists sessions or ends one in the store's database (`pg_stat_activity`, `pg_terminate_backend`, `pg_cancel_backend`). Where it is not, a query of a store can still end another query of the same store, since both run as the app role.
- The platform changes no grant of another database of the server, which others may share. So a store role can connect to `postgres` and `template1`, where it reads the catalog and nothing of the platform or of a store. An operator who wants that closed adds this line to `pg_hba.conf`, above the lines that let the platform in: `host postgres,template1 /^catalyst_ds_ all reject`.

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

**Size.** A store is measured when it is provisioned, after every migration and once a day, for what is shown of it. An insert does not go by that: it reads the size of the store's database in its own transaction, as the app role, and adds nothing at the limit. So a store passes its limit by at most what the inserts that run at one moment add: the app role has 10 connections and a call carries at most 1 MiB of rows, which with their indexes stays under 256 MiB. The cost is one statement per insert that sums the files of the database.

**Shared server.** Stores share CPU, memory, disk and connection slots with the platform database. The limits on the roles, the bounded pool per store (`dataStores.poolMaxConnections` of release config, 5 by default), the caps on every result and the size limit are the protection; each limit is a named constant at the top of the module that enforces it.

## Release config

`dataStores.sizeLimit` (default `5GB`) is the most one store may hold; a store's `sizeLimit` names less and never more. `dataStores.poolMaxConnections` (default 5, at most 10) is the most connections one process holds to one store.

## The schema `catalyst`

The platform keeps what it records in a store's database in the schema `catalyst` (`DATA_STORE_RESERVED_SCHEMA`). A migration that names that schema is refused when it is written. `describe` and `preview_rows` read the schema `public` only.

## Adding the same rows twice

`insert` takes `onConflict`. With `skip` a row that a unique constraint of the table refuses is left out and counted in `skipped`, so a rerun of a run, and the next run over the same rows, add only what is new. A row is met again only where one unique index has all its columns set in it by the call: an empty column never conflicts unless the index is `NULLS NOT DISTINCT`, and a column the call leaves to its default, such as a key the database numbers, may differ every time. A row no unique index binds in that way is refused (`nullable_key`), also where the index is over an expression. A table without a unique index is not refused. That is the one way this package has for it. A repeated call with the same idempotency key is answered by the call path with the first answer, as for every changing operation.

## What stays open by the nature of Postgres

- A role changes its own password and its own settings; nothing forbids it. The platform refuses a migration that changed settings and sets the password again after every migration, and cannot see that a password was changed.
- What a migration leaves in the database stays for the ones after it: a change of the migration role's default privileges, and a `SECURITY DEFINER` function, which runs as the migration role for whoever may call it. Both are the author's to review; neither reaches beyond the store's own database.
- A role may end sessions of its own role, and all queries of a store run as its app role. Where the platform's role is no superuser, a query of a store can therefore see the sessions of that store in `pg_stat_activity` and end one. It sees the rows of other roles' sessions too, without their statements.
- Without the `pg_hba.conf` line above, a store role connects to `postgres` and `template1`.
