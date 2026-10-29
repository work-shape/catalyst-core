import { createHash, randomBytes } from "node:crypto";
import {
  AppError,
  DATA_STORE_ACTIONS,
  DATA_STORE_ASSET_KIND,
  DATA_STORE_OPERATION_PREFIX,
  auditActorFromIdentity,
  type AuditActor,
  type AuditRecorder,
  type DataStoreAppliedMigration,
  type DataStoreRecord,
  type DataStoreTestCopy,
  type DraftTestTarget,
  type OperationDefinition,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { z } from "zod";
import {
  dataStoreDefinitionSchema,
  migrationFileName,
  type DataStoreDefinition,
  type DataStoreSeedFile
} from "./definition";
import { describeDatabaseFailure } from "./failures";
import { DataStoreMigrationRefusal, applyMigration, heldInTransaction } from "./migrating";
import { provisionDataStore } from "./provisioning";
import { DATA_STORE_ROLE_LIMITS } from "./role-limits";
import { platformIsSuperuser, writeStoreRoles } from "./roles";
import type { DataStoreRuntime } from "./runtime";
import { leadingWords, splitSeedStatements } from "./seed-statements";
import { quoteIdentifier, testCopyDatabaseOf } from "./server";
import { storeSizeBytes } from "./size";
import type { PublishedStore } from "./verbs";

// The test copy of a store (ADR-0031, DT-2): a scratch database beside the store's own, built
// from the migrations of the store's draft and its `seed/` files and never from a live row.
// Every call of a draft to the store goes there once it exists, and a draft's first changing
// call makes it. It is reached as the store's own two roles, under their statement timeouts and
// connection limits, so a copy needs no credential of its own and counts toward the store's.
//
// Who builds, changes or drops a copy holds the store's copy turn (`getTestCopy` with `lock`)
// in a transaction of the platform's rows, from reading the record to writing it: two first
// calls at once build one copy, and a reset waits for a build that runs.

/** The size limit of a test copy where release config names none: 500 MB. */
export const DEFAULT_TEST_COPY_SIZE_LIMIT_BYTES = 500 * 1024 ** 2;

/**
 * How long building a copy, or bringing it to its draft, may take before it fails. Its own and
 * not the call's: a build that outlasts the call that asked for it still serves the next one.
 */
const TEST_COPY_BUILD_TIMEOUT_MS = 15 * 60_000;
/** How long dropping a copy's database may take. */
const TEST_COPY_DROP_TIMEOUT_MS = 120_000;

/** The size limit of a store's copy: release config's, never above the store's own. */
export function testCopySizeLimit(
  runtime: Pick<DataStoreRuntime, "limits">,
  record: Pick<DataStoreRecord, "sizeLimitBytes">
): number {
  return Math.min(
    runtime.limits.testCopySizeLimitBytes ?? DEFAULT_TEST_COPY_SIZE_LIMIT_BYTES,
    record.sizeLimitBytes
  );
}

/** Whether a call of a draft finds the store's copy, or would make it with a change. */
export async function testCopyState(
  runtime: DataStoreRuntime,
  store: PublishedStore
): Promise<DraftTestTarget> {
  const copy = await runtime.stores.dataStores.getTestCopy({
    clientInstanceId: runtime.clientInstanceId,
    storeId: store.record.id
  });
  return copy ? "present" : "made_on_change";
}

/** The definition a draft of the store holds now: its newest revision, published or not. */
async function draftDefinition(
  runtime: DataStoreRuntime,
  stores: PlatformStores,
  store: PublishedStore
): Promise<DataStoreDefinition> {
  const asset = await stores.configAssets.getConfigAsset({
    clientInstanceId: runtime.clientInstanceId,
    kind: DATA_STORE_ASSET_KIND,
    name: store.record.name
  });
  const draft = asset?.id === store.record.id && dataStoreDefinitionSchema.safeParse(asset.config);
  return draft && draft.success ? draft.data : store.definition;
}

/** The SHA-256 over the seed files in their order, each by its path and its own SHA-256. */
function seedSha256(seed: readonly DataStoreSeedFile[]): string {
  return createHash("sha256")
    .update(seed.map((file) => `${file.path}\n${file.sha256}`).join("\n"))
    .digest("hex");
}

const appliedOf = ({ number, name, sha256 }: DataStoreAppliedMigration) => ({
  number,
  name,
  sha256
});

type Plan =
  | { kind: "none" }
  | { kind: "append"; from: number }
  | { kind: "build"; reason: "made" | "rebuilt" | "reset" };

/**
 * What a copy needs to serve the draft. One built from a migration or seed file the draft no
 * longer holds as it was is built again; one the draft only appended migrations to gets them.
 */
function planOf(
  copy: DataStoreTestCopy | undefined,
  databaseExists: boolean,
  definition: DataStoreDefinition,
  seed: string,
  reset: boolean
): Plan {
  if (reset) return { kind: "build", reason: "reset" };
  if (!copy) return { kind: "build", reason: "made" };
  const kept =
    databaseExists &&
    copy.seedSha256 === seed &&
    copy.migrations.every((applied, index) => {
      const now = definition.migrations[index];
      return now?.number === applied.number && now.sha256 === applied.sha256;
    });
  if (!kept) return { kind: "build", reason: "rebuilt" };
  return definition.migrations.length > copy.migrations.length
    ? { kind: "append", from: copy.migrations.length }
    : { kind: "none" };
}

/** Why a copy could not be built, as the call that asked for it is answered. */
class TestCopyFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly file?: string,
    readonly sqlState?: string
  ) {
    super(message);
    this.name = "TestCopyFailure";
  }
}

