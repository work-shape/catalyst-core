import { z } from "zod";
import {
  AppError,
  DATA_STORE_ASSET_KIND,
  DATA_STORE_JOB_KINDS,
  DATA_STORE_MANIFEST_FILE,
  KNOWLEDGE_BASE_ASSET_KIND,
  NonRetryableJobError,
  claimSubjectRow,
  defineJobHandler,
  defineJobKind,
  defineSchedule,
  scheduledJobPayloadSchema,
  subjectDedupeKey,
  type DataStoreCondition,
  type DataStoreFailure,
  type DataStoreRecord,
  type Job,
  type JobControl,
  type JobRetry,
  type JobSchedule,
  type PlatformStores,
  type RegisteredJobHandler
} from "@work-shape/catalyst-core";
import {
  appliedMigrationIssue,
  dataStoreDefinitionSchema,
  migrationFileName,
  type DataStoreDefinition
} from "./definition";
import { describeDatabaseFailure } from "./failures";
import { KNOWLEDGE_STORE_LEVEL, applyKnowledgeStoreSchema } from "./knowledge/builtin/store-schema";
import { knowledgeBaseDefinitionSchema } from "./knowledge/definition";
import { DataStoreMigrationRefusal, applyMigration, readSignedMigrations } from "./migrating";
import {
  DataStoreProvisioningError,
  dropStoreDatabase,
  ensureStoreSchema,
  ensureVectorExtension,
  provisionDataStore,
  readStoreConditions
} from "./provisioning";
import { platformIsSuperuser, writeStoreRoles } from "./roles";
import type { DataStoreRuntime } from "./runtime";
import { measureDataStores, recordStoreSize } from "./size";

// The jobs that bring a store's database to its published revision. Publishing writes the
// store's record and enqueues in the same transaction; the handlers read the record anew,
// work on the database outside of any transaction and write each outcome onto the record.

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;

/**
 * How often provisioning and a migration are tried while the database server is busy or away,
 * with waits that double from 5 seconds up to 2 minutes. An error another attempt cannot mend
 * ends the job at once. Publishing again queues a new job.
 */
const DATA_STORE_JOB_MAX_ATTEMPTS = 5;
const DATA_STORE_JOB_BACKOFF = { baseMs: 5 * SECOND_MS, maxMs: 2 * MINUTE_MS } as const;
/** A job whose lease is this old without a heartbeat lost its process. */
const DATA_STORE_JOB_LEASE_MS = 2 * MINUTE_MS;
/** How many stores are provisioned or migrated at once across the instance, and in one process. */
const DATA_STORE_JOBS_MAX_RUNNING = 4;
const DATA_STORE_JOB_SLOTS = 2;
/** How often the size of every store is measured. */
const DATA_STORE_MEASURE_INTERVAL_MS = 24 * 60 * MINUTE_MS;
/**
 * How often the stores Knowledge Bases own are checked against the release's tables, besides
 * at each start. How many stores one check reads.
 */
const DATA_STORE_UPGRADE_INTERVAL_MS = 24 * 60 * MINUTE_MS;
const DATA_STORE_UPGRADE_MAX_STORES = 2_000;

const storePayloadSchema = z.object({ storeId: z.string().min(1).max(200) });
type StorePayload = z.infer<typeof storePayloadSchema>;

const storeJob = {
  payloadSchema: storePayloadSchema,
  maxAttempts: DATA_STORE_JOB_MAX_ATTEMPTS,
  backoff: DATA_STORE_JOB_BACKOFF,
  leaseMs: DATA_STORE_JOB_LEASE_MS,
  concurrency: { global: DATA_STORE_JOBS_MAX_RUNNING, perKey: 1 }
} as const;

/** Creates the database and the roles of one store. The payload names the store and holds nothing of it. */
const provisionJob = defineJobKind({ ...storeJob, kind: DATA_STORE_JOB_KINDS.provision });

/**
 * Applies the migrations the published revision of one store has and its database lacks. For
 * the store a Knowledge Base owns, they are the platform's tables of this release.
 */
const migrateJob = defineJobKind({ ...storeJob, kind: DATA_STORE_JOB_KINDS.migrate });

/** Drops the database, the roles and the record of a store whose Knowledge Base was deleted. */
const dropJob = defineJobKind({ ...storeJob, kind: DATA_STORE_JOB_KINDS.drop });

const measureSizeJob = defineJobKind({
  kind: DATA_STORE_JOB_KINDS.measureSize,
  payloadSchema: scheduledJobPayloadSchema,
  maxAttempts: 1,
  backoff: { baseMs: 0, maxMs: 0 },
  leaseMs: 10 * MINUTE_MS,
  concurrency: { global: 1 },
  manualRetry: false
});

