import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  isAppError,
  type ConnectionsStore,
  type DataStoreAppliedMigration,
  type DataStoreRecord,
  type DataStoreRecordsRule
} from "@work-shape/catalyst-core";
import type { DataStoreMigration } from "./definition";
import { checkRecordsKeys } from "./records/publish";
import { DATA_STORE_ROLE_LIMITS } from "./role-limits";
import { ROLE_STATE, roleNames, rolesAreUnchanged } from "./roles";
import { storeSizeBytes } from "./size";
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
  readonly code: "migration_changed_role" | "data_store_size_limit" | "record_key_invalid";
  /** Whether the migration was applied all the same: its role changed only as it committed. */
  readonly applied: boolean;
  /** The size the store's database had with the migration, where that is why it was refused. */
  readonly sizeBytes?: number;

  constructor(
    code: DataStoreMigrationRefusal["code"],
    detail: { applied?: true; sizeBytes?: number; message?: string } = {}
  ) {
    super(detail.message ?? code);
    this.name = "DataStoreMigrationRefusal";
    this.code = code;
    this.applied = detail.applied ?? false;
    if (detail.sizeBytes !== undefined) this.sizeBytes = detail.sizeBytes;
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
 * them: a migration may have put functions, types and operators of its own ahead in the
 * search path, also in the schema of temporary objects, which is searched first unless it is
 * named last. Each of those statements names what it uses with its schema as well.
 */
const OWN_SEARCH_PATH =
  "select pg_catalog.set_config('search_path'::pg_catalog.text, 'pg_catalog, pg_temp'::pg_catalog.text, true)";

/**
 * Applies one migration as the migration role: the file's statements and the row that records
 * it, in one transaction. Either both are there afterwards or neither is, so a migration is
 * never applied twice and never recorded without its effect.
 *
 * Before the transaction ends, what the migration left to its end, such as a deferred trigger,
 * is made to happen. Then two things are looked at, and the migration is rolled back and
 * refused where one does not hold: the roles of the store carry what the platform gave them,
 * and the store's database, which the migration made larger, is within its size limit. The
 * size is read on a connection of the platform's own. The roles are looked at once more after
 * the commit, so a change that still came through is this migration's and no later one's.
 */
export async function applyMigration(
  server: DataStoreServer,
  record: StoreDatabase,
  migration: DataStoreMigration,
  held: {
    secretRows: ConnectionsStore;
    ledgerKey: string;
    superuser: boolean;
    sizeLimitBytes: number;
    records?: readonly DataStoreRecordsRule[];
  },
  signal: AbortSignal
): Promise<void> {
  const database = record.location.database;
  const before = await storeSizeBytes(server, database, signal);
  // Whatever a change throws leaves it as a failure of the database, so the refusal is kept
  // here and raised once the change has rolled back.
  let refusal: DataStoreMigrationRefusal | undefined;
  const refuse = (raised: DataStoreMigrationRefusal): never => {
    refusal = raised;
    throw raised;
  };
  try {
    await server.executor.change(
      {
        ...server.asRole(record, "migration", held.secretRows),
        timeoutMs: DATA_STORE_ROLE_LIMITS.migration.statementTimeoutMs,
        signal
      },
      async (sql) => {
        await sql.script(heldInTransaction(migration.sql));
        await sql.run(OWN_SEARCH_PATH);
        await sql.script("set constraints all immediate");
        // A trigger that fired just now may have set the path again.
        await sql.run(OWN_SEARCH_PATH);
        try {
          await checkRecordsKeys(sql, held.records);
        } catch (error) {
          if (isAppError(error) && error.code === "VALIDATION_FAILED") {
            refuse(new DataStoreMigrationRefusal("record_key_invalid", { message: error.message }));
          }
          throw error;
        }
        const roles = await sql.run(ROLE_STATE, roleNames(record));
        if (!rolesAreUnchanged(record, held.superuser, roles)) {
          refuse(new DataStoreMigrationRefusal("migration_changed_role"));
        }
        const sizeBytes = await storeSizeBytes(server, database, signal);
        if (sizeBytes > held.sizeLimitBytes && sizeBytes > before) {
          refuse(new DataStoreMigrationRefusal("data_store_size_limit", { sizeBytes }));
        }
        const applied = {
          number: migration.number,
          name: migration.name,
          sha256: migration.sha256
        };
        await sql.run(
          "insert into catalyst.migrations (number, name, sha256, proof) values ($1::pg_catalog.int4, $2::pg_catalog.text, $3::pg_catalog.text, $4::pg_catalog.text)",
          [
            { type: "integer", value: applied.number },
            applied.name,
            applied.sha256,
            proofOf(held.ledgerKey, applied)
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
    parameters: roleNames(record)
  });
  if (!rolesAreUnchanged(record, held.superuser, after.rows)) {
    throw new DataStoreMigrationRefusal("migration_changed_role", { applied: true });
  }
}