/** The store's record as the verbs read it, with the copy's database, level and limit. */
function copyStore(
  runtime: DataStoreRuntime,
  store: PublishedStore,
  copy: DataStoreTestCopy,
  definition: DataStoreDefinition
): PublishedStore {
  const { failure: _live, ...record } = store.record;
  return {
    ...store,
    definition,
    record: {
      ...record,
      status: "ready",
      location: { ...record.location, database: copy.database },
      level: copy.migrations.at(-1)?.number ?? 0,
      migrations: copy.migrations,
      sizeLimitBytes: testCopySizeLimit(runtime, store.record),
      ...(copy.sizeBytes === undefined ? {} : { sizeBytes: copy.sizeBytes })
    }
  };
}

/** Whether the server holds the copy's database: a restore of the server leaves it out. */
async function databaseExists(
  runtime: DataStoreRuntime,
  database: string,
  signal: AbortSignal
): Promise<boolean> {
  const read = await runtime.server.executor.query({
    ...runtime.server.asPlatform(runtime.server.platformDatabase),
    signal,
    sql: "select 1 as found from pg_catalog.pg_database where datname operator(pg_catalog.=) $1",
    parameters: [database]
  });
  return read.rows.length > 0;
}

/** Drops the copy's database with the sessions still on it, where it is there. */
export async function dropTestCopyDatabase(
  runtime: DataStoreRuntime,
  database: string,
  signal?: AbortSignal
): Promise<void> {
  runtime.callRecords.delete(database);
  await runtime.server.executor.change(
    {
      ...runtime.server.asPlatform(runtime.server.platformDatabase),
      timeoutMs: TEST_COPY_DROP_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
      // `drop database` runs in no transaction.
      transaction: false
    },
    (sql) => sql.script(`drop database if exists ${quoteIdentifier(database)} with (force)`)
  );
}

/**
 * Runs the seed files on the copy as the store's app role, in one transaction, each statement
 * on its own so a failure names it. The app role adds rows and changes no schema, so a seed
 * file that makes a table fails here.
 */
async function loadSeed(
  runtime: DataStoreRuntime,
  record: Pick<DataStoreRecord, "id" | "location" | "roles">,
  seed: readonly DataStoreSeedFile[],
  stores: PlatformStores,
  signal: AbortSignal
): Promise<void> {
  for (const file of seed) {
    const statements = splitSeedStatements(file.sql);
    let at = 0;
    try {
      await runtime.server.executor.change(
        {
          ...runtime.server.asRole(record, "app", stores.connections),
          timeoutMs: DATA_STORE_ROLE_LIMITS.app.statementTimeoutMs,
          signal
        },
        async (sql) => {
          for (const [index, statement] of statements.entries()) {
            at = index;
            await sql.script(heldInTransaction(statement));
          }
        }
      );
    } catch (error) {
      const statement = statements[at];
      const named = `'${file.path}' at statement ${at + 1}${statement ? ` ("${leadingWords(statement)}")` : ""}`;
      const failure = describeDatabaseFailure(error, named);
      throw new TestCopyFailure("seed_failed", failure.sentence, file.path, failure.sqlState);
    }
  }
}

