import {
  DATA_STORE_ACTIONS,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_BASE_ASSET_KIND,
  LISTED_DATA_STORE_STATUSES,
  type ActorAccess,
  type DataStoreRecord
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { knowledgeBaseDefinitionSchema } from "./knowledge/definition";
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
  measuredAt: z.string().optional(),
  ownedBy: z.object({ knowledgeBase: z.string() }).optional()
});

type ListedStore = z.infer<typeof listedStoreSchema>;

/** What a row says of the database of a store, whichever asset it belongs to. */
function measured(record: DataStoreRecord) {
  return {
    id: record.id,
    name: record.name,
    status: record.status === "ready" ? ("ready" as const) : ("provisioning" as const),
    level: record.level,
    ...(record.sizeBytes === undefined ? {} : { sizeBytes: record.sizeBytes }),
    sizeLimitBytes: record.sizeLimitBytes,
    ...(record.tableCount === undefined ? {} : { tableCount: record.tableCount }),
    ...(record.rowEstimate === undefined ? {} : { rowEstimate: record.rowEstimate }),
    ...(record.sizeMeasuredAt === undefined ? {} : { measuredAt: record.sizeMeasuredAt })
  };
}

/**
 * The stores a Knowledge Base owns that the caller may see: those of the Knowledge Bases it may
 * read, each named by its Knowledge Base. One read of the Knowledge Bases, whatever their number.
 */
async function ownedStores(
  runtime: DataStoreRuntime,
  access: ActorAccess,
  owned: readonly DataStoreRecord[]
): Promise<ListedStore[]> {
  const owners = owned.flatMap((record) => record.ownerKnowledgeBaseId ?? []);
  if (owners.length === 0) return [];
  const assets = await runtime.stores.configAssets.listPublishedConfigAssets({
    clientInstanceId: runtime.clientInstanceId,
    kind: KNOWLEDGE_BASE_ASSET_KIND,
    names: owners,
    limit: owners.length
  });
  return owned.flatMap((record) => {
    const asset = assets.find((candidate) => candidate.id === record.id);
    const definition = knowledgeBaseDefinitionSchema.safeParse(asset?.publishedConfig);
    if (!asset || !definition.success) return [];
    const resource = {
      kind: KNOWLEDGE_BASE_ASSET_KIND,
      id: asset.id,
      assetId: asset.id,
      name: asset.name,
      ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
    };
    if (!access.authorize(KNOWLEDGE_BASE_ACTIONS.read, resource).allowed) return [];
    return [
      listedStoreSchema.parse({
        ...measured(record),
        title: definition.data.title,
        ownedBy: { knowledgeBase: asset.name }
      })
    ];
  });
}

/**
 * The published stores a caller may read, each with what its last measurement found: its
 * size, the number of its tables and the estimate of their rows, and beside them the stores
 * of the Knowledge Bases it may read, each marked as owned by its Knowledge Base. Three reads
 * of the platform's database, whatever the number of stores; no database of a store is asked.
 */
export async function listDataStores(
  runtime: DataStoreRuntime,
  access: ActorAccess
): Promise<{ items: ListedStore[]; truncated: boolean }> {
  const { stores, owned, truncated } = await readStores(runtime);
  return {
    items: [
      ...stores
        .filter((store) => access.authorize(DATA_STORE_ACTIONS.read, store.resource).allowed)
        .map(({ record, definition }) =>
          listedStoreSchema.parse({
            ...measured(record),
            title: definition.title,
            ...(definition.description === undefined ? {} : { description: definition.description })
          })
        ),
      ...(await ownedStores(runtime, access, owned))
    ],
    truncated
  };
}
