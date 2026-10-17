import {
  CONNECTION_ACTIONS,
  AppError,
  CONNECTION_ASSET_KIND,
  DATA_STORE_ACTIONS,
  DATA_STORE_ASSET_KIND,
  DATA_STORE_OPERATION_PREFIX,
  DATA_STORE_OPERATION_RIGHTS,
  DATA_STORE_OPERATION_VERBS,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_BASE_ASSET_KIND,
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND,
  parseConnectionOperationName,
  workflowStepsDeep,
  type ActorAccess,
  type ConfigAssetRecord,
  type OperationDefinition
} from "@work-shape/catalyst-core";
import { z } from "zod";
import type { DataStoreRuntime } from "./runtime";
import {
  NAMES_HOLDERS,
  assetResource,
  audienceSchema,
  createAudienceReader
} from "./store-audience";
import type { PublishedStore } from "./verbs";

// What uses one store, where its rows come from and who reads them: the published Apps whose
// `sql` actions name it, the published Workflows whose operation steps call one of its
// operations, and the published Knowledge Bases on it. It is read from the published
// definitions each time, so it is as true as they are and no second record can fall behind:
// what was published before this read existed is read the same way.
//
// A Workflow or an App that writes into the store and calls an operation of a Connection makes
// that Connection a source of the store. This is conservative: which value of which call ends
// in which row is not traced.

/**
 * How many published Apps, Workflows and Knowledge Bases one read looks through, each. An
 * instance with more is answered from the first ones by name, and `truncated` says so.
 */
const DATA_STORE_USED_BY_MAX_ASSETS = 1_000;
/** How long the read may take, in milliseconds. It reads no database of a store. */
const DATA_STORE_USED_BY_TIMEOUT_MS = 15_000;

/** The kind of an App and the rights that show one, as the kind `app` registers them. */
const APP = { kind: "app", read: "app.read", use: "app.use" } as const;

const sourceSchema = z.object({
  /** The id of the Connection whose operations the definition calls. */
  connection: z.string(),
  /** Its name people read, where the caller may see the Connection; its id otherwise. */
  title: z.string()
});

const usingSchema = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string(),
  /** It reads rows of the store. */
  reads: z.boolean(),
  /** It adds rows to the store. */
  writes: z.boolean(),
  /** Where the rows it writes come from: every Connection it calls. None where it writes none. */
  sources: z.array(sourceSchema)
});

const usedByOutputSchema = z.object({
  /** The published Apps that use the store, with who opens them, and that the caller may be shown. */
  apps: z.array(usingSchema.extend({ audience: audienceSchema })),
  /** The published Workflows that use the store and that the caller may be shown. */
  workflows: z.array(
    usingSchema.extend({
      /**
       * The service principal a run acts as. Its name and its label only for a caller who
       * administers users, as the holders of a right; for any other caller an empty object
       * says the Workflow runs as an account.
       */
      account: z.object({ name: z.string().optional(), title: z.string().optional() }).optional()
    })
  ),
  /** The published Knowledge Bases on the store, with who asks them, that the caller may be shown. */
  knowledgeBases: z.array(
    z.object({ id: z.string(), name: z.string(), title: z.string(), audience: audienceSchema })
  ),
  /** Who reads the store itself: the holders of `data_store.read`. */
  readers: audienceSchema,
  /** How many more use it that the caller may not be shown. Nothing of them is told. */
  hidden: z.object({
    apps: z.number().int(),
    workflows: z.number().int(),
    knowledgeBases: z.number().int(),
    /** How many of them add rows to the store. */
    fills: z.number().int(),
    /** How many of them read it: Apps that read it, Knowledge Bases, and Workflows that read it and add no rows. */
    reads: z.number().int()
  }),
  /** More published assets or grant rows exist than one read looks through. */
  truncated: z.boolean()
});

type UsedBy = z.infer<typeof usedByOutputSchema>;

/** What a published definition does with the store, and the Connections it calls. */
interface StoreUse {
  title: string;
  reads: boolean;
  writes: boolean;
  connections: readonly string[];
}