/** Applies migrations to the copy as the store's migration role, each in its own transaction. */
async function applyMigrations(
  runtime: DataStoreRuntime,
  record: Pick<DataStoreRecord, "id" | "location" | "roles">,
  migrations: DataStoreDefinition["migrations"],
  held: { stores: PlatformStores; superuser: boolean; sizeLimitBytes: number },
  signal: AbortSignal
): Promise<void> {
  // The copy's record of applied migrations is the platform's row of the copy; its ledger in
  // the database is written as for any store and never read, so a key of this build signs it.
  const ledgerKey = randomBytes(32).toString("hex");
  for (const migration of migrations) {
    const file = `'${migrationFileName(migration)}'`;
    try {
      await applyMigration(
        runtime.server,
        record,
        migration,
        {
          secretRows: held.stores.connections,
          ledgerKey,
          superuser: held.superuser,
          sizeLimitBytes: held.sizeLimitBytes
        },
        signal
      );
    } catch (error) {
      if (error instanceof DataStoreMigrationRefusal) {
        throw new TestCopyFailure(
          error.code,
          error.code === "data_store_size_limit"
            ? `${file} would leave the test copy at ${error.sizeBytes} bytes, over its size limit of ${held.sizeLimitBytes} bytes.`
            : `${file} changed the settings of a role of its store.`,
          migrationFileName(migration)
        );
      }
      const failure = describeDatabaseFailure(error, file);
      throw new TestCopyFailure(
        "migration_failed",
        failure.sentence,
        migrationFileName(migration),
        failure.sqlState
      );
    }
  }
}

interface Reached {
  store: PublishedStore;
  built?: { reason: "made" | "rebuilt" | "reset"; copy: DataStoreTestCopy };
  failed?: TestCopyFailure;
}

/**
 * Brings the store's copy to its draft under the copy's turn and answers the store as the verbs
 * reach the copy: built where there is none or where `reset` asks, built again where a migration
 * or seed file it was built from changed, the draft's new migrations applied otherwise. A build
 * that fails leaves no copy: its database is dropped and its record removed, and the call is
 * refused with the file and statement it stopped at.
 */
async function bringToDraft(
  runtime: DataStoreRuntime,
  store: PublishedStore,
  by: string,
  reset: boolean
): Promise<Reached> {
  const { clientInstanceId } = runtime;
  const { record } = store;
  const database = testCopyDatabaseOf(record.location.database);
  const signal = AbortSignal.timeout(TEST_COPY_BUILD_TIMEOUT_MS);
  return runtime.stores.transaction(async (stores): Promise<Reached> => {
    const copy = await stores.dataStores.getTestCopy({
      clientInstanceId,
      storeId: record.id,
      lock: true
    });
    const definition = await draftDefinition(runtime, stores, store);
    const seed = definition.seed ?? [];
    const seedHash = seedSha256(seed);
    const exists = copy !== undefined && (await databaseExists(runtime, database, signal));
    const plan = planOf(copy, exists, definition, seedHash, reset);
    if (plan.kind === "none" && copy) {
      return { store: copyStore(runtime, store, copy, definition) };
    }
    const sizeLimitBytes = testCopySizeLimit(runtime, record);
    const copyRecord = { ...record, location: { ...record.location, database } };
    try {
      const passwords = {
        app: await runtime.credentials.ensure(stores.connections, record.id, "app"),
        migration: await runtime.credentials.ensure(stores.connections, record.id, "migration")
      };
      const superuser = await platformIsSuperuser(runtime.server, signal);
      const held = { stores, superuser, sizeLimitBytes };
      if (plan.kind === "append") {
        await writeStoreRoles(runtime.server, copyRecord, passwords, signal);
        await applyMigrations(
          runtime,
          copyRecord,
          definition.migrations.slice(plan.from),
          held,
          signal
        );
      } else {
        await dropTestCopyDatabase(runtime, database, signal);
        await provisionDataStore(runtime.server, copyRecord, passwords, stores.connections, signal);
        await applyMigrations(runtime, copyRecord, definition.migrations, held, signal);
        await loadSeed(runtime, copyRecord, seed, stores, signal);
      }
      // A migration may have changed a role's password: the roles are the platform's again.
      await writeStoreRoles(runtime.server, copyRecord, passwords, signal);
      const sizeBytes = await storeSizeBytes(runtime.server, database, signal);
      if (sizeBytes > sizeLimitBytes) {
        throw new TestCopyFailure(
          "data_store_size_limit",
          `The test copy holds ${sizeBytes} bytes after its seed files, over its size limit of ${sizeLimitBytes} bytes.`
        );
      }
      const now = new Date().toISOString();
      const next: DataStoreTestCopy = {
        storeId: record.id,
        clientInstanceId,
        database,
        migrations: definition.migrations.map(appliedOf),
        seedSha256: plan.kind === "append" && copy ? copy.seedSha256 : seedHash,
        seedFiles: plan.kind === "append" && copy ? copy.seedFiles : seed.length,
        sizeBytes,
        builtAt: plan.kind === "append" && copy ? copy.builtAt : now,
        builtBy: plan.kind === "append" && copy ? copy.builtBy : by,
        createdAt: copy?.createdAt ?? now,
        updatedAt: now
      };
      await stores.dataStores.putTestCopy(next);
      return {
        store: copyStore(runtime, store, next, definition),
        ...(plan.kind === "build" ? { built: { reason: plan.reason, copy: next } } : {})
      };
    } catch (error) {
      const failed =
        error instanceof TestCopyFailure
          ? error
          : new TestCopyFailure(
              "build_failed",
              describeDatabaseFailure(error, "Building the test copy").sentence
            );
      // Nothing of a copy that failed stays: the next changing call of a draft builds it anew.
      await dropTestCopyDatabase(runtime, database).catch(() =>
        runtime.logger.warn({ storeId: record.id }, "A failed test copy could not be dropped")
      );
      await stores.dataStores.deleteTestCopy({ clientInstanceId, storeId: record.id });
      // Answered and not thrown, so the removal of the record is kept.
      return { store, failed };
    }
  });
}

