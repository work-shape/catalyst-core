import { assertStoreUnused } from "./used-by";
import {
  AppError,
  DATA_STORE_ASSET_KIND,
  DATA_STORE_MANIFEST_FILE,
  type DataStoreRecord,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { appliedMigrationIssue, type DataStoreDefinition } from "./definition";
import { checkRecordsCatalog } from "./records/publish";
import type { DataStoreRuntime } from "./runtime";
import { enqueueStoreJob } from "./store-job-kinds";

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
  // A one-step publish may introduce the table and rules together. Check its final schema
  // in the migration transaction, never the old catalog while DDL is still queued.
  if (definition.migrations.length === (current?.level ?? 0)) {
    await checkRecordsCatalog(server, current, definition.records);
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
  await assertStoreUnused(runtime, stores, record.name);
  const now = new Date().toISOString();
  await stores.dataStores.putDataStore({
    ...record,
    status: "retired",
    retiredAt: now,
    updatedAt: now
  });
}
