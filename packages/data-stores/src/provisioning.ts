import { callRecordsSetup } from "./calls";
import { z } from "zod";
import type { DataStoreCondition, DataStoreRecord } from "@work-shape/catalyst-core";
import type { DataStoreRole } from "./credentials";
import { platformIsSuperuser, writeStoreRoles } from "./roles";
import { quoteIdentifier, type DataStoreServer } from "./server";

// The one place a store's database, its roles and their grants are made. Every statement is
// built from names this package derived, never from a caller's text.

/** How long making the database or its grants may take before the attempt fails. */
const DATA_STORE_PROVISION_STEP_TIMEOUT_MS = 120_000;

type StoreDatabase = Pick<DataStoreRecord, "id" | "location" | "roles">;

/**
 * What tells of another session or ends one: the functions that read the sessions of the
 * server, which every role may call, and the two that cancel and end. In the database of one
 * store they are taken from PUBLIC, which only a superuser may do. The catalog of a database
 * is its own, so no other database of the server changes.
 */
const SESSION_FUNCTIONS = `
  select p.oid::pg_catalog.regprocedure::pg_catalog.text as signature
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'pg_catalog'
    and (p.proname like 'pg\\_stat\\_get\\_backend\\_%'
      or p.proname in ('pg_stat_get_activity', 'pg_terminate_backend', 'pg_cancel_backend'))
`;

/** The views over those functions that a role reads sessions through. */
const SESSION_VIEWS = ["pg_stat_activity", "pg_stat_replication", "pg_stat_ssl", "pg_stat_gssapi"];

/**
 * Whether a role of the store may connect to the platform's database, and to any other
 * database of the server but its own.
 */
const REACH = `
  select pg_catalog.has_database_privilege($1, $2, 'CONNECT') as platform,
    coalesce((
      select pg_catalog.bool_or(pg_catalog.has_database_privilege($1, d.oid, 'CONNECT'))
      from pg_catalog.pg_database d
      where d.datallowconn and d.datname <> $2 and d.datname <> $3
    ), false) as server
`;

const reachRow = z.object({ platform: z.boolean(), server: z.boolean() });

type ProvisioningStop =
  "platform_database_open" | "vector_extension_missing" | "vector_extension_not_permitted";

/** Why provisioning stopped at something an operator settles. The code is the failure of the store. */
export class DataStoreProvisioningError extends Error {
  readonly code: ProvisioningStop;

  constructor(code: ProvisioningStop, message: string) {
    super(message);
    this.name = "DataStoreProvisioningError";
    this.code = code;
  }
}

async function readReach(
  server: DataStoreServer,
  record: StoreDatabase,
  signal: AbortSignal
): Promise<z.infer<typeof reachRow>> {
  const read = await server.executor.query({
    ...server.asPlatform(server.platformDatabase),
    signal,
    sql: REACH,
    parameters: [record.roles.app, server.platformDatabase, record.location.database]
  });
  return reachRow.parse(read.rows[0]);
}

/**
 * What the server leaves open around a store, for an operator to close: asked anew at every
 * job, so the store's record says what is so now. The grants of other databases are looked at
 * and never changed here: the server may be shared.
 */
export async function readStoreConditions(
  server: DataStoreServer,
  record: StoreDatabase,
  signal: AbortSignal
): Promise<DataStoreCondition[]> {
  const superuser = await platformIsSuperuser(server, signal);
  const reach = await readReach(server, record, signal);
  return [
    ...(reach.server ? (["server_databases_open"] as const) : []),
    // Only a superuser takes the session functions from a store and bounds its temporary files.
    ...(superuser ? [] : (["sessions_open", "temp_files_unbounded"] as const))
  ];
}

/**
 * What the platform keeps in the database of a store, made or completed as its own role: the
 * record of applied migrations with the index its signed rows are found by, and, where the
 * platform's role is a superuser, no way for a role of the store to list or end a session.
 * Every statement finds what is there and adds what is missing, so a store that was
 * provisioned before a part of this existed gets it at its next job.
 */