/** Whether an operation of the store adds rows: one that needs more than the right to read. */
function verbWrites(verb: string): boolean {
  const known = DATA_STORE_OPERATION_VERBS.find((candidate) => candidate === verb);
  return known !== undefined && DATA_STORE_OPERATION_RIGHTS[known] !== DATA_STORE_ACTIONS.read;
}

/** What a definition that calls these operations does with the store, or nothing. */
function useOfOperations(
  operations: readonly string[],
  store: string,
  title: string
): StoreUse | undefined {
  const prefix = `${DATA_STORE_OPERATION_PREFIX}${store}.`;
  const verbs = operations.flatMap((operation) =>
    operation.startsWith(prefix) ? [operation.slice(prefix.length)] : []
  );
  if (verbs.length === 0) return undefined;
  return {
    title,
    reads: verbs.some((verb) => !verbWrites(verb)),
    writes: verbs.some(verbWrites),
    connections: connectionsOf(operations)
  };
}

/** The Connections whose operations are named, each once, in the order they are first named. */
function connectionsOf(operations: readonly string[]): string[] {
  return [
    ...new Set(
      operations.flatMap((operation) => {
        const parsed = parseConnectionOperationName(operation);
        return parsed ? [parsed.connection] : [];
      })
    )
  ];
}

const appConfigSchema = z.object({
  title: z.string().optional(),
  manifest: z.object({ actions: z.array(z.unknown()) })
});
const appActionSchema = z.union([
  z.object({ kind: z.literal("sql"), dataStore: z.string(), effect: z.string() }),
  z.object({ kind: z.literal("connection"), connection: z.string() })
]);

/** What the published revision of an App does with the store, or nothing. */
function appUse(asset: ConfigAssetRecord, store: string): StoreUse | undefined {
  const config = appConfigSchema.safeParse(asset.publishedConfig);
  if (!config.success) return undefined;
  const actions = config.data.manifest.actions.flatMap((action) => {
    const parsed = appActionSchema.safeParse(action);
    return parsed.success ? [parsed.data] : [];
  });
  const statements = actions.filter(
    (action) => action.kind === "sql" && action.dataStore === store
  );
  if (statements.length === 0) return undefined;
  return {
    title: config.data.title ?? asset.name,
    reads: statements.some((action) => action.kind === "sql" && action.effect !== "changing"),
    writes: statements.some((action) => action.kind === "sql" && action.effect === "changing"),
    connections: [
      ...new Set(
        actions.flatMap((action) => (action.kind === "connection" ? [action.connection] : []))
      )
    ]
  };
}

const workflowConfigSchema = z.object({
  manifest: z.object({
    name: z.string().optional(),
    runAs: z.string().optional(),
    steps: z.unknown(),
    /** The operations an agent step of the Workflow may call as tools. */
    tools: z.array(z.string()).optional()
  })
});

/**
 * What the published revision of a Workflow does with the store, or nothing. It uses it where
 * an operation step calls one of the store's operations, at whatever depth of the definition's
 * blocks, or where an agent step may call one as a tool. The steps are walked by the
 * definition's own walker, so a block a later engine runs is followed here as soon as a
 * definition may hold it.
 */
function workflowUse(
  asset: ConfigAssetRecord,
  store: string
): (StoreUse & { runAs?: string }) | undefined {
  const config = workflowConfigSchema.safeParse(asset.publishedConfig);
  if (!config.success) return undefined;
  const { manifest } = config.data;
  const operations = [
    ...workflowStepsDeep(manifest.steps).flatMap((step) =>
      step.type === "operation" && typeof step.operation === "string" ? [step.operation] : []
    ),
    ...(manifest.tools ?? [])
  ];
  const use = useOfOperations(operations, store, manifest.name ?? asset.name);
  return use && { ...use, ...(manifest.runAs === undefined ? {} : { runAs: manifest.runAs }) };
}

const knowledgeBaseConfigSchema = z.object({
  title: z.string().optional(),
  backend: z.object({ dataStore: z.string() })
});