/**
 * Queues the migration of every store a Knowledge Base owns whose tables are behind the
 * release. Due at each start, so a store an earlier release made gets the tables of this one
 * without a publish: an operation that needs them refuses until then.
 */
const upgradeOwnedJob = defineJobKind({
  kind: DATA_STORE_JOB_KINDS.upgradeOwned,
  payloadSchema: scheduledJobPayloadSchema,
  maxAttempts: 1,
  backoff: { baseMs: 0, maxMs: 0 },
  leaseMs: 10 * MINUTE_MS,
  concurrency: { global: 1 },
  manualRetry: false
});

/**
 * Queues the job that brings a store to its published revision: provisioning while it has no
 * database, a migration after. While one is queued for the store this inserts nothing.
 * `behind` names a job that is running and has read the published revision already: the new
 * one is then queued under the store's second key, and runs once that one ended.
 */
export async function enqueueStoreJob(
  stores: Pick<PlatformStores, "jobs">,
  record: Pick<DataStoreRecord, "id" | "clientInstanceId" | "status">,
  behind?: Pick<Job, "dedupeKey">
): Promise<void> {
  const kind = record.status === "provisioning" ? provisionJob : migrateJob;
  const first = subjectDedupeKey(kind.kind, record.id);
  await stores.jobs.enqueue(
    kind,
    { storeId: record.id },
    {
      clientInstanceId: record.clientInstanceId,
      subject: record.id,
      dedupeKey: behind?.dedupeKey === first ? `${first}:next` : first,
      concurrencyKey: record.id
    }
  );
}

/**
 * Queues the job that drops the store a deleted Knowledge Base owned. While one is queued for
 * the store this inserts nothing.
 */
export async function enqueueStoreDrop(
  stores: Pick<PlatformStores, "jobs">,
  record: Pick<DataStoreRecord, "id" | "clientInstanceId">
): Promise<void> {
  await stores.jobs.enqueue(
    dropJob,
    { storeId: record.id },
    {
      clientInstanceId: record.clientInstanceId,
      subject: record.id,
      dedupeKey: subjectDedupeKey(dropJob.kind, record.id),
      concurrencyKey: record.id
    }
  );
}

/**
 * What publishing a revision of a store does beside moving the published pointer, in the same
 * transaction: it writes the store's record and queues the job. It throws, and so refuses the
 * publish, where the revision changes a migration the store has applied, and where the id is
 * still held by a retired store.
 */
export async function publishDataStore(
  runtime: Pick<DataStoreRuntime, "clientInstanceId" | "server" | "limits">,
  stores: PlatformStores,
  input: { storeId: string; revision: number; definition: DataStoreDefinition }
): Promise<void> {
  const { clientInstanceId, server, limits } = runtime;
  const { storeId, definition } = input;
  const asset = await stores.configAssets.getConfigAsset({
    clientInstanceId,
    kind: DATA_STORE_ASSET_KIND,
    name: definition.name
  });
  const owner = asset?.scope.kind ?? "instance";
  if (definition.scope !== undefined && definition.scope !== owner) {
    throw new AppError(
      "VALIDATION_FAILED",
      `'${DATA_STORE_MANIFEST_FILE}' says scope '${definition.scope}' and the store belongs to ${owner === "instance" ? "the instance" : "a workspace"}. Write the store for ${definition.scope === "instance" ? "the instance" : "a workspace"}, or change 'scope'.`,
      { reason: "scope_mismatch" }
    );
  }
  const held = await stores.dataStores.findDataStoreByName({
    clientInstanceId,
    name: definition.name
  });
  if (held && held.id !== storeId) {
    throw new AppError(
      "CONFLICT",
      `The id '${definition.name}' is held by a retired Data Store whose database still exists. It is free once that store is dropped.`,
      { reason: "data_store_id_held" }
    );
  }
  const current = await stores.dataStores.getDataStore({
    clientInstanceId,
    id: storeId,
    lock: true
  });
  const issue = current && appliedMigrationIssue(current.migrations, definition);
  if (issue) {
    throw new AppError("VALIDATION_FAILED", issue, { reason: "applied_migration_changed" });
  }
  const now = new Date().toISOString();
  const names = server.namesOf(storeId);
  const record: DataStoreRecord = {
    ...(current ?? {
      id: storeId,
      clientInstanceId,
      name: definition.name,
      status: "provisioning",
      location: { ...server.location, database: names.database },
      roles: { app: names.app, migration: names.migration },
      level: 0,
      migrations: [],
      conditions: [],
      createdAt: now
    }),
    targetRevision: input.revision,
    // The instance's ceiling, which a manifest lowers and never raises.
    sizeLimitBytes: Math.min(
      definition.sizeLimitBytes ?? limits.sizeLimitBytes,
      limits.sizeLimitBytes
    ),
    updatedAt: now
  };
  await stores.dataStores.putDataStore(record);
  await enqueueStoreJob(stores, record);
}

