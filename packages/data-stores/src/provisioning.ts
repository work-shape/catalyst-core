import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import type { PostgresChangeStatements } from "@vivd-catalyst/postgres-connector";
import { z } from "zod";
import type { DataStoreRecord } from "@vivd-catalyst/core";
import type { DataStoreRole } from "./credentials";
import { DATA_STORE_ROLE_LIMITS, roleSettings } from "./role-limits";
import { quoteIdentifier, type DataStoreServer } from "./server";

// The one place a store's database, its roles and their grants are made. Every statement is
// built from names this package derived, never from a caller's text.

/** How long making the roles, the database or its grants may take before the attempt fails. */
const DATA_STORE_PROVISION_STEP_TIMEOUT_MS = 120_000;

const SCRAM_ITERATIONS = 4_096;

/**
 * `postgres` and `template1` while `PUBLIC` connects to them, where the platform's role owns
 * them or is a superuser. A database without an access list has the default one, which lets
 * `PUBLIC` connect.
 */
const SERVER_DATABASES_OPEN = `
  select d.datname as name from pg_catalog.pg_database d
  where d.datname in ('postgres', 'template1')
    and (pg_catalog.pg_has_role(current_user, d.datdba, 'USAGE')
      or (select rolsuper from pg_catalog.pg_roles where rolname = current_user))
    and (d.datacl is null or exists (
      select 1 from pg_catalog.aclexplode(d.datacl) acl
      where acl.grantee = 0 and acl.privilege_type = 'CONNECT'))
`;

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
 * What Postgres stores of a password. The password itself is in no statement, so it reaches
 * no server log. RFC 5802, as `pg_authid.rolpassword` holds it.
 */
function scramVerifier(password: string): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password.normalize("NFKC"), salt, SCRAM_ITERATIONS, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest("base64");
  const serverKey = createHmac("sha256", salted).update("Server Key").digest("base64");
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}

async function ensureRole(
  sql: PostgresChangeStatements,
  name: string,
  role: DataStoreRole,
  password: string,
  /** The quoted name of the store's database. */
  database: string
): Promise<void> {
  const quoted = quoteIdentifier(name);
  const limits = DATA_STORE_ROLE_LIMITS[role];
  const [existing] = await sql.run("select 1 from pg_catalog.pg_roles where rolname = $1", [name]);
  if (!existing) {
    await sql.script(
      `create role ${quoted} login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`
    );
  }
  // The verifier is base64 and digits between fixed marks: it holds no quote.
  await sql.script(
    `alter role ${quoted} connection limit ${limits.connectionLimit} password '${scramVerifier(password)}'`
  );
  // Exactly the settings of the role: whatever else it carried, also for one database, goes.
  await sql.script(`alter role ${quoted} reset all`);
  await sql.script(`alter role ${quoted} in database ${database} reset all`);
  for (const setting of roleSettings(role)) {
    await sql.script(`alter role ${quoted} set ${setting.replace("=", " = ")}`);
  }
}

/**
 * Holds the two roles of a store to what the platform gave them: its password, its connection
 * limit and its settings. A role may change its own password and settings, and Postgres shows
 * nobody whether a password changed, so this is said again after every migration.
 */
export async function assertStoreRoles(
  server: DataStoreServer,
  record: Pick<DataStoreRecord, "location" | "roles">,
  passwords: Record<DataStoreRole, string>,
  signal: AbortSignal
): Promise<void> {
  const database = quoteIdentifier(record.location.database);
  await server.executor.change(
    {
      ...server.asPlatform(server.platformDatabase),
      timeoutMs: DATA_STORE_PROVISION_STEP_TIMEOUT_MS,
      signal,
      transaction: false
    },
    async (sql) => {
      await ensureRole(sql, record.roles.app, "app", passwords.app, database);
      await ensureRole(sql, record.roles.migration, "migration", passwords.migration, database);
    }
  );
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
 * - where the platform's role is a superuser, no role of the store lists or ends a session,
 *   and where it owns `postgres` and `template1`, `PUBLIC` no longer connects to them.
 */
export async function provisionDataStore(
  server: DataStoreServer,
  record: Pick<DataStoreRecord, "id" | "location" | "roles">,
  passwords: Record<DataStoreRole, string>,
  signal: AbortSignal
): Promise<void> {
  const database = quoteIdentifier(record.location.database);
  const app = quoteIdentifier(record.roles.app);
  const migration = quoteIdentifier(record.roles.migration);
  const platformDatabase = quoteIdentifier(server.platformDatabase);
  const step = { timeoutMs: DATA_STORE_PROVISION_STEP_TIMEOUT_MS, signal };

  const closedToStoreRoles = await server.executor.change(
    // `create database` runs in no transaction.
    { ...server.asPlatform(server.platformDatabase), ...step, transaction: false },
    async (sql) => {
      const [existing] = await sql.run("select 1 from pg_catalog.pg_database where datname = $1", [
        record.location.database
      ]);
      if (!existing) {
        await sql.script(`create database ${database} template template0 encoding 'UTF8'`);
      }
      await ensureRole(sql, record.roles.app, "app", passwords.app, database);
      await ensureRole(sql, record.roles.migration, "migration", passwords.migration, database);
      // The databases every server has. Whoever owns them takes the store roles' way in there
      // too; a platform role that owns neither leaves them as the server's operator set them.
      const open = async () =>
        z.array(z.object({ name: z.string() })).parse(await sql.run(SERVER_DATABASES_OPEN));
      for (const other of await open()) {
        try {
          await sql.script(`revoke connect on database ${quoteIdentifier(other.name)} from public`);
        } catch (error) {
          // Another store that is provisioned now may have taken it at the same moment, which
          // Postgres answers with an error for the one that came second.
          if ((await open()).some((still) => still.name === other.name)) throw error;
        }
      }
      await sql.script(
        `revoke all on database ${database} from public;
         grant connect on database ${database} to ${app}, ${migration};
         revoke connect on database ${platformDatabase} from public;`
      );
      const [reach] = await sql.run(
        "select pg_catalog.has_database_privilege($1, $2, 'CONNECT') as open",
        [record.roles.app, server.platformDatabase]
      );
      return reach?.open === false;
    }
  );
  // Raised here and not inside the change: whatever a change throws leaves it as a failure
  // of the database.
  if (!closedToStoreRoles) {
    throw new DataStoreProvisioningError(
      "platform_database_open",
      "The roles of a Data Store could connect to the platform database: the platform's database role does not own that database, so it cannot take CONNECT from PUBLIC. Make it the owner, or run REVOKE CONNECT ON DATABASE ... FROM PUBLIC as its owner."
    );
  }

  await server.executor.change(
    { ...server.asPlatform(record.location.database), ...step },
    async (sql) => {
      // Only a superuser may take a function or a view of the catalog from PUBLIC. Where the
      // platform's role is none, a session of the store can still see and end another one of
      // the same store, which runs as the same role.
      const [platform] = await sql.run(
        "select rolsuper as superuser from pg_catalog.pg_roles where rolname = current_user"
      );
      if (platform?.superuser === true) await sql.script(HIDE_OTHER_SESSIONS);
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
}
