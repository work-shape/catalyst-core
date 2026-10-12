import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import {
  PostgresExecutorError,
  type PostgresChangeStatements
} from "@vivd-catalyst/postgres-connector";
import { z } from "zod";
import type { DataStoreRecord } from "@vivd-catalyst/core";
import type { DataStoreRole } from "./credentials";
import { DATA_STORE_ROLE_LIMITS, roleSettings } from "./role-limits";
import type { DataStoreRuntime } from "./runtime";
import { quoteIdentifier, type DataStoreServer } from "./server";

// The two roles of a store as the platform gave them, and how it keeps them so. A role may
// change its own password and its own settings, in a migration as in a trigger that fires on
// an insert, and Postgres forbids neither. So the platform looks before it connects as one,
// and sets again what differs.

/** How long setting the roles of a store again may take before the attempt fails. */
const DATA_STORE_ROLE_STEP_TIMEOUT_MS = 120_000;

const SCRAM_ITERATIONS = 4_096;

type StoreRoles = Pick<DataStoreRecord, "roles">;

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

export async function ensureRole(
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
  // Exactly the settings of the role: whatever else it carried goes, also what it carried for
  // one database, whichever database that is.
  await sql.script(`alter role ${quoted} reset all`);
  const elsewhere = await sql.run(
    `select d.datname as name from pg_catalog.pg_db_role_setting s
       join pg_catalog.pg_roles r on r.oid = s.setrole
       join pg_catalog.pg_database d on d.oid = s.setdatabase
       where r.rolname = $1`,
    [name]
  );
  for (const other of z.array(z.object({ name: z.string() })).parse(elsewhere)) {
    await sql.script(`alter role ${quoted} in database ${quoteIdentifier(other.name)} reset all`);
  }
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
  record: Pick<DataStoreRecord, "roles">,
  passwords: Record<DataStoreRole, string>,
  signal: AbortSignal
): Promise<void> {
  await server.executor.change(
    {
      ...server.asPlatform(server.platformDatabase),
      timeoutMs: DATA_STORE_ROLE_STEP_TIMEOUT_MS,
      signal,
      transaction: false
    },
    async (sql) => {
      await ensureRole(sql, record.roles.app, "app", passwords.app);
      await ensureRole(sql, record.roles.migration, "migration", passwords.migration);
    }
  );
}

/** The settings and the connection limit of the store's roles, as this transaction sees them. */
export const ROLE_STATE = `
  select r.rolname as name, r.rolconnlimit as connection_limit,
    coalesce(pg_catalog.array_to_string(r.rolconfig, ','), '') as settings,
    (select pg_catalog.count(*) from pg_catalog.pg_db_role_setting s
      where s.setrole = r.oid and s.setdatabase <> 0)::integer as per_database
  from pg_catalog.pg_roles r where r.rolname = any ($1)
  order by r.rolname
`;

const roleState = z.array(
  z.object({
    name: z.string(),
    connection_limit: z.number(),
    settings: z.string(),
    per_database: z.number()
  })
);

/** Whether the roles of a store carry exactly what the platform gave them. */
export function rolesAreUnchanged(record: StoreRoles, rows: unknown): boolean {
  return JSON.stringify(roleState.parse(rows)) === JSON.stringify(expectedRoleState(record));
}

function expectedRoleState(record: StoreRoles) {
  return (["app", "migration"] as const)
    .map((role) => ({
      name: record.roles[role],
      connection_limit: DATA_STORE_ROLE_LIMITS[role].connectionLimit,
      settings: roleSettings(role).join(","),
      per_database: 0
    }))
    .sort((left, right) => (left.name < right.name ? -1 : 1));
}

/** Whether the verifier Postgres holds was made of the password. */
function verifierHolds(verifier: string, password: string): boolean {
  const parts = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):/u.exec(verifier);
  if (!parts) return false;
  const salted = pbkdf2Sync(
    password.normalize("NFKC"),
    Buffer.from(parts[2] ?? "", "base64"),
    Number(parts[1]),
    32,
    "sha256"
  );
  const storedKey = createHash("sha256")
    .update(createHmac("sha256", salted).update("Client Key").digest())
    .digest();
  const held = Buffer.from(parts[3] ?? "", "base64");
  return held.length === storedKey.length && timingSafeEqual(held, storedKey);
}

/** The verifier of each store role, which Postgres shows to a superuser alone. */
const ROLE_VERIFIERS = `
  select a.rolname as name, a.rolpassword as verifier
  from pg_catalog.pg_authid a where a.rolname = any ($1)
`;

const SUPERUSER =
  "select rolsuper as superuser from pg_catalog.pg_roles where rolname = current_user";

const superuserOf = new WeakMap<DataStoreServer, Promise<boolean>>();
/** The verifiers that were found to hold, so a role that did not change costs no key derivation. */
const verifiersSeen = new Map<string, string>();

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

async function storePasswords(
  runtime: Pick<DataStoreRuntime, "credentials" | "stores">,
  storeId: string
): Promise<Record<DataStoreRole, string>> {
  const { credentials, stores } = runtime;
  return {
    app: await credentials.ensure(stores.connections, storeId, "app"),
    migration: await credentials.ensure(stores.connections, storeId, "migration")
  };
}

/**
 * Looks at the two roles of a store and sets them again where they differ from what the
 * platform gave them: one read where nothing changed. Their settings and connection limit
 * are seen by every platform role. A changed password is seen by a superuser alone; any
 * other platform role learns of it when Postgres refuses the password, see `asStoreRole`.
 */
async function holdStoreRoles(
  runtime: Pick<DataStoreRuntime, "server" | "credentials" | "stores">,
  record: Pick<DataStoreRecord, "id" | "roles">,
  signal: AbortSignal | undefined
): Promise<void> {
  const { server } = runtime;
  const platform = {
    ...server.asPlatform(server.platformDatabase),
    ...(signal ? { signal } : {})
  };
  const names = [{ type: "text[]" as const, value: [record.roles.app, record.roles.migration] }];
  const state = await server.executor.query({ ...platform, sql: ROLE_STATE, parameters: names });
  let unchanged = rolesAreUnchanged(record, state.rows);
  if (unchanged && (await platformIsSuperuser(server, signal))) {
    const verifiers = z
      .array(z.object({ name: z.string(), verifier: z.string().nullable() }))
      .parse(
        (await server.executor.query({ ...platform, sql: ROLE_VERIFIERS, parameters: names })).rows
      );
    if (
      verifiers.some(
        ({ name, verifier }) => verifier === null || verifiersSeen.get(name) !== verifier
      )
    ) {
      const passwords = await storePasswords(runtime, record.id);
      for (const role of ["app", "migration"] as const) {
        const held = verifiers.find(({ name }) => name === record.roles[role])?.verifier;
        if (held && verifierHolds(held, passwords[role]))
          verifiersSeen.set(record.roles[role], held);
        else unchanged = false;
      }
    }
  }
  if (!unchanged) {
    await assertStoreRoles(
      server,
      record,
      await storePasswords(runtime, record.id),
      signal ?? new AbortController().signal
    );
  }
}

/**
 * Runs `work`, which connects as a role of the store, with the roles held to what the
 * platform gave them. Where Postgres refuses the password all the same, it was changed since:
 * both roles are set again and the work runs once more.
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
    await assertStoreRoles(
      runtime.server,
      record,
      await storePasswords(runtime, record.id),
      signal ?? new AbortController().signal
    );
    return work();
  }
}
