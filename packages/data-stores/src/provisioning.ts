import { z } from "zod";
import type { DataStoreCondition, DataStoreRecord } from "@vivd-catalyst/core";
import type { DataStoreRole } from "./credentials";
import { ensureRole, platformIsSuperuser } from "./roles";
import { quoteIdentifier, type DataStoreServer } from "./server";

// The one place a store's database, its roles and their grants are made. Every statement is
// built from names this package derived, never from a caller's text.

/** How long making the roles, the database or its grants may take before the attempt fails. */
const DATA_STORE_PROVISION_STEP_TIMEOUT_MS = 120_000;

/**
 * In the database of one store: nobody but a superuser lists sessions or ends one. The
 * catalog of a database is its own, so no other database of the server changes.
 */
const HIDE_OTHER_SESSIONS = `
  revoke execute on function pg_catalog.pg_terminate_backend from public;
  revoke execute on function pg_catalog.pg_cancel_backend from public;
  revoke execute on function pg_catalog.pg_stat_get_activity from public;
  revoke select on pg_catalog.pg_stat_activity from public;
`;

/** Whether a role of the store may connect to the platform's database, and to the server's own two. */
const REACH = `
  select pg_catalog.has_database_privilege($1, $2, 'CONNECT') as platform,
    coalesce((
      select pg_catalog.bool_or(pg_catalog.has_database_privilege($1, d.oid, 'CONNECT'))
      from pg_catalog.pg_database d where d.datname in ('postgres', 'template1')
    ), false) as server
`;

const reachRow = z.object({ platform: z.boolean(), server: z.boolean() });

/** Why provisioning stopped at something an operator settles. The code is the failure of the store. */
export class DataStoreProvisioningError extends Error {
  readonly code: "platform_database_open";

  constructor(code: "platform_database_open", message: string) {
    super(message);
    this.name = "DataStoreProvisioningError";
    this.code = code;
  }
}

/**
 * Creates the database of a store with its two roles, or completes one an earlier attempt left
 * unfinished: every step finds what is there and adds what is missing. When it returns,
 *
 * - the app role and the migration role exist, log in with the given passwords, own nothing
 *   and carry their statement timeout and connection limit;
 * - the database exists, owned by the platform's role, and only those two roles and its owner
 *   connect to it;
 * - `PUBLIC` holds nothing on the database or its schema `public`, and no `CONNECT` on the
 *   platform's database;
 * - the migration role creates in `public`, and may add to `catalyst.migrations` and neither
 *   read nor change it; what it creates in `public` the app role reads and writes;
 * - where the platform's role is a superuser, no role of the store lists or ends a session.
 *
 * No grant of another database of the server is changed: the server may be shared. What it
 * leaves open for an operator to close is answered by name, for the store's record.
 */
export async function provisionDataStore(
  server: DataStoreServer,
  record: Pick<DataStoreRecord, "id" | "location" | "roles">,
  passwords: Record<DataStoreRole, string>,
  signal: AbortSignal
): Promise<DataStoreCondition[]> {
  const database = quoteIdentifier(record.location.database);
  const app = quoteIdentifier(record.roles.app);
  const migration = quoteIdentifier(record.roles.migration);
  const platformDatabase = quoteIdentifier(server.platformDatabase);
  const step = { timeoutMs: DATA_STORE_PROVISION_STEP_TIMEOUT_MS, signal };

  const reach = await server.executor.change(
    // `create database` runs in no transaction.
    { ...server.asPlatform(server.platformDatabase), ...step, transaction: false },
    async (sql) => {
      const [existing] = await sql.run("select 1 from pg_catalog.pg_database where datname = $1", [
        record.location.database
      ]);
      if (!existing) {
        await sql.script(`create database ${database} template template0 encoding 'UTF8'`);
      }
      await ensureRole(sql, record.roles.app, "app", passwords.app);
      await ensureRole(sql, record.roles.migration, "migration", passwords.migration);
      await sql.script(
        `revoke all on database ${database} from public;
         grant connect on database ${database} to ${app}, ${migration};
         revoke connect on database ${platformDatabase} from public;`
      );
      // What the store's roles reach beside their own database. The platform's database is
      // the platform's to close and was closed above. `postgres` and `template1` are the
      // server's: their grants are looked at and never changed here.
      const [reached] = await sql.run(REACH, [record.roles.app, server.platformDatabase]);
      return reachRow.parse(reached);
    }
  );
  // Raised here and not inside the change: whatever a change throws leaves it as a failure
  // of the database.
  if (reach.platform) {
    throw new DataStoreProvisioningError(
      "platform_database_open",
      "The roles of a Data Store could connect to the platform database: the platform's database role does not own that database, so it cannot take CONNECT from PUBLIC. Make it the owner, or run REVOKE CONNECT ON DATABASE ... FROM PUBLIC as its owner."
    );
  }

  const superuser = await platformIsSuperuser(server, signal);
  await server.executor.change(
    { ...server.asPlatform(record.location.database), ...step },
    async (sql) => {
      // Only a superuser may take a function or a view of the catalog from PUBLIC. Where the
      // platform's role is none, a session of the store can still see and end another one of
      // the same store, which runs as the same role.
      if (superuser) await sql.script(HIDE_OTHER_SESSIONS);
      await sql.script(
        `revoke all on schema public from public;
         grant usage, create on schema public to ${migration};
         grant usage on schema public to ${app};
         create schema if not exists catalyst;
         create table if not exists catalyst.migrations (
           number integer not null,
           name text not null,
           sha256 text not null,
           proof text not null,
           applied_at timestamp with time zone not null default now()
         );
         grant usage on schema catalyst to ${migration};
         grant insert on catalyst.migrations to ${migration};`
      );
    }
  );

  // Default privileges belong to the role that creates: the migration role says itself that
  // what it makes in `public` from now on is the app role's to read and write.
  await server.executor.change({ ...server.asRole(record, "migration"), ...step }, (sql) =>
    sql.script(
      `alter default privileges in schema public
         grant select, insert, update, delete on tables to ${app};
       alter default privileges in schema public
         grant usage, select on sequences to ${app};`
    )
  );
  return [
    ...(reach.server ? (["server_databases_open"] as const) : []),
    ...(superuser ? [] : (["sessions_open"] as const))
  ];
}
