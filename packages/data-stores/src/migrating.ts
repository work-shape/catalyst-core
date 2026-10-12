import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DataStoreAppliedMigration, DataStoreRecord } from "@vivd-catalyst/core";
import type { DataStoreMigration } from "./definition";
import { DATA_STORE_ROLE_LIMITS, roleSettings } from "./role-limits";
import type { DataStoreServer } from "./server";

// How one migration reaches a store's database, and how the platform knows which ones did.
// The file's statements run as the migration role. Two things hold whatever the text says:
// it cannot end the transaction it runs in, and the record of what was applied is the
// platform's, which a migration can add rows to and never forge.

/** How long reading the applied migrations of a store may take before the attempt fails. */
const DATA_STORE_LEVEL_READ_TIMEOUT_MS = 15_000;
/**
 * How many rows of the record of applied migrations are read. A store has at most 500
 * migrations; rows beyond them are ones a migration wrote itself, which count for nothing.
 */
const DATA_STORE_LEDGER_MAX_ROWS = 5_000;

type StoreDatabase = Pick<DataStoreRecord, "id" | "location" | "roles">;

const ledgerRow = z.object({
  number: z.number().int(),
  name: z.string(),
  sha256: z.string(),
  proof: z.string()
});

/**
 * The signature of one row of the record: only the platform holds the key, so a row a
 * migration writes itself carries none that holds and is not read as applied.
 */
function proofOf(key: string, migration: DataStoreAppliedMigration): string {
  return createHmac("sha256", key)
    .update(`${migration.number}|${migration.name}|${migration.sha256}`)
    .digest("hex");
}

function holds(key: string, row: z.infer<typeof ledgerRow>): boolean {
  const expected = Buffer.from(proofOf(key, row));
  const given = Buffer.from(row.proof);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The migrations a store's database has applied, as the platform recorded them there: the
 * rows whose signature holds, one per number. It is read as the platform's own role, since
 * the migration role may add to the record and not read it.
 */
export async function readAppliedMigrations(
  server: DataStoreServer,
  record: StoreDatabase,
  ledgerKey: string,
  signal: AbortSignal
): Promise<DataStoreAppliedMigration[]> {
  const rows = await server.executor.change(
    {
      ...server.asPlatform(record.location.database),
      timeoutMs: DATA_STORE_LEVEL_READ_TIMEOUT_MS,
      signal
    },
    async (sql) =>
      z
        .array(ledgerRow)
        .parse(
          await sql.run(
            `select number, name, sha256, proof from catalyst.migrations order by number, applied_at limit ${DATA_STORE_LEDGER_MAX_ROWS}`
          )
        )
  );
  const applied = new Map<number, DataStoreAppliedMigration>();
  for (const row of rows) {
    if (!applied.has(row.number) && holds(ledgerKey, row)) {
      applied.set(row.number, { number: row.number, name: row.name, sha256: row.sha256 });
    }
  }
  return [...applied.values()];
}

/** Why a migration was not applied although the database raised no error of its own. */
export class DataStoreMigrationRefusal extends Error {
  readonly code: "migration_changed_role" | "migration_left_transaction";

  constructor(code: DataStoreMigrationRefusal["code"]) {
    super(code);
    this.name = "DataStoreMigrationRefusal";
    this.code = code;
  }
}

/**
 * The file's statements as one statement of a block. Run this way, Postgres itself refuses
 * every statement that would end or split the transaction, also one that is put together
 * while the file runs: nothing of a migration stays unless all of it does.
 */
function heldInTransaction(sql: string): string {
  return `do $catalyst_migration$ begin execute '${sql.replaceAll("'", "''")}'; end $catalyst_migration$`;
}

const TRANSACTION = "select pg_catalog.pg_current_xact_id()::text as id";

/** The settings and the connection limit of the store's roles, as this transaction sees them. */
const ROLE_STATE = `
  select r.rolname as name, r.rolconnlimit as connection_limit,
    coalesce(pg_catalog.array_to_string(r.rolconfig, ','), '') as settings,
    (select count(*) from pg_catalog.pg_db_role_setting s
      where s.setrole = r.oid and s.setdatabase <> 0)::integer as per_database
  from pg_catalog.pg_roles r where r.rolname = any ($1)
  order by r.rolname
`;

function expectedRoleState(record: StoreDatabase) {
  return (["app", "migration"] as const)
    .map((role) => ({
      name: record.roles[role],
      connection_limit: DATA_STORE_ROLE_LIMITS[role].connectionLimit,
      settings: roleSettings(role).join(","),
      per_database: 0
    }))
    .sort((left, right) => (left.name < right.name ? -1 : 1));
}

/**
 * Applies one migration as the migration role: the file's statements and the row that records
 * it, in one transaction. Either both are there afterwards or neither is, so a migration is
 * never applied twice and never recorded without its effect. A migration that changed the
 * settings of a role of its store is rolled back and refused, and so is one after which the
 * transaction is no longer the one that was opened.
 */
export async function applyMigration(
  server: DataStoreServer,
  record: StoreDatabase,
  migration: DataStoreMigration,
  ledgerKey: string,
  signal: AbortSignal
): Promise<void> {
  // Whatever a change throws leaves it as a failure of the database, so the refusal is kept
  // here and raised once the change has rolled back.
  let refusal: DataStoreMigrationRefusal | undefined;
  try {
    await server.executor.change(
      {
        ...server.asRole(record, "migration"),
        timeoutMs: DATA_STORE_ROLE_LIMITS.migration.statementTimeoutMs,
        signal
      },
      async (sql) => {
        const [opened] = await sql.run(TRANSACTION);
        await sql.script(heldInTransaction(migration.sql));
        const [now] = await sql.run(TRANSACTION);
        if (opened?.id === undefined || opened.id !== now?.id) {
          refusal = new DataStoreMigrationRefusal("migration_left_transaction");
          throw refusal;
        }
        const roles = await sql.run(ROLE_STATE, [
          { type: "text[]", value: [record.roles.app, record.roles.migration] }
        ]);
        if (JSON.stringify(roles) !== JSON.stringify(expectedRoleState(record))) {
          refusal = new DataStoreMigrationRefusal("migration_changed_role");
          throw refusal;
        }
        const applied = {
          number: migration.number,
          name: migration.name,
          sha256: migration.sha256
        };
        await sql.run(
          "insert into catalyst.migrations (number, name, sha256, proof) values ($1, $2, $3, $4)",
          [
            { type: "integer", value: applied.number },
            applied.name,
            applied.sha256,
            proofOf(ledgerKey, applied)
          ]
        );
      }
    );
  } catch (error) {
    throw refusal ?? error;
  }
}
