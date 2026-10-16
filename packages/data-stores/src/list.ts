import { LISTED_DATA_STORE_STATUSES } from "@work-shape/catalyst-core";
import { DATA_STORE_ACTIONS, type ActorAccess } from "@work-shape/catalyst-core";
import { z } from "zod";
import { readStores } from "./operations";
import type { DataStoreRuntime } from "./runtime";

// The list of the stores of an instance, for the screen that lists them.

const listedStoreSchema = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: z.enum(LISTED_DATA_STORE_STATUSES),
  level: z.number().int(),
  sizeBytes: z.number().int().optional(),
  sizeLimitBytes: z.number().int(),
  tableCount: z.number().int().optional(),
  rowEstimate: z.number().int().optional(),
  measuredAt: z.string().optional()
});

type ListedStore = z.infer<typeof listedStoreSchema>;

/**
 * The published stores a caller may read, each with what its last measurement found: its
 * size, the number of its tables and the estimate of their rows. Two reads of the platform's
 * database, whatever the number of stores; no database of a store is asked.
 */
export async function listDataStores(
  runtime: DataStoreRuntime,
  access: ActorAccess
): Promise<{ items: ListedStore[]; truncated: boolean }> {
  const { stores, truncated } = await readStores(runtime);
  return {
    items: stores
      .filter((store) => access.authorize(DATA_STORE_ACTIONS.read, store.resource).allowed)
      .map(({ record, definition }) =>
        listedStoreSchema.parse({
          id: record.id,
          name: record.name,
          title: definition.title,
          ...(definition.description === undefined ? {} : { description: definition.description }),
          status: record.status === "ready" ? "ready" : "provisioning",
          level: record.level,
          ...(record.sizeBytes === undefined ? {} : { sizeBytes: record.sizeBytes }),
          sizeLimitBytes: record.sizeLimitBytes,
          ...(record.tableCount === undefined ? {} : { tableCount: record.tableCount }),
          ...(record.rowEstimate === undefined ? {} : { rowEstimate: record.rowEstimate }),
          ...(record.sizeMeasuredAt === undefined ? {} : { measuredAt: record.sizeMeasuredAt })
        })
      ),
    truncated
  };
}
