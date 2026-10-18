import type { JobControl } from "@work-shape/catalyst-core";
import { knowledgeStoreNeedsMigration } from "./knowledge/builtin/store-schema";
import type { DataStoreRuntime } from "./runtime";
import { enqueueStoreJob, upgradeOwnedPageJob, type MaintenancePayload } from "./store-job-kinds";

/** A page bounds one lease's work, never the number of stores reached. */
export const DATA_STORE_MAINTENANCE_PAGE_SIZE = 100;

/** Queues missing owned-store migrations and persists the next page in the same transaction. */
export async function upgradeOwnedStores(
  runtime: DataStoreRuntime,
  control: JobControl,
  payload: MaintenancePayload
): Promise<void> {
  control.signal.throwIfAborted();
  const records = await runtime.stores.dataStores.listDataStores({
    clientInstanceId: runtime.clientInstanceId,
    limit: DATA_STORE_MAINTENANCE_PAGE_SIZE + 1,
    ...(payload.after ? { after: payload.after } : {})
  });
  const page = records.slice(0, DATA_STORE_MAINTENANCE_PAGE_SIZE);
  await control.transaction(async (stores) => {
    for (const record of page) {
      if (
        record.ownerKnowledgeBaseId !== undefined &&
        record.status === "ready" &&
        knowledgeStoreNeedsMigration(record)
      ) {
        await enqueueStoreJob(stores, record);
      }
    }
    const last = page.at(-1);
    if (last && records.length > page.length) {
      await stores.jobs.enqueue(
        upgradeOwnedPageJob,
        { after: { name: last.name, id: last.id } },
        {
          clientInstanceId: runtime.clientInstanceId,
          dedupeKey: `page:${last.id}`
        }
      );
    }
  });
}