/** The title of a published Knowledge Base on the store, or nothing. */
function knowledgeBaseUse(asset: ConfigAssetRecord, store: string): string | undefined {
  const config = knowledgeBaseConfigSchema.safeParse(asset.publishedConfig);
  return config.success && config.data.backend.dataStore === store
    ? (config.data.title ?? asset.name)
    : undefined;
}

async function usedBy(
  runtime: DataStoreRuntime,
  store: PublishedStore,
  access: ActorAccess
): Promise<UsedBy> {
  const { clientInstanceId, stores } = runtime;
  const name = store.record.name;
  const published = (kind: string) =>
    stores.configAssets.listPublishedConfigAssets({
      clientInstanceId,
      kind,
      limit: DATA_STORE_USED_BY_MAX_ASSETS + 1
    });
  const [apps, workflows, knowledgeBases] = await Promise.all([
    published(APP.kind),
    published(WORKFLOW_ASSET_KIND),
    published(KNOWLEDGE_BASE_ASSET_KIND)
  ]);
  /**
   * Splits the assets that use the store into the ones the caller is shown and a count. The
   * published revision of an asset is shown to whoever reads it or uses it, as its list shows
   * it. Nobody else learns that it exists, here as there.
   */
  const sorted = <Use>(
    assets: readonly ConfigAssetRecord[],
    use: (asset: ConfigAssetRecord) => Use | undefined,
    rights: readonly string[]
  ) => {
    const shown: { asset: ConfigAssetRecord; use: Use }[] = [];
    const hiddenUses: Use[] = [];
    for (const asset of assets.slice(0, DATA_STORE_USED_BY_MAX_ASSETS)) {
      if (asset.status !== "active") continue;
      const found = use(asset);
      if (found === undefined) continue;
      if (rights.some((right) => access.authorize(right, assetResource(asset)).allowed)) {
        shown.push({ asset, use: found });
      } else {
        hiddenUses.push(found);
      }
    }
    return { shown, hidden: hiddenUses.length, hiddenUses };
  };
  const usingApps = sorted(apps, (asset) => appUse(asset, name), [APP.read, APP.use]);
  const usingWorkflows = sorted(workflows, (asset) => workflowUse(asset, name), [
    WORKFLOW_ACTIONS.read,
    WORKFLOW_ACTIONS.use
  ]);
  const usingKnowledgeBases = sorted(knowledgeBases, (asset) => knowledgeBaseUse(asset, name), [
    KNOWLEDGE_BASE_ACTIONS.read,
    KNOWLEDGE_BASE_ACTIONS.use
  ]);

  const shownUses = [...usingApps.shown, ...usingWorkflows.shown];
  const namesAccounts = access.authorize(NAMES_HOLDERS).allowed;
  const [sourceTitles, accounts] = await Promise.all([
    connectionTitles(
      runtime,
      access,
      shownUses.flatMap(({ use }) => (use.writes ? use.connections : []))
    ),
    namesAccounts
      ? accountTitles(
          runtime,
          usingWorkflows.shown.flatMap(({ use }) => (use.runAs === undefined ? [] : [use.runAs]))
        )
      : new Map<string, string>()
  ]);
  const using = ({ asset, use }: { asset: ConfigAssetRecord; use: StoreUse }) => ({
    id: asset.id,
    name: asset.name,
    title: use.title,
    reads: use.reads,
    writes: use.writes,
    sources: use.writes
      ? use.connections.map((connection) => ({
          connection,
          title: sourceTitles.get(connection) ?? connection
        }))
      : []
  });
  const audiences = createAudienceReader(runtime, access);
  // The workspaces of all Apps shown, in one read: each App's audience names its workspace.
  await audiences.readWorkspaces(
    usingApps.shown.flatMap(({ asset }) =>
      asset.scope.kind === "workspace" ? [asset.scope.workspaceId] : []
    )
  );
  const [appsShown, knowledgeBasesShown, readers] = await Promise.all([
    Promise.all(
      usingApps.shown.map(async (shown) => ({
        ...using(shown),
        audience: await audiences.of(APP.use, assetResource(shown.asset))
      }))
    ),
    Promise.all(
      usingKnowledgeBases.shown.map(async ({ asset, use }) => ({
        id: asset.id,
        name: asset.name,
        title: use,
        audience: await audiences.of(KNOWLEDGE_BASE_ACTIONS.use, assetResource(asset))
      }))
    ),
    audiences.of(DATA_STORE_ACTIONS.read, store.resource)
  ]);
  return {
    apps: appsShown,
    workflows: usingWorkflows.shown.map((shown) => {
      const { runAs } = shown.use;
      return {
        ...using(shown),
        ...(runAs === undefined
          ? {}
          : {
              account: namesAccounts ? { name: runAs, title: accounts.get(runAs) ?? runAs } : {}
            })
      };
    }),
    knowledgeBases: knowledgeBasesShown,
    readers,
    hidden: {
      apps: usingApps.hidden,
      workflows: usingWorkflows.hidden,
      knowledgeBases: usingKnowledgeBases.hidden,
      // By what they do, as the two sections of the store's page list the ones it shows: a
      // Workflow that adds rows fills the store whether or not it reads it too.
      fills: [...usingApps.hiddenUses, ...usingWorkflows.hiddenUses].filter((use) => use.writes)
        .length,
      reads:
        usingApps.hiddenUses.filter((use) => use.reads).length +
        usingWorkflows.hiddenUses.filter((use) => use.reads && !use.writes).length +
        usingKnowledgeBases.hidden
    },
    truncated:
      Math.max(apps.length, workflows.length, knowledgeBases.length) >
        DATA_STORE_USED_BY_MAX_ASSETS || audiences.truncated()
  };
}

