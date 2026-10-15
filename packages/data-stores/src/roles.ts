import { createHmac, createHash, pbkdf2 } from "node:crypto";
import { promisify } from "node:util";
import {
  PostgresExecutorError,
  type PostgresChangeStatements
} from "@work-shape/catalyst-postgres-connector";
import { z } from "zod";
import type { DataStoreRecord } from "@work-shape/catalyst-core";
import type { DataStoreRole } from "./credentials";
import { DATA_STORE_ROLE_LIMITS, roleSettings } from "./role-limits";
import type { DataStoreRuntime } from "./runtime";
import {
  DATA_STORE_READER_CONNECTION_LIMIT,
  quoteIdentifier,
  type DataStoreServer
} from "./server";

// The two roles of a store as the platform gave them, and how it keeps them so. A role may
// change its own password and its own settings, in a migration as in a trigger that fires on
// an insert, and Postgres forbids neither. So the platform looks before it connects as one,
// with one statement, and sets again what differs, in one transaction.
//
// Nothing here works anything out from what a role wrote: what Postgres holds of a role is
// compared with what the platform would write, text against text.

/** How long setting the roles of a store again may take before the attempt fails. */
const DATA_STORE_ROLE_STEP_TIMEOUT_MS = 120_000;

/** The rounds of the verifier the platform writes. Postgres's own default. */
const SCRAM_ITERATIONS = 4_096;

const ROLES = ["app", "migration"] as const satisfies readonly DataStoreRole[];

type StoreRoles = Pick<DataStoreRecord, "roles">;
type Passwords = Record<DataStoreRole, string>;

const derive = promisify(pbkdf2);
const verifiers = new Map<string, Promise<string>>();

/**
 * What Postgres stores of a password, RFC 5802 as `pg_authid.rolpassword` holds it. The
 * password itself is in no statement, so it reaches no server log. The salt is made from the
 * password, which is random and of one role alone: so the same password always gives the same
 * verifier, and whether a role still has its password is a comparison of two texts. It is
 * worked out once per password and process.
 */