export async function ensureStoreSchema(
  server: DataStoreServer,
  record: StoreDatabase,
  signal: AbortSignal
): Promise<void> {
  const app = quoteIdentifier(record.roles.app);
  const migration = quoteIdentifier(record.roles.migration);
  const superuser = await platformIsSuperuser(server, signal);
  await server.executor.change(
    {
      ...server.asPlatform(record.location.database),
      timeoutMs: DATA_STORE_PROVISION_STEP_TIMEOUT_MS,
      signal
    },
    async (sql) => {
      if (superuser) {
        const functions = z
          .array(z.object({ signature: z.string() }))
          .parse(await sql.run(SESSION_FUNCTIONS));
        await sql.script(
          [
            ...functions.map(
              ({ signature }) => `revoke execute on function ${signature} from public`
            ),
            ...SESSION_VIEWS.map((view) => `revoke select on pg_catalog.${view} from public`)
          ].join(";\n")
        );
      }
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
         create index if not exists migrations_proof on catalyst.migrations (proof);
         grant usage on schema catalyst to ${migration};
         grant insert on catalyst.migrations to ${migration};
         ${callRecordsSetup(record.roles.app)}`
      );
    }
  );
}

/**
 * Creates the database of a store with its two roles, or completes one an earlier attempt left
 * unfinished: every step finds what is there and adds what is missing. When it returns,
 *
 * - the app role and the migration role exist, log in with the given passwords, own nothing
 *   and carry their settings and connection limit;
 * - the database exists, owned by the platform's role, and only those two roles and its owner
 *   connect to it;
 * - `PUBLIC` holds nothing on the database or its schema `public`, and no `CONNECT` on the
 *   platform's database;
 * - the migration role creates in `public`, and may add to `catalyst.migrations` and neither
 *   read nor change it; what it creates in `public` the app role reads and writes.
 */
export async function provisionDataStore(
  server: DataStoreServer,
  record: StoreDatabase,
  passwords: Record<DataStoreRole, string>,
  signal: AbortSignal
): Promise<void> {
  const database = quoteIdentifier(record.location.database);
  const app = quoteIdentifier(record.roles.app);
  const migration = quoteIdentifier(record.roles.migration);
  const platformDatabase = quoteIdentifier(server.platformDatabase);
  const step = { timeoutMs: DATA_STORE_PROVISION_STEP_TIMEOUT_MS, signal };

  await writeStoreRoles(server, record, passwords, signal, { create: true });
  await server.executor.change(
    // `create database` runs in no transaction.
    { ...server.asPlatform(server.platformDatabase), ...step, transaction: false },
    async (sql) => {
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
    }
  );
  // The platform's database is the platform's to close and was closed above.
  if ((await readReach(server, record, signal)).platform) {
    throw new DataStoreProvisioningError(
      "platform_database_open",
      "The roles of a Data Store could connect to the platform database: the platform's database role does not own that database, so it cannot take CONNECT from PUBLIC. Make it the owner, or run REVOKE CONNECT ON DATABASE ... FROM PUBLIC as its owner."
    );
  }
  await ensureStoreSchema(server, record, signal);

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

/**
 * What the server offers of pgvector: the version `create extension` installs, whether it is
 * trusted, and whether the database already has it.
 */
const VECTOR_EXTENSION = `
  select v.version, v.trusted, e.installed_version is not null as installed
  from pg_catalog.pg_available_extensions e
  join pg_catalog.pg_available_extension_versions v
    on v.name operator(pg_catalog.=) e.name and v.version operator(pg_catalog.=) e.default_version
  where e.name operator(pg_catalog.=) 'vector'
`;

const vectorExtensionRow = z.object({
  version: z.string(),
  trusted: z.boolean(),
  installed: z.boolean()
});

/**
 * Creates pgvector in the database of a store, as the platform's role: only for a store a
 * Knowledge Base with semantic search owns, never for a store of an App (ADR-0023). The
 * extension's objects are the platform's; the store's roles use its types and operators.
 *
 * A trusted extension may be created by a role with CREATE on the database. The roles of a
 * store are given none, and where `vector` is trusted it is taken from them here once more, so
 * only this function creates it. On the instance's own image it is not trusted, and the
 * platform's role, the server's superuser, creates it.
 */
export async function ensureVectorExtension(
  server: DataStoreServer,
  record: StoreDatabase,
  signal: AbortSignal
): Promise<void> {
  const where = `${record.location.host}:${record.location.port}`;
  const offered = await server.executor.query({
    ...server.asPlatform(record.location.database),
    signal,
    sql: VECTOR_EXTENSION
  });
  const [row] = z.array(vectorExtensionRow).parse(offered.rows);
  if (!row) {
    throw new DataStoreProvisioningError(
      "vector_extension_missing",
      `The Postgres server ${where} has no pgvector, which a Knowledge Base with semantic search stores its embeddings with. Run the instance's own Postgres image, or install pgvector on that server; publishing the Knowledge Base again then provisions its store.`
    );
  }
  // Created before, by this function or by an operator as the refusal below tells them to.
  if (row.installed) return;
  if (!row.trusted && !(await platformIsSuperuser(server, signal))) {
    throw new DataStoreProvisioningError(
      "vector_extension_not_permitted",
      `pgvector is not a trusted extension on the Postgres server ${where}, so only a superuser creates it, and the platform's database role is none. Create it as a superuser with CREATE EXTENSION vector in the database of the store, or let the platform connect as the server's superuser.`
    );
  }
  const database = quoteIdentifier(record.location.database);
  const roles = `${quoteIdentifier(record.roles.app)}, ${quoteIdentifier(record.roles.migration)}`;
  await server.executor.change(
    {
      ...server.asPlatform(record.location.database),
      timeoutMs: DATA_STORE_PROVISION_STEP_TIMEOUT_MS,
      signal
    },
    (sql) =>
      sql.script(
        `create extension if not exists vector with schema public;
         ${row.trusted ? `revoke create on database ${database} from ${roles};` : ""}`
      )
  );
}