/** The refusal of a call whose copy could not be built. */
function buildRefusal(store: PublishedStore, failure: TestCopyFailure): AppError {
  return new AppError(
    "VALIDATION_FAILED",
    `The test copy of the Data Store '${store.record.name}' could not be built, so the draft's call did not run. ${failure.message} The copy is left unbuilt; fix the draft and call again.`,
    {
      reason: "test_copy_build_failed",
      code: failure.code,
      ...(failure.file ? { file: failure.file } : {})
    },
    { exposeMessage: true }
  );
}

async function auditOutcome(
  audit: Pick<AuditRecorder, "record">,
  actor: AuditActor,
  store: PublishedStore,
  reached: Reached,
  correlationId: string
): Promise<void> {
  const base = { actor, subject: store.record.id, correlationId };
  if (reached.failed) {
    await audit.record({
      ...base,
      type: "data_store.test_copy_failed",
      status: "failed",
      reason: reached.failed.code,
      metadata: {
        name: store.record.name,
        code: reached.failed.code,
        ...(reached.failed.file ? { file: reached.failed.file } : {}),
        ...(reached.failed.sqlState ? { sqlState: reached.failed.sqlState } : {})
      }
    });
  } else if (reached.built) {
    await audit.record({
      ...base,
      type: "data_store.test_copy_built",
      status: "success",
      metadata: {
        name: store.record.name,
        reason: reached.built.reason,
        level: reached.built.copy.migrations.at(-1)?.number ?? 0,
        seedFiles: reached.built.copy.seedFiles
      }
    });
  }
}

/** Who acts on a copy, for its audit events and its record. */
interface CopyActor {
  id: string;
  audit: AuditActor;
  recorder: Pick<AuditRecorder, "record">;
  correlationId: string;
}

/**
 * The store as a call of a draft reaches it: its copy, made at this call where there is none,
 * and brought to the draft's migrations and seed files first.
 */
export async function reachTestCopy(
  runtime: DataStoreRuntime,
  store: PublishedStore,
  actor: CopyActor
): Promise<PublishedStore> {
  const reached = await bringToDraft(runtime, store, actor.id, false);
  await auditOutcome(actor.recorder, actor.audit, store, reached, actor.correlationId);
  if (reached.failed) throw buildRefusal(store, reached.failed);
  return reached.store;
}

/** Drops the store's copy and builds it again from the draft (`data_store.write`). */
export async function resetTestCopy(
  runtime: DataStoreRuntime,
  store: PublishedStore,
  actor: CopyActor
): Promise<DataStoreTestCopy> {
  const reached = await bringToDraft(runtime, store, actor.id, true);
  await auditOutcome(actor.recorder, actor.audit, store, reached, actor.correlationId);
  if (reached.failed) throw buildRefusal(store, reached.failed);
  const copy = reached.built?.copy;
  if (!copy) throw new AppError("INTERNAL", "The test copy was not built");
  return copy;
}