/**
 * What deleting the asset of a store does to the store, in the same transaction: the record
 * is marked retired. The database, the roles and every row stay, and the record keeps the id.
 */
export async function retireDataStore(
  runtime: Pick<DataStoreRuntime, "clientInstanceId">,
  stores: PlatformStores,
  storeId: string
): Promise<void> {
  const record = await stores.dataStores.getDataStore({
    clientInstanceId: runtime.clientInstanceId,
    id: storeId,
    lock: true
  });
  if (!record || record.status === "retired") return;
  const now = new Date().toISOString();
  await stores.dataStores.putDataStore({
    ...record,
    status: "retired",
    retiredAt: now,
    updatedAt: now
  });
}

/** Reads the record of a job's store, held for the transaction. A retired store has no work left. */
function claimStore(runtime: DataStoreRuntime, control: JobControl, storeId: string) {
  return claimSubjectRow(control, async (stores) => {
    const row = await stores.dataStores.getDataStore({
      clientInstanceId: runtime.clientInstanceId,
      id: storeId,
      lock: true
    });
    return row && row.status !== "retired"
      ? { status: "claimed" as const, row }
      : { status: "finished" as const };
  });
}

/**
 * Writes onto the record what this attempt found, on the record as it is now: another write
 * may have landed since the attempt read it. Answers the record as written, or nothing where
 * the store was retired meanwhile.
 */
function writeOutcome(
  runtime: DataStoreRuntime,
  control: JobControl,
  storeId: string,
  change: (record: DataStoreRecord, stores: PlatformStores) => Promise<DataStoreRecord>
): Promise<DataStoreRecord | undefined> {
  return control.transaction(async (stores) => {
    const record = await stores.dataStores.getDataStore({
      clientInstanceId: runtime.clientInstanceId,
      id: storeId,
      lock: true
    });
    if (!record || record.status === "retired") return undefined;
    const { failure: _cleared, ...kept } = record;
    const next = await change({ ...kept, updatedAt: new Date().toISOString() }, stores);
    await stores.dataStores.putDataStore(next);
    return next;
  });
}

/**
 * Ends an attempt that failed: the failure is written onto the record and audited, and the
 * job is given another attempt only where the database was busy or away.
 */
async function failAttempt(
  runtime: DataStoreRuntime,
  control: JobControl,
  job: Job<StorePayload>,
  event: "data_store.provisioning_failed" | "data_store.migration_failed",
  failure: DataStoreFailure & { retryable: boolean; sqlState?: string }
): Promise<never> {
  // The worker stops or the lease is gone: nothing was decided. The attempt is given back.
  if (control.signal.aborted) {
    throw new AppError("CONFLICT", "The work on a Data Store was stopped");
  }
  const { code, message } = failure;
  const record = await writeOutcome(runtime, control, job.payload.storeId, (current) =>
    Promise.resolve({ ...current, failure: { code, message } })
  );
  const retried = failure.retryable && control.attempt < job.maxAttempts;
  if (record && !retried) {
    await runtime.auditRecorder.record({
      type: event,
      status: "failed",
      subject: record.id,
      reason: code,
      correlationId: job.correlationId,
      metadata: {
        name: record.name,
        level: record.level,
        ...(failure.sqlState === undefined ? {} : { sqlState: failure.sqlState })
      }
    });
  }
  if (failure.retryable) throw new AppError("CONFLICT", message, { reason: code });
  throw new NonRetryableJobError(message, { reason: code });
}

/** The secrets of a store, each made where an earlier attempt did not get that far. */
function storeSecrets(runtime: DataStoreRuntime, control: JobControl, storeId: string) {
  return control.transaction(async (stores) => ({
    app: await runtime.credentials.ensure(stores.connections, storeId, "app"),
    migration: await runtime.credentials.ensure(stores.connections, storeId, "migration"),
    ledger: await runtime.credentials.ensure(stores.connections, storeId, "ledger")
  }));
}

/**
 * Measures a store whose database was just made or changed, so the size limit holds from the
 * first insert. A store that cannot be measured now is measured by the first insert.
 */
