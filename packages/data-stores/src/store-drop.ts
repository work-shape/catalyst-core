import {
  AppError,
  NonRetryableJobError,
  claimSubjectRow,
  type DataStoreRecord,
  type Job,
  type JobControl,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { describeDatabaseFailure } from "./failures";
import { dropStoreDatabase } from "./provisioning";
import type { DataStoreRuntime } from "./runtime";
import type { StorePayload } from "./store-job-kinds";

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
export async function dropOwnedStore(
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
export async function drop(
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
