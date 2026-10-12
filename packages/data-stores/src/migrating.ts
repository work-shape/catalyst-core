import { createHmac } from "node:crypto";
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

type StoreDatabase = Pick<DataStoreRecord, "id" | "location" | "roles">;

/**
 * The signature of one row of the record: only the platform holds the key, so a row a
 * migration writes itself carries none that holds and is not read as applied.
 */
function proofOf(key: string, migration: DataStoreAppliedMigration): string {
  return createHmac("sha256", key)
    .update(`${migration.number}|${migration.name}|${migration.sha256}`)
    .digest("hex");
}

/**
 * Of the migrations the platform knows of, those the store's database holds a signed row for.
 * The read asks for the signatures the platform itself can make and for nothing else, so no
 * number of rows a migration added to the record bounds or delays what is found. It is read
 * as the platform's own role, since the migration role may add to the record and not read it.
 */
export async function readSignedMigrations(
  server: DataStoreServer,
  record: StoreDatabase,
  known: readonly DataStoreAppliedMigration[],
  ledgerKey: string,
  signal: AbortSignal
): Promise<DataStoreAppliedMigration[]> {
  const proofs = new Map(known.map((migration) => [proofOf(ledgerKey, migration), migration]));
  const rows = await server.executor.change(
    {
      ...server.asPlatform(record.location.database),
      timeoutMs: DATA_STORE_LEVEL_READ_TIMEOUT_MS,
      signal
    },
    async (sql) =>
      z
        .array(z.object({ proof: z.string() }))
        .parse(
          await sql.run("select distinct proof from catalyst.migrations where proof = any ($1)", [
            { type: "text[]", value: [...proofs.keys()] }
          ])
        )
  );
  return rows
    .flatMap((row) => proofs.get(row.proof) ?? [])
    .sort((left, right) => left.number - right.number);
}

/** Why a migration was not applied although the database raised no error of its own. */
export class DataStoreMigrationRefusal extends Error {
  readonly code = "migration_changed_role";
  /** Whether the migration was applied all the same: its role changed only as it committed. */
  readonly applied: boolean;

  constructor(applied: boolean) {
    super("migration_changed_role");
    this.name = "DataStoreMigrationRefusal";
    this.applied = applied;
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

/** The settings and the connection limit of the store's roles, as this transaction sees them. */
const ROLE_STATE = `
  select r.rolname as name, r.rolconnlimit as connection_limit,
    coalesce(pg_catalog.array_to_string(r.rolconfig, ','), '') as settings,
    (select count(*) from pg_catalog.pg_db_role_setting s
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
function rolesAreUnchanged(record: StoreDatabase, rows: unknown): boolean {
  return JSON.stringify(roleState.parse(rows)) === JSON.stringify(expectedRoleState(record));
}

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
 * never applied twice and never recorded without its effect.
 *
 * A migration that changed the settings of a role of its store is rolled back and refused.
 * What it left to the end of the transaction, such as a deferred trigger, is made to happen
 * before that is looked at; and the roles are looked at once more after the commit, so a
 * change that still came through is this migration's and no later one's.
 */
export async function applyMigration(
  server: DataStoreServer,
  record: StoreDatabase,
  migration: DataStoreMigration,
  ledgerKey: string,
  signal: AbortSignal
): Promise<void> {
  const roles = [{ type: "text[]" as const, value: [record.roles.app, record.roles.migration] }];
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
        await sql.script(heldInTransaction(migration.sql));
        await sql.script("set constraints all immediate");
        if (!rolesAreUnchanged(record, await sql.run(ROLE_STATE, roles))) {
          refusal = new DataStoreMigrationRefusal(false);
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
  const after = await server.executor.query({
    ...server.asPlatform(server.platformDatabase),
    signal,
    sql: ROLE_STATE,
    parameters: roles
  });
  if (!rolesAreUnchanged(record, after.rows)) throw new DataStoreMigrationRefusal(true);
}