/**
 * The names people read of the Connections, by id: of each one the caller may read or use. A
 * Connection the caller may not see keeps its id, which the definition that names it shows.
 */
async function connectionTitles(
  runtime: DataStoreRuntime,
  /** The caller, whose rights decide which are named; none where every one is named. */
  access: ActorAccess | undefined,
  connections: readonly string[]
): Promise<Map<string, string>> {
  // A Connection has no draft: what people read of it is its current revision, as its page
  // reads it.
  const assets = await Promise.all(
    [...new Set(connections)].map((name) =>
      runtime.stores.configAssets.getConfigAsset({
        clientInstanceId: runtime.clientInstanceId,
        kind: CONNECTION_ASSET_KIND,
        name
      })
    )
  );
  const configSchema = z.object({ displayName: z.string().min(1) });
  return new Map(
    assets.flatMap((asset) => {
      if (asset?.status !== "active") return [];
      const config = configSchema.safeParse(asset.config);
      const shown =
        access === undefined ||
        [CONNECTION_ACTIONS.read, CONNECTION_ACTIONS.use].some(
          (right) => access.authorize(right, assetResource(asset)).allowed
        );
      return config.success && shown ? [[asset.name, config.data.displayName] as const] : [];
    })
  );
}

/** The labels of the service principals the Workflows run as, by name. */
async function accountTitles(
  runtime: DataStoreRuntime,
  names: readonly string[]
): Promise<Map<string, string>> {
  const found = await Promise.all(
    [...new Set(names)].map((name) =>
      runtime.stores.apiAccess.findServicePrincipalByName({
        clientInstanceId: runtime.clientInstanceId,
        name
      })
    )
  );
  return new Map(
    found.flatMap((principal) => (principal ? [[principal.name, principal.displayLabel]] : []))
  );
}

/** The last part of the name of the operation that answers what uses a store. */
export const DATA_STORE_USED_BY_PART = "used_by";

/**
 * The read of what uses one store, where its rows come from and who reads them. It needs
 * `data_store.read` on the store and reads no row of it, so a call that completes leaves no run.
 */
export function usedByOperation(
  runtime: DataStoreRuntime,
  store: PublishedStore,
  module: string
): OperationDefinition {
  return {
    name: `${DATA_STORE_OPERATION_PREFIX}${store.record.name}.${DATA_STORE_USED_BY_PART}`,
    effect: "reading",
    action: DATA_STORE_ACTIONS.read,
    scope: "config_assets:read",
    auth: "principal",
    inputSchema: z.strictObject({}),
    outputSchema: usedByOutputSchema,
    resource: () => store.resource,
    module,
    timeoutMs: DATA_STORE_USED_BY_TIMEOUT_MS,
    execute: (_input, context) => usedBy(runtime, store, context.access)
  };
}

