import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import type { DataStoreAppliedMigration, DataStoreRecord } from "@vivd-catalyst/core";
import type { DataStoreMigration } from "./definition";
import { DATA_STORE_ROLE_LIMITS } from "./role-limits";
import { ROLE_STATE, rolesAreUnchanged } from "./roles";
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
          await sql.run(
            "select distinct proof from catalyst.migrations where proof operator(pg_catalog.=) any ($1)",
            [{ type: "text[]", value: [...proofs.keys()] }]
          )
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
  // A mark of this run alone, which the text therefore cannot hold: with a fixed one, a
  // migration that wrote the mark would end the block where it stands.
  let mark: string;
  do {
    mark = `$catalyst_${randomBytes(12).toString("hex")}$`;
  } while (sql.includes(mark));
  return `do ${mark} begin execute '${sql.replaceAll("'", "''")}'; end ${mark}`;
}

/**
 * Makes the platform's own statements of the transaction mean what the database means by
 * them: a migration may have put functions of its own ahead in the search path. Each of
 * those statements names its functions and tables with their schema as well.
 */
const OWN_SEARCH_PATH = "select pg_catalog.set_config('search_path', 'pg_catalog', true)";

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
        await sql.run(OWN_SEARCH_PATH);
        await sql.script("set constraints all immediate");
        // A trigger that fired just now may have set the path again.
        await sql.run(OWN_SEARCH_PATH);
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