function scramVerifier(password: string): Promise<string> {
  let known = verifiers.get(password);
  if (!known) {
    known = (async () => {
      const salt = createHmac("sha256", password).update("catalyst data store salt").digest();
      const salted = await derive(password, salt.subarray(0, 16), SCRAM_ITERATIONS, 32, "sha256");
      const clientKey = createHmac("sha256", salted).update("Client Key").digest();
      const storedKey = createHash("sha256").update(clientKey).digest("base64");
      const serverKey = createHmac("sha256", salted).update("Server Key").digest("base64");
      return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.subarray(0, 16).toString("base64")}$${storedKey}:${serverKey}`;
    })();
    verifiers.set(password, known);
  }
  return known;
}

const SUPERUSER =
  "select rolsuper as superuser from pg_catalog.pg_roles where rolname operator(pg_catalog.=) current_user";

const superuserOf = new WeakMap<DataStoreServer, Promise<boolean>>();

/** Whether the platform's own role is a superuser of the server. Asked once per process. */
export function platformIsSuperuser(
  server: DataStoreServer,
  signal?: AbortSignal
): Promise<boolean> {
  let known = superuserOf.get(server);
  if (!known) {
    known = server.executor
      .query({
        ...server.asPlatform(server.platformDatabase),
        ...(signal ? { signal } : {}),
        sql: SUPERUSER
      })
      .then((answer) => answer.rows[0]?.superuser === true);
    superuserOf.set(server, known);
    known.catch(() => superuserOf.delete(server));
  }
  return known;
}

/**
 * The settings and the connection limit of the store's roles, as the session that asks sees
 * them. Every name in it carries its schema: a migration asks this in its own transaction,
 * after its own statements ran.
 */
export const ROLE_STATE = roleStateStatement("");

/** The same with the verifier of each role, which Postgres shows to a superuser alone. */
const ROLE_STATE_WITH_VERIFIER = roleStateStatement(
  `, (select a.rolpassword from pg_catalog.pg_authid a
       where a.oid operator(pg_catalog.=) r.oid) as verifier`
);

function roleStateStatement(further: string): string {
  return `
    select r.rolname::pg_catalog.text as name, r.rolconnlimit as connection_limit,
      coalesce(pg_catalog.array_to_string(r.rolconfig, ','::pg_catalog.text), ''::pg_catalog.text) as settings,
      (select pg_catalog.count(*) from pg_catalog.pg_db_role_setting s
        where s.setrole operator(pg_catalog.=) r.oid
          and s.setdatabase operator(pg_catalog.<>) '0'::pg_catalog.oid)::pg_catalog.int4 as per_database
      ${further}
    from pg_catalog.pg_roles r
    where r.rolname operator(pg_catalog.=) any ($1::pg_catalog.name[])
    order by r.rolname
  `;
}

const roleState = z.array(
  z.object({
    name: z.string(),
    connection_limit: z.number(),
    settings: z.string(),
    per_database: z.number(),
    verifier: z.string().nullable().optional()
  })
);

function expectedRoleState(record: StoreRoles, superuser: boolean, held?: Passwords) {
  return ROLES.map((role) => ({
    name: record.roles[role],
    connection_limit: DATA_STORE_ROLE_LIMITS[role].connectionLimit,
    settings: roleSettings(role, superuser).join(","),
    per_database: 0,
    ...(held ? { verifier: held[role] } : {})
  })).sort((left, right) => (left.name < right.name ? -1 : 1));
}

/** The names of both roles, as `ROLE_STATE` is asked for them. */
export function roleNames(record: StoreRoles) {
  return [{ type: "text[]" as const, value: [record.roles.app, record.roles.migration] }];
}

/**
 * Whether the roles of a store carry exactly the settings and the connection limit the
 * platform gave them, and, where `verifiers` names them, the passwords.
 */
export function rolesAreUnchanged(
  record: StoreRoles,
  superuser: boolean,
  rows: unknown,
  verifiersHeld?: Passwords
): boolean {
  return (
    JSON.stringify(roleState.parse(rows)) ===
    JSON.stringify(expectedRoleState(record, superuser, verifiersHeld))
  );
}

/**
 * Gives the two roles of a store what the platform holds for them, in one transaction:
 * password, connection limit and settings, and nothing else, also for no single database.
 * With `create` a role that is not there is made first. Nobody sees a role half set.
 */
export async function writeStoreRoles(
  server: DataStoreServer,
  record: StoreRoles,
  passwords: Passwords,
  signal: AbortSignal | undefined,
  options: { create?: true } = {}
): Promise<void> {
  const superuser = await platformIsSuperuser(server, signal);
  const held = {
    app: await scramVerifier(passwords.app),
    migration: await scramVerifier(passwords.migration)
  };
  await server.executor.change(
    {
      ...server.asPlatform(server.platformDatabase),
      timeoutMs: DATA_STORE_ROLE_STEP_TIMEOUT_MS,
      ...(signal ? { signal } : {})
    },
    async (sql) => {
      for (const role of ROLES) {
        await writeLoginRole(sql, record.roles[role], {
          connectionLimit: DATA_STORE_ROLE_LIMITS[role].connectionLimit,
          verifier: held[role],
          settings: roleSettings(role, superuser),
          ...options
        });
      }
    }
  );
}

/**
 * Gives one login role its password, connection limit and settings, and nothing else, also for
 * no single database. With `create` a role that is not there is made first: it logs in and may
 * do nothing else, and it is a member of no role.
 */
async function writeLoginRole(
  sql: PostgresChangeStatements,
  name: string,
  role: { connectionLimit: number; verifier: string; settings: readonly string[]; create?: true }
): Promise<void> {
  const quoted = quoteIdentifier(name);
  if (role.create) {
    const [existing] = await sql.run("select 1 from pg_catalog.pg_roles where rolname = $1", [
      name
    ]);
    if (!existing) {
      await sql.script(
        `create role ${quoted} login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`
      );
    }
  }
  const elsewhere = await sql.run(
    `select d.datname::pg_catalog.text as name from pg_catalog.pg_db_role_setting s
       join pg_catalog.pg_roles r on r.oid = s.setrole
       join pg_catalog.pg_database d on d.oid = s.setdatabase
       where r.rolname = $1`,
    [name]
  );
  // The verifier is base64 and digits between fixed marks: it holds no quote.
  await sql.script(
    [
      `alter role ${quoted} connection limit ${role.connectionLimit} password '${role.verifier}'`,
      `alter role ${quoted} reset all`,
      ...z
        .array(z.object({ name: z.string() }))
        .parse(elsewhere)
        .map(
          (other) => `alter role ${quoted} in database ${quoteIdentifier(other.name)} reset all`
        ),
      ...role.settings.map((setting) => `alter role ${quoted} set ${setting.replace("=", " = ")}`)
    ].join(";\n")
  );
}

/**
 * Gives the role of a Knowledge Base its password, its connection limit and the settings of the
 * store's app role, made where it is not there. What it may read is granted on the store.
 */
export async function writeReaderRole(
  server: DataStoreServer,
  name: string,
  password: string,
  signal: AbortSignal | undefined
): Promise<void> {
  const superuser = await platformIsSuperuser(server, signal);
  const verifier = await scramVerifier(password);
  await server.executor.change(
    {
      ...server.asPlatform(server.platformDatabase),
      timeoutMs: DATA_STORE_ROLE_STEP_TIMEOUT_MS,
      ...(signal ? { signal } : {})
    },
    (sql) =>
      writeLoginRole(sql, name, {
        connectionLimit: DATA_STORE_READER_CONNECTION_LIMIT,
        verifier,
        settings: roleSettings("app", superuser),
        create: true
      })
  );
}

/** The passwords of both roles, each made where the Secret Store holds none. */
async function storePasswords(
  runtime: Pick<DataStoreRuntime, "credentials" | "stores">,
  storeId: string
): Promise<Passwords> {
  const { credentials, stores } = runtime;
  return {
    app: await credentials.ensure(stores.connections, storeId, "app"),
    migration: await credentials.ensure(stores.connections, storeId, "migration")
  };
}

/**
 * Looks at the two roles of a store with one statement and sets them again where they differ
 * from what the platform gave them. Settings and connection limit are seen by every platform
 * role. The password is seen by a superuser alone; any other platform role learns of a
 * changed one when Postgres refuses the password, see `asStoreRole`.
 */
async function holdStoreRoles(
  runtime: Pick<DataStoreRuntime, "server" | "credentials" | "stores">,
  record: Pick<DataStoreRecord, "id" | "roles">,
  signal: AbortSignal | undefined
): Promise<void> {
  const { server } = runtime;
  const superuser = await platformIsSuperuser(server, signal);
  const passwords = await storePasswords(runtime, record.id);
  const state = await server.executor.query({
    ...server.asPlatform(server.platformDatabase),
    ...(signal ? { signal } : {}),
    sql: superuser ? ROLE_STATE_WITH_VERIFIER : ROLE_STATE,
    parameters: roleNames(record)
  });
  const held = superuser
    ? {
        app: await scramVerifier(passwords.app),
        migration: await scramVerifier(passwords.migration)
      }
    : undefined;
  if (!rolesAreUnchanged(record, superuser, state.rows, held)) {
    await writeStoreRoles(server, record, passwords, signal);
  }
}

/**
 * Runs `work`, which connects as a role of the store, with the roles held to what the
 * platform gave them. Where Postgres refuses the platform's connection its password all the
 * same, the role changed it since: both roles are set again and the work runs once more. An
 * error a statement of the work raises is never that, whatever its SQLSTATE.
 */
export async function asStoreRole<Result>(
  runtime: Pick<DataStoreRuntime, "server" | "credentials" | "stores">,
  record: Pick<DataStoreRecord, "id" | "roles">,
  signal: AbortSignal | undefined,
  work: () => Promise<Result>
): Promise<Result> {
  await holdStoreRoles(runtime, record, signal);
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof PostgresExecutorError) || error.kind !== "unauthorized") throw error;
    await writeStoreRoles(runtime.server, record, await storePasswords(runtime, record.id), signal);
    return work();
  }
}