/**
 * Drops the store's copy and removes its record, until the next changing call of a draft.
 * Answers whether there was one. `reason` is `store_deleted` where the store's asset went.
 */
export async function deleteTestCopy(
  runtime: DataStoreRuntime,
  store: Pick<DataStoreRecord, "id" | "name" | "location">,
  actor: Partial<CopyActor> & Pick<CopyActor, "recorder" | "correlationId">,
  reason: "deleted" | "store_deleted",
  signal?: AbortSignal
): Promise<boolean> {
  const { clientInstanceId } = runtime;
  const database = testCopyDatabaseOf(store.location.database);
  const had = await runtime.stores.transaction(async (stores) => {
    const copy = await stores.dataStores.getTestCopy({
      clientInstanceId,
      storeId: store.id,
      lock: true
    });
    // Dropped also without a record: a build cut off before it wrote one leaves a database.
    await dropTestCopyDatabase(runtime, database, signal);
    if (copy) await stores.dataStores.deleteTestCopy({ clientInstanceId, storeId: store.id });
    return copy !== undefined;
  });
  if (had) {
    await actor.recorder.record({
      type: "data_store.test_copy_deleted",
      status: "success",
      subject: store.id,
      ...(actor.audit ? { actor: actor.audit } : {}),
      correlationId: actor.correlationId,
      metadata: { name: store.name, reason }
    });
  }
  return had;
}

/** The copy of a store as its page shows it. */
export const testCopyStateSchema = z.object({
  /** The number of the last migration the copy has applied, draft ones included. */
  level: z.number().int(),
  seedFiles: z.number().int(),
  /** When it was last built from nothing: by a first call, a reset or a rebuild. */
  builtAt: z.string(),
  bytes: z.number().int().optional(),
  limitBytes: z.number().int()
});

export function testCopyStateOf(
  runtime: Pick<DataStoreRuntime, "limits">,
  record: Pick<DataStoreRecord, "sizeLimitBytes">,
  copy: DataStoreTestCopy
): z.infer<typeof testCopyStateSchema> {
  return {
    level: copy.migrations.at(-1)?.number ?? 0,
    seedFiles: copy.seedFiles,
    builtAt: copy.builtAt,
    ...(copy.sizeBytes === undefined ? {} : { bytes: copy.sizeBytes }),
    limitBytes: testCopySizeLimit(runtime, record)
  };
}

/** Who acts on a copy in the call of an operation. */
export function copyActorOf(context: {
  actor: Parameters<typeof auditActorFromIdentity>[0];
  audit: Pick<AuditRecorder, "record">;
  correlationId: string;
}): CopyActor {
  return {
    id: context.actor.id,
    audit: auditActorFromIdentity(context.actor),
    recorder: context.audit,
    correlationId: context.correlationId
  };
}

/** The parts of the operations that reset and delete a store's copy, `data_store.<id>.<part>`. */
export const TEST_COPY_PARTS = ["test_copy.reset", "test_copy.delete"] as const;
export type TestCopyPart = (typeof TEST_COPY_PARTS)[number];

const testCopyResultSchema = z.object({ testCopy: testCopyStateSchema.nullable() });

/**
 * Reset or delete of a store's copy: each needs `data_store.write` on the store, as changing
 * the store's draft does. Neither has a test target of its own, so a draft's call of either is
 * simulated; a person calls them on the store's page or with the CLI.
 */
export function testCopyOperation(
  runtime: DataStoreRuntime,
  store: PublishedStore,
  part: TestCopyPart,
  module: string
): OperationDefinition {
  return {
    name: `${DATA_STORE_OPERATION_PREFIX}${store.record.name}.${part}`,
    effect: "changing",
    action: DATA_STORE_ACTIONS.write,
    scope: "config_assets:write",
    auth: "principal",
    inputSchema: z.strictObject({}),
    outputSchema: testCopyResultSchema,
    resource: () => store.resource,
    module,
    timeoutMs: TEST_COPY_BUILD_TIMEOUT_MS,
    async execute(_input, context) {
      const actor = copyActorOf(context);
      if (part === "test_copy.delete") {
        await deleteTestCopy(runtime, store.record, actor, "deleted", context.runtime.signal);
        return { testCopy: null };
      }
      const copy = await resetTestCopy(runtime, store, actor);
      return { testCopy: testCopyStateOf(runtime, store.record, copy) };
    }
  };
}