const appSourcesSchema = z.object({
  stores: z.array(
    z.object({
      name: z.string(),
      title: z.string(),
      fillers: z.array(
        z.object({
          kind: z.enum(["workflow", APP.kind]),
          name: z.string(),
          title: z.string(),
          connections: z.array(z.string())
        })
      )
    })
  ),
  truncated: z.boolean()
});

const storeTitleSchema = z.object({ title: z.string().min(1) });

/**
 * Where the data of one published App comes from, for whoever uses it: each store its reading
 * statements name, and each published Workflow and App that adds rows to it with the
 * Connections it calls. It is what the App declares, so its user reads every name of it, as on
 * the App itself; an account is never named. An App the caller may neither use nor read is not
 * there for it.
 */
export async function appDataSources(
  runtime: DataStoreRuntime,
  access: ActorAccess,
  app: string
): Promise<z.infer<typeof appSourcesSchema>> {
  const { clientInstanceId, stores } = runtime;
  const published = (kind: string, names?: readonly string[]) =>
    stores.configAssets.listPublishedConfigAssets({
      clientInstanceId,
      kind,
      ...(names ? { names } : {}),
      limit: names ? names.length : DATA_STORE_USED_BY_MAX_ASSETS + 1
    });
  const [record] = await published(APP.kind, [app]);
  if (
    record?.status !== "active" ||
    ![APP.use, APP.read].some((right) => access.authorize(right, assetResource(record)).allowed)
  ) {
    throw new AppError("NOT_FOUND", "App is not available");
  }
  const config = appConfigSchema.safeParse(record.publishedConfig);
  const read = config.success
    ? [
        ...new Set(
          config.data.manifest.actions.flatMap((action) => {
            const parsed = appActionSchema.safeParse(action);
            return parsed.success && parsed.data.kind === "sql" && parsed.data.effect !== "changing"
              ? [parsed.data.dataStore]
              : [];
          })
        )
      ]
    : [];
  if (read.length === 0) return { stores: [], truncated: false };
  const [storeAssets, apps, workflows] = await Promise.all([
    published(DATA_STORE_ASSET_KIND, read),
    published(APP.kind),
    published(WORKFLOW_ASSET_KIND)
  ]);
  const titles = new Map(
    storeAssets.flatMap((asset) => {
      const parsed = storeTitleSchema.safeParse(asset.publishedConfig);
      return parsed.success ? [[asset.name, parsed.data.title] as const] : [];
    })
  );
  const active = (assets: readonly ConfigAssetRecord[]) =>
    assets.slice(0, DATA_STORE_USED_BY_MAX_ASSETS).filter((asset) => asset.status === "active");
  const fillersOf = (store: string) => [
    ...active(workflows).flatMap((asset) => {
      const use = workflowUse(asset, store);
      return use?.writes ? [{ kind: "workflow" as const, asset, use }] : [];
    }),
    ...active(apps).flatMap((asset) => {
      const use = asset.name === app ? undefined : appUse(asset, store);
      return use?.writes ? [{ kind: APP.kind, asset, use }] : [];
    })
  ];
  const byStore = read.map((store) => ({ store, fillers: fillersOf(store) }));
  const connections = await connectionTitles(
    runtime,
    undefined,
    byStore.flatMap(({ fillers }) => fillers.flatMap(({ use }) => use.connections))
  );
  return {
    stores: byStore.map(({ store, fillers }) => ({
      name: store,
      title: titles.get(store) ?? store,
      fillers: fillers.map(({ kind, asset, use }) => ({
        kind,
        name: asset.name,
        title: use.title,
        connections: use.connections.map((connection) => connections.get(connection) ?? connection)
      }))
    })),
    truncated: Math.max(apps.length, workflows.length) > DATA_STORE_USED_BY_MAX_ASSETS
  };
}
