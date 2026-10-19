import { drop, dropOwnedStore } from "./store-drop";
export { publishDataStore, retireDataStore } from "./store-publishing";
import {
  provisionJob,
  migrateJob,
  dropJob,
  measureSizeJob,
  upgradeOwnedJob,
  measureSizeTickJob,
  upgradeOwnedTickJob,
  measureSizePageJob,
  upgradeOwnedPageJob,
  enqueueStoreJob,
  DATA_STORE_JOB_SLOTS,
  DATA_STORE_MEASURE_INTERVAL_MS,
  DATA_STORE_UPGRADE_INTERVAL_MS,
  type StorePayload
} from "./store-job-kinds";
export { enqueueStoreJob, enqueueStoreDrop } from "./store-job-kinds";
import { upgradeOwnedStores } from "./maintenance";
import { checkRecordsCatalog, readExistingRecordsKeys } from "./records/publish";
import {
  AppError,
  isAppError,
  DATA_STORE_ASSET_KIND,
  KNOWLEDGE_BASE_ASSET_KIND,
  NonRetryableJobError,
  claimSubjectRow,
  defineJobHandler,
  defineSchedule,
  type DataStoreCondition,
  type DataStoreFailure,
  type DataStoreRecord,
  type DataStoreRecordsRule,
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
import { applyKnowledgeStoreSchema } from "./knowledge/builtin/store-schema";
import { knowledgeBaseDefinitionSchema } from "./knowledge/definition";
import { DataStoreMigrationRefusal, applyMigration, readSignedMigrations } from "./migrating";
import {
  DataStoreProvisioningError,
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
    await provisionDataStore(
      runtime.server,
      record,
      secrets,
      runtime.stores.connections,
      control.signal
    );
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
  record: DataStoreRecord,
  stores: PlatformStores = runtime.stores
): Promise<{ revision: number; definition: DataStoreDefinition } | undefined> {
  const asset = await stores.configAssets.getConfigAsset({
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
  let existingKeys: DataStoreRecordsRule[];
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
    existingKeys = await readExistingRecordsKeys(
      runtime.server,
      record,
      definition.records,
      control.signal
    );
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
      await control.transaction(async (stores) => {
        // Publish takes this same store lock before checking its catalog or committing rules.
        // Hold it through the store transaction's commit: a rule cannot slip between the
        // schema check and DDL commit. Only this store's publishes wait for this migration.
        const current = await stores.dataStores.getDataStore({
          clientInstanceId: runtime.clientInstanceId,
          id: storeId,
          lock: true
        });
        if (!current || current.status !== "ready") {
          throw new AppError("CONFLICT", "The Data Store is no longer ready for migrations");
        }
        const latest = await publishedDefinition(runtime, current, stores);
        await applyMigration(
          runtime.server,
          current,
          migration,
          {
            tables: migration === pending.at(-1) ? latest?.definition.tables : undefined,
            secretRows: stores.connections,
            ledgerKey: ledger,
            superuser,
            sizeLimitBytes: current.sizeLimitBytes,
            // Keep every key that held before the batch. Newly published rules whose keys
            // already hold are protected too; only the last file requires all new keys.
            records: [
              ...existingKeys,
              ...(migration === pending.at(-1)
                ? (latest?.definition.records ?? [])
                : await readExistingRecordsKeys(
                    runtime.server,
                    current,
                    latest?.definition.records,
                    control.signal
                  ))
            ]
          },
          control.signal
        );
        // Publish must not see the pre-migration level after the DDL has committed.
        await stores.dataStores.putDataStore({
          ...current,
          level: migration.number,
          migrations: [
            ...applied,
            { number: migration.number, name: migration.name, sha256: migration.sha256 }
          ],
          updatedAt: new Date().toISOString()
        });
      });
    } catch (error) {
      if (error instanceof DataStoreMigrationRefusal) {
        appliedNow = error.applied;
        failed = {
          code: error.code,
          message:
            error.code === "record_key_invalid"
              ? `${file} violates ${error.message} Nothing of it was applied.`
              : error.code === "data_store_size_limit"
                ? `${file} would leave the store at ${error.sizeBytes} bytes, over its size limit (sizeLimit). Nothing of it was applied.`
                : `${file} changed the settings of a role of its store${error.applied ? " as its transaction ended. It is applied, and the roles were set back." : ". Nothing of it was applied."}`,
          retryable: false
        };
      } else {
        appliedNow = false;
        const failure = describeDatabaseFailure(error, file);
        failed = { ...failure, code: "migration_failed", message: failure.sentence };
        // A partial new schema is allowed when a later file would have added its key.
        // Keep the SQL failure and explain why records cannot be written there yet.
        try {
          const latest = await publishedDefinition(runtime, record);
          await checkRecordsCatalog(runtime.server, record, latest?.definition.records);
        } catch (keyError) {
          if (isAppError(keyError) && keyError.code === "VALIDATION_FAILED") {
            failed.message += ` A records key is not there yet: ${keyError.message}`;
          }
        }
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
  let result;
  try {
    result = await applyKnowledgeStoreSchema(runtime.server, record, control.signal);
  } catch (error) {
    const failure = describeDatabaseFailure(error, "Making the tables of the Knowledge Base");
    return failAttempt(runtime, control, job, "data_store.migration_failed", {
      ...failure,
      code: "migration_failed",
      message: failure.sentence
    });
  }
  const { migrations: applied, appliedCount, appliedNumbers } = result;
  const level = applied.at(-1)?.number ?? 0;
  const done = await writeOutcome(runtime, control, record.id, (current) =>
    Promise.resolve({ ...current, level, migrations: applied })
  );
  if (done)
    for (const migrationNumber of appliedNumbers) {
      await runtime.auditRecorder.record({
        type: "data_store.migrated",
        status: "success",
        subject: done.id,
        correlationId: job.correlationId,
        metadata: { name: done.name, level, appliedCount, migrationNumber }
      });
    }
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
      ...[measureSizeJob, measureSizeTickJob].map((kind) =>
        defineJobHandler({
          kind,
          slots: 1,
          run: (_job, control) =>
            control.transaction(async (stores) => {
              await stores.jobs.enqueue(
                measureSizePageJob,
                {},
                { clientInstanceId: runtime.clientInstanceId, dedupeKey: "first-page" }
              );
            })
        })
      ),
      ...[upgradeOwnedJob, upgradeOwnedTickJob].map((kind) =>
        defineJobHandler({
          kind,
          slots: 1,
          run: (_job, control) =>
            control.transaction(async (stores) => {
              await stores.jobs.enqueue(
                upgradeOwnedPageJob,
                {},
                { clientInstanceId: runtime.clientInstanceId, dedupeKey: "first-page" }
              );
            })
        })
      ),
      defineJobHandler({
        kind: measureSizePageJob,
        slots: 1,
        run: (job, control) => measureDataStores(runtime, control, job.payload)
      }),
      defineJobHandler({
        kind: upgradeOwnedPageJob,
        slots: 1,
        run: (job, control) => upgradeOwnedStores(runtime, control, job.payload)
      }),
      defineJobHandler({
        kind: dropJob,
        slots: DATA_STORE_JOB_SLOTS,
        run: (job, control) => drop(runtime, job, control)
      })
    ],
    schedules: [
      defineSchedule({ kind: measureSizeTickJob, every: DATA_STORE_MEASURE_INTERVAL_MS }),
      // A store an earlier release made gets this release's tables as soon as it is up.
      defineSchedule({
        kind: upgradeOwnedTickJob,
        every: DATA_STORE_UPGRADE_INTERVAL_MS,
        dueAtStart: true
      })
    ],
    // Each reads the record, and the published revision, anew.
    retries: [{ kind: provisionJob }, { kind: migrateJob }, { kind: dropJob }]
  };
}