async function measureNow(
  runtime: DataStoreRuntime,
  control: JobControl,
  record: DataStoreRecord
): Promise<void> {
  await recordStoreSize(runtime, (work) => control.transaction(work), record, control.signal).catch(
    () =>
      runtime.logger.warn({ storeId: record.id }, "The size of a Data Store could not be measured")
  );
}

function provisioningFailure(error: unknown): DataStoreFailure & { retryable: boolean } {
  if (error instanceof DataStoreProvisioningError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  const failure = describeDatabaseFailure(error, "Creating the database of the Data Store");
  return failure.sqlState === "42501"
    ? {
        code: "platform_role_lacks_privilege",
        message:
          "The platform's database role may not create the database or the roles of a Data Store. Grant it CREATEDB and CREATEROLE; publishing the store again then provisions it.",
        retryable: false
      }
    : // Every step finds what is there and adds what is missing, so another attempt can only
      // help: two stores provisioned at once may meet on a row of the server's catalog.
      { ...failure, code: "provisioning_failed", message: failure.sentence, retryable: true };
}

async function provision(
  runtime: DataStoreRuntime,
  job: Job<StorePayload>,
  control: JobControl
): Promise<void> {
  const { storeId } = job.payload;
  const claimed = await claimSubjectRow(control, async (stores) => {
    const row = await stores.dataStores.getDataStore({
      clientInstanceId: runtime.clientInstanceId,
      id: storeId,
      lock: true
    });
    return abandoned(row) || row?.status === "provisioning"
      ? { status: "claimed" as const, row: { record: row } }
      : { status: "finished" as const };
  });
  if (!claimed) return;
  const { record } = claimed;
  if (record === undefined || abandoned(record)) {
    return removeAbandoned(runtime, job, control, storeId, record);
  }
  let made: { conditions: DataStoreCondition[] } | { error: unknown };
  try {
    const secrets = await storeSecrets(runtime, control, storeId);
    await provisionDataStore(runtime.server, record, secrets, control.signal);
    made = { conditions: await readStoreConditions(runtime.server, record, control.signal) };
  } catch (error) {
    made = { error };
  }
  // Every CREATE of this attempt is done. A delete that landed meanwhile may have dropped the
  // store before some of them: what is there now goes. A delete that lands after this read
  // queues its drop after them.
  const current = await control.transaction((stores) =>
    stores.dataStores.getDataStore({ clientInstanceId: runtime.clientInstanceId, id: storeId })
  );
  if (!sameStore(current, record)) {
    return removeAbandoned(runtime, job, control, storeId, current);
  }
  if ("error" in made) {
    return failAttempt(
      runtime,
      control,
      job,
      "data_store.provisioning_failed",
      provisioningFailure(made.error)
    );
  }
  const { conditions } = made;
  // Written only onto the record this attempt provisioned, read again under its lock: a delete
  // and a new publish may both have landed since the read above.
  const written = await control.transaction(async (stores) => {
    const latest = await stores.dataStores.getDataStore({
      clientInstanceId: runtime.clientInstanceId,
      id: storeId,
      lock: true
    });
    if (!sameStore(latest, record)) return { replaced: latest };
    if (latest.status !== "provisioning") return { ready: undefined };
    const { failure: _cleared, ...kept } = latest;
    const next: DataStoreRecord = {
      ...kept,
      status: "ready",
      conditions,
      updatedAt: new Date().toISOString()
    };
    await stores.dataStores.putDataStore(next);
    await enqueueStoreJob(stores, next);
    return { ready: next };
  });
  if ("replaced" in written) {
    return removeAbandoned(runtime, job, control, storeId, written.replaced);
  }
  const { ready } = written;
  if (ready) {
    if (ready.conditions.length > 0) {
      runtime.logger.warn(
        { storeId: ready.id, name: ready.name, conditions: ready.conditions },
        "A Data Store is provisioned, and the server leaves open what an operator has to close"
      );
    }
    await measureNow(runtime, control, ready);
    await runtime.auditRecorder.record({
      type: "data_store.provisioned",
      status: "success",
      subject: ready.id,
      correlationId: job.correlationId,
      metadata: { name: ready.name, conditions: ready.conditions }
    });
  }
}

/**
 * Whether nothing wants the database of a store any more: its record is gone, or it is the
 * store of a deleted Knowledge Base. A retired store of its own asset keeps its database.
 */
function abandoned(record: DataStoreRecord | undefined): boolean {
  return (
    record === undefined ||
    (record.status === "retired" && record.ownerKnowledgeBaseId !== undefined)
  );
}

/**
 * Whether the record is still the one an attempt claimed: there, not dropped, and not deleted
 * and made again under the same id meanwhile. `createdAt` is written once, when the record is
 * made, so a record made again has another.
 */
function sameStore(
  current: DataStoreRecord | undefined,
  claimed: DataStoreRecord
): current is DataStoreRecord {
  return current !== undefined && !abandoned(current) && current.createdAt === claimed.createdAt;
}

/** The record was deleted and made again while this attempt worked: the next attempt makes the new one. */
function storeMadeAgain(): AppError {
  return new AppError(
    "CONFLICT",
    "The Data Store was made again while it was provisioned. The next attempt provisions it.",
    { reason: "store_made_again" }
  );
}

/**
 * Drops what provisioning made of a store that was deleted meanwhile, as its drop does. Where
 * the store was made again since, under the same id and so the same names, the job's next
 * attempt provisions the new record: its publish queued no job of its own while this one ran.
 */
async function removeAbandoned(
  runtime: DataStoreRuntime,
  job: Job<StorePayload>,
  control: JobControl,
  storeId: string,
  record: DataStoreRecord | undefined
): Promise<void> {
  runtime.logger.warn(
    { storeId },
    "A Data Store was deleted while it was provisioned; what was made of it is dropped"
  );
  await dropOwnedStore(runtime, job, control, storeId, record);
  const now = await control.transaction((stores) =>
    stores.dataStores.getDataStore({ clientInstanceId: runtime.clientInstanceId, id: storeId })
  );
  if (now?.status === "provisioning") throw storeMadeAgain();
}

/** The published definition of a store, or nothing where its asset is gone or unpublished. */
async function publishedDefinition(
  runtime: DataStoreRuntime,
  record: DataStoreRecord
): Promise<{ revision: number; definition: DataStoreDefinition } | undefined> {
  const asset = await runtime.stores.configAssets.getConfigAsset({
    clientInstanceId: runtime.clientInstanceId,
    kind: DATA_STORE_ASSET_KIND,
    name: record.name
  });
  if (asset?.id !== record.id || asset.status !== "active") return undefined;
  const definition = dataStoreDefinitionSchema.safeParse(asset.publishedConfig);
  return definition.success && asset.publishedRevision !== undefined
    ? { revision: asset.publishedRevision, definition: definition.data }
    : undefined;
}

const count = (migrations: number) => `${migrations} migration${migrations === 1 ? "" : "s"}`;

async function migrate(
  runtime: DataStoreRuntime,
  job: Job<StorePayload>,
  control: JobControl
): Promise<void> {
  const { storeId } = job.payload;
  const record = await claimStore(runtime, control, storeId);
  // A store without a database is migrated by the job its provisioning queues.
  if (!record || record.status !== "ready") return;
  if (record.ownerKnowledgeBaseId !== undefined) {
    return migrateOwnedStore(runtime, job, control, record);
  }
  const published = await publishedDefinition(runtime, record);
  if (!published) return;
  const { definition } = published;
  const fail = (failure: DataStoreFailure & { retryable: boolean; sqlState?: string }) =>
    failAttempt(runtime, control, job, "data_store.migration_failed", failure);
  const unreachable = (error: unknown, doing: string) => {
    const failure = describeDatabaseFailure(error, doing);
    return fail({ ...failure, code: "migration_failed", message: failure.sentence });
  };

  // The platform's record of the store says what is applied. The record in the store's
  // database has to bear it out; where it cannot, nothing is run.
  const issue = appliedMigrationIssue(record.migrations, definition);
  if (issue) return fail({ code: "applied_migration_changed", message: issue, retryable: false });
  const secrets = await control.transaction(async (stores) => ({
    app: await runtime.credentials.ensure(stores.connections, storeId, "app"),
    migration: await runtime.credentials.ensure(stores.connections, storeId, "migration"),
    // A key is made only for a store that has applied nothing: a new key for any other one
    // would read its record as empty.
    ledger: await (record.level === 0
      ? runtime.credentials.ensure(stores.connections, storeId, "ledger")
      : runtime.credentials.read(stores.connections, storeId, "ledger"))
  }));
  const { ledger } = secrets;
  if (ledger === undefined) {
    return fail({
      code: "ledger_key_lost",
      message: `The store has applied ${count(record.level)} and the key that signs its record of them cannot be read from the Secret Store. No migration was run. Restore the Secret Store key the record was written with.`,
      retryable: false
    });
  }
  const known = definition.migrations.map(({ number, name, sha256 }) => ({ number, name, sha256 }));
  let signed;
  let superuser: boolean;
  try {
    // Both roles as the platform gave them, before anything connects as one, and what the
    // platform keeps in the store as this release makes it.
    await writeStoreRoles(runtime.server, record, secrets, control.signal);
    await ensureStoreSchema(runtime.server, record, control.signal);
    superuser = await platformIsSuperuser(runtime.server, control.signal);
    // What the server leaves open is said as it is now, also where it was closed since.
    const conditions = await readStoreConditions(runtime.server, record, control.signal);
    await control.transaction(async (stores) => {
      const current = await stores.dataStores.getDataStore({
        clientInstanceId: runtime.clientInstanceId,
        id: storeId,
        lock: true
      });
      if (current && current.status !== "retired") {
        await stores.dataStores.putDataStore({ ...current, conditions });
      }
    });
    signed = await readSignedMigrations(runtime.server, record, known, ledger, control.signal);
  } catch (error) {
    return unreachable(error, "Reading the level of the Data Store");
  }
  // The signed rows from the first on, as far as they go without a gap. One more than the
  // platform recorded is an attempt that ended between the commit and the platform's own write.
  const reached = signed.findIndex((migration, index) => migration.number !== index + 1);
  const applied = known.slice(0, reached === -1 ? signed.length : reached);
  if (applied.length < record.level) {
    return fail({
      code: "ledger_mismatch",
      message: `The platform has recorded ${record.level} applied migration${record.level === 1 ? "" : "s"} for the store and the record in the store's database holds ${applied.length} of them. No migration was run. The database was changed or restored apart from the platform's record.`,
      retryable: false
    });
  }

  const pending = definition.migrations.slice(applied.length);
  for (const migration of pending) {
    const file = `'${migrationFileName(migration)}'`;
    let failed: (DataStoreFailure & { retryable: boolean; sqlState?: string }) | undefined;
    let appliedNow = true;
    try {
      await applyMigration(
        runtime.server,
        record,
        migration,
        // The limit as the record holds it now: a publish since the job began may have set it.
        {
          ledgerKey: ledger,
          superuser,
          sizeLimitBytes: (
            (await runtime.stores.dataStores.getDataStore({
              clientInstanceId: runtime.clientInstanceId,
              id: storeId
            })) ?? record
          ).sizeLimitBytes
        },
        control.signal
      );
    } catch (error) {
      if (error instanceof DataStoreMigrationRefusal) {
        appliedNow = error.applied;
        failed = {
          code: error.code,
          message:
            error.code === "data_store_size_limit"
              ? `${file} would leave the store at ${error.sizeBytes} bytes, over its size limit (sizeLimit). Nothing of it was applied.`
              : `${file} changed the settings of a role of its store${error.applied ? " as its transaction ended. It is applied, and the roles were set back." : ". Nothing of it was applied."}`,
          retryable: false
        };
      } else {
        appliedNow = false;
        const failure = describeDatabaseFailure(error, file);
        failed = { ...failure, code: "migration_failed", message: failure.sentence };
      }
    }
    // A role may change its own password, and nobody is shown that it did: whatever the
    // migration did, both roles are the platform's again before anything else connects.
    try {
      await writeStoreRoles(runtime.server, record, secrets, control.signal);
    } catch (error) {
      const failure = describeDatabaseFailure(error, "Holding the roles of the Data Store");
      failed ??= { ...failure, code: "migration_failed", message: failure.sentence };
    }
    // The database is another size now, whether the migration stayed or not.
    await measureNow(runtime, control, record);
    if (appliedNow) {
      applied.push({ number: migration.number, name: migration.name, sha256: migration.sha256 });
      const mirrored = [...applied];
      await writeOutcome(runtime, control, storeId, (current) =>
        Promise.resolve({ ...current, level: migration.number, migrations: mirrored })
      );
    }
    if (failed) return fail(failed);
  }
  const done = await writeOutcome(runtime, control, storeId, async (current, stores) => {
    const next = { ...current, level: applied.at(-1)?.number ?? 0, migrations: applied };
    // A revision published while this one was applied: its job is queued behind this one.
    if (current.targetRevision !== published.revision) await enqueueStoreJob(stores, next, job);
    return next;
  });
  if (done && pending.length > 0) {
    await runtime.auditRecorder.record({
      type: "data_store.migrated",
      status: "success",
      subject: done.id,
      correlationId: job.correlationId,
      metadata: { name: done.name, level: done.level, appliedCount: pending.length }
    });
  }
}

/**
 * The published definition of the Knowledge Base that owns a store, or nothing where it is gone,
 * unpublished, or no longer on the built-in backend.
 */
async function owningKnowledgeBase(runtime: DataStoreRuntime, record: DataStoreRecord) {
  if (record.ownerKnowledgeBaseId === undefined) return undefined;
  const asset = await runtime.stores.configAssets.getConfigAsset({
    clientInstanceId: runtime.clientInstanceId,
    kind: KNOWLEDGE_BASE_ASSET_KIND,
    name: record.ownerKnowledgeBaseId
  });
  if (asset?.id !== record.id || asset.status !== "active") return undefined;
  const definition = knowledgeBaseDefinitionSchema.safeParse(asset.publishedConfig);
  return definition.success && !("backend" in definition.data) ? definition.data : undefined;
}

/**
 * Brings the store a Knowledge Base owns to what its published revision needs: pgvector where
 * it searches by meaning, and the platform's tables of this release. Nothing of an author
 * runs: the store has no migrations of its own.
 */
/**
 * Queues the migration of each store a Knowledge Base owns that has its database and a level
 * below the release's. The migration applies the tables of this release, as a publish does.
 */
async function upgradeOwnedStores(runtime: DataStoreRuntime, control: JobControl): Promise<void> {
  const { clientInstanceId, logger } = runtime;
  const records = await runtime.stores.dataStores.listDataStores({
    clientInstanceId,
    limit: DATA_STORE_UPGRADE_MAX_STORES + 1
  });
  if (records.length > DATA_STORE_UPGRADE_MAX_STORES) {
    logger.warn(
      { limit: DATA_STORE_UPGRADE_MAX_STORES, limitName: "DATA_STORE_UPGRADE_MAX_STORES" },
      "More Data Stores exist than one upgrade check reads"
    );
  }
  const behind = records
    .slice(0, DATA_STORE_UPGRADE_MAX_STORES)
    .filter(
      (record) =>
        record.ownerKnowledgeBaseId !== undefined &&
        record.status === "ready" &&
        record.level < KNOWLEDGE_STORE_LEVEL
    );
  if (behind.length === 0) return;
  await control.transaction(async (stores) => {
    for (const record of behind) await enqueueStoreJob(stores, record);
  });
}

async function migrateOwnedStore(
  runtime: DataStoreRuntime,
  job: Job<StorePayload>,
  control: JobControl,
  record: DataStoreRecord
): Promise<void> {
  const owner = await owningKnowledgeBase(runtime, record);
  if (!owner) return;
  try {
    if (owner.methods.includes("semantic")) {
      await ensureVectorExtension(runtime.server, record, control.signal);
    }
  } catch (error) {
    return failAttempt(
      runtime,
      control,
      job,
      "data_store.provisioning_failed",
      provisioningFailure(error)
    );
  }
  let applied;
  try {
    applied = await applyKnowledgeStoreSchema(runtime.server, record, control.signal);
  } catch (error) {
    const failure = describeDatabaseFailure(error, "Making the tables of the Knowledge Base");
    return failAttempt(runtime, control, job, "data_store.migration_failed", {
      ...failure,
      code: "migration_failed",
      message: failure.sentence
    });
  }
  const level = applied.at(-1)?.number ?? 0;
  const done = await writeOutcome(runtime, control, record.id, (current) =>
    Promise.resolve({ ...current, level, migrations: applied })
  );
  if (done && record.level !== level) {
    await runtime.auditRecorder.record({
      type: "data_store.migrated",
      status: "success",
      subject: done.id,
      correlationId: job.correlationId,
      metadata: { name: done.name, level, appliedCount: level - record.level }
    });
  }
}

/**
 * Why the database and the roles of a store may not be dropped: its record names others than
 * the ones its id gives, or the record of another store names them. Nothing where they are
 * its own and no other record's.
 */
async function foreignStoreObjects(
  runtime: DataStoreRuntime,
  stores: PlatformStores,
  storeId: string,
  record: DataStoreRecord | undefined
): Promise<{ reason: string; message: string } | undefined> {
  const names = runtime.server.namesOf(storeId);
  if (
    record &&
    (record.location.database !== names.database ||
      record.roles.app !== names.app ||
      record.roles.migration !== names.migration)
  ) {
    return {
      reason: "store_names_not_its_own",
      message:
        "The record of the store names a database or roles other than the ones its id gives. Nothing was dropped: an operator checks the record."
    };
  }
  const naming = await stores.dataStores.listDataStoresNaming({
    clientInstanceId: runtime.clientInstanceId,
    database: names.database,
    roles: [names.app, names.migration]
  });
  if (naming.some((other) => other.id !== storeId)) {
    return {
      reason: "store_names_shared",
      message:
        "The record of another Data Store names the database or a role of this store. Nothing was dropped: an operator checks the records."
    };
  }
  return undefined;
}

/**
 * Drops the database and the two roles the id of a store gives, after reading that they are
 * its own. Where they are not, nothing is dropped, the refusal is logged and audited, and the
 * job fails without another attempt.
 */
async function dropOwnedStore(
  runtime: DataStoreRuntime,
  job: Job<StorePayload>,
  control: JobControl,
  storeId: string,
  record: DataStoreRecord | undefined
): Promise<void> {
  const foreign = await control.transaction((stores) =>
    foreignStoreObjects(runtime, stores, storeId, record)
  );
  if (foreign) {
    runtime.logger.warn(
      { storeId, reason: foreign.reason },
      "The database of a Data Store was not dropped: its names are not its own"
    );
    await runtime.auditRecorder.record({
      type: "data_store.dropped",
      status: "failed",
      subject: storeId,
      reason: foreign.reason,
      correlationId: job.correlationId,
      metadata: { name: record?.name ?? storeId }
    });
    throw new NonRetryableJobError(foreign.message, { reason: foreign.reason });
  }
  try {
    await dropStoreDatabase(runtime.server, storeId, control.signal);
  } catch (error) {
    if (control.signal.aborted)
      throw new AppError("CONFLICT", "The work on a Data Store was stopped");
    const failure = describeDatabaseFailure(
      error,
      "Dropping the store of a deleted Knowledge Base"
    );
    throw new AppError("CONFLICT", failure.sentence, { reason: "drop_failed" });
  }
}

/**
 * Drops the store a deleted Knowledge Base owned: its database with every row in it, its two
 * roles, their secrets, and its record. A store of its own asset is never dropped here: it
 * outlives its asset until an operator removes it.
 */
async function drop(
  runtime: DataStoreRuntime,
  job: Job<StorePayload>,
  control: JobControl
): Promise<void> {
  const { storeId } = job.payload;
  const record = await claimSubjectRow(control, async (stores) => {
    const row = await stores.dataStores.getDataStore({
      clientInstanceId: runtime.clientInstanceId,
      id: storeId,
      lock: true
    });
    return row?.status === "retired" && row.ownerKnowledgeBaseId !== undefined
      ? { status: "claimed" as const, row }
      : { status: "finished" as const };
  });
  if (!record) return;
  await dropOwnedStore(runtime, job, control, storeId, record);
  await control.transaction(async (stores) => {
    for (const secret of ["app", "migration", "ledger"] as const) {
      await runtime.credentials.remove(stores.connections, storeId, secret);
    }
    await stores.dataStores.deleteDataStore({
      clientInstanceId: runtime.clientInstanceId,
      id: storeId
    });
  });
  await runtime.auditRecorder.record({
    type: "data_store.dropped",
    status: "success",
    subject: record.id,
    correlationId: job.correlationId,
    metadata: { name: record.name }
  });
}

/** The handlers, the schedules and the manual retries of the store's job kinds. */
export function createDataStoreJobs(runtime: DataStoreRuntime): {
  handlers: RegisteredJobHandler[];
  schedules: JobSchedule[];
  retries: JobRetry[];
} {
  return {
    handlers: [
      defineJobHandler({
        kind: provisionJob,
        slots: DATA_STORE_JOB_SLOTS,
        run: (job, control) => provision(runtime, job, control)
      }),
      defineJobHandler({
        kind: migrateJob,
        slots: DATA_STORE_JOB_SLOTS,
        run: (job, control) => migrate(runtime, job, control)
      }),
      defineJobHandler({
        kind: measureSizeJob,
        slots: 1,
        run: (_job, control) => measureDataStores(runtime, control)
      }),
      defineJobHandler({
        kind: upgradeOwnedJob,
        slots: 1,
        run: (_job, control) => upgradeOwnedStores(runtime, control)
      }),
      defineJobHandler({
        kind: dropJob,
        slots: DATA_STORE_JOB_SLOTS,
        run: (job, control) => drop(runtime, job, control)
      })
    ],
    schedules: [
      defineSchedule({ kind: measureSizeJob, every: DATA_STORE_MEASURE_INTERVAL_MS }),
      // A store an earlier release made gets this release's tables as soon as it is up.
      defineSchedule({
        kind: upgradeOwnedJob,
        every: DATA_STORE_UPGRADE_INTERVAL_MS,
        dueAtStart: true
      })
    ],
    // Each reads the record, and the published revision, anew.
    retries: [{ kind: provisionJob }, { kind: migrateJob }, { kind: dropJob }]
  };
}
