import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import type { PostgresChangeStatements } from "@vivd-catalyst/postgres-connector";
import type { DataStoreRecord } from "@vivd-catalyst/core";
import type { DataStoreRole } from "./credentials";
import { DATA_STORE_ROLE_LIMITS } from "./role-limits";
import { quoteIdentifier, type DataStoreServer } from "./server";

// The one place a store's database, its roles and their grants are made. Every statement is
// built from names this package derived, never from a caller's text.

/** How long a session of a store role may sit idle inside a transaction before Postgres ends it. */
const DATA_STORE_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

/** How long making the roles, the database or its grants may take before the attempt fails. */
const DATA_STORE_PROVISION_STEP_TIMEOUT_MS = 120_000;

const SCRAM_ITERATIONS = 4_096;

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
  password: string
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
  await sql.script(`alter role ${quoted} set statement_timeout = ${limits.statementTimeoutMs}`);
  await sql.script(
    `alter role ${quoted} set idle_in_transaction_session_timeout = ${DATA_STORE_IDLE_IN_TRANSACTION_TIMEOUT_MS}`
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
 * - the migration role creates in `public` and records in `catalyst.migrations`; what it
 *   creates there the app role reads and writes.
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
      await ensureRole(sql, record.roles.app, "app", passwords.app);
      await ensureRole(sql, record.roles.migration, "migration", passwords.migration);
      const [existing] = await sql.run("select 1 from pg_catalog.pg_database where datname = $1", [
        record.location.database
      ]);
      if (!existing) {
        await sql.script(`create database ${database} template template0 encoding 'UTF8'`);
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

  await server.executor.change({ ...server.asPlatform(record.location.database), ...step }, (sql) =>
    sql.script(
      `revoke all on schema public from public;
         grant usage, create on schema public to ${migration};
         grant usage on schema public to ${app};
         create schema if not exists catalyst;
         create table if not exists catalyst.migrations (
           number integer primary key,
           name text not null,
           sha256 text not null,
           applied_at timestamp with time zone not null default now()
         );
         grant usage on schema catalyst to ${migration};
         grant select, insert on catalyst.migrations to ${migration};`
    )
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
