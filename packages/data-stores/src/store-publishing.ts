import { assertStoreUnused } from "./used-by";
import { checkScopedMigrations } from "./migrating";
import { dataStoreDefinitionSchema } from "./definition";
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
import { enqueueStoreJob, enqueueTestCopyDrop } from "./store-job-kinds";

/**
 * What publishing a revision of a store does beside moving the published pointer, in the same
 * transaction: it writes the store's record and queues the job. It throws, and so refuses the
 * publish, where the revision changes a migration the store has applied, and where the id is
 * still held by a retired store.
 */
export async function publishDataStore(
  runtime: Pick<DataStoreRuntime, "clientInstanceId" | "server" | "limits" | "scopes">,
  stores: PlatformStores,
  input: { storeId: string; revision: number; definition: DataStoreDefinition }
): Promise<void> {
  const { clientInstanceId, server, limits } = runtime;
  const { storeId, definition } = input;
  for (const table of Object.values(definition.tables ?? {})) {
    for (const dimension of Object.keys(table.scope)) {
      if (!runtime.scopes?.[dimension])
        throw new AppError(
          "VALIDATION_FAILED",
          `Data scope '${dimension}' is not declared in release config`,
          { reason: "scope_dimension_unknown" }
        );
    }
  }
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
  if (current?.status === "ready" && Object.keys(definition.tables ?? {}).length) {
    const before = await stores.configAssets.getConfigAssetRevision({
      clientInstanceId,
      kind: DATA_STORE_ASSET_KIND,
      name: definition.name,
      revision: current.targetRevision
    });
    const previous = dataStoreDefinitionSchema.safeParse(before?.config);
    await checkScopedMigrations(
      server,
      current,
      definition.migrations.filter((migration) => migration.number > current.level),
      definition.tables,
      previous.success ? previous.data.tables : undefined,
      stores.connections
    );
  }
  const now = new Date().toISOString();
  const names = server.namesOf(storeId);
  // A publish starts a new attempt: a failure an earlier attempt left is not this one's, and
  // whoever waits on the record (an App's Publish, GOLIVE-1) reads only what this job writes.
  const { failure: _earlier, ...kept }: DataStoreRecord = current ?? {
    id: storeId,
    clientInstanceId,
    name: definition.name,
    status: "provisioning",
    location: { ...server.location, database: names.database },
    roles: { app: names.app, migration: names.migration },
    level: 0,
    migrations: [],
    conditions: [],
    targetRevision: input.revision,
    sizeLimitBytes: limits.sizeLimitBytes,
    createdAt: now,
    updatedAt: now
  };
  const record: DataStoreRecord = {
    ...kept,
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
 * Its test copy, which only a draft of the asset reached, is dropped by a job queued here.
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
  await enqueueTestCopyDrop(stores, record);
}
