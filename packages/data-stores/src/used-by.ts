import { recordKnowledgeSources } from "./records/lineage";
import { workflowDataFlowsSchema } from "@work-shape/catalyst-core";
import { DATA_STORE_USED_BY_MAX_ASSETS, workflowDataFlows } from "./workflow-data-flows";
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
  appReachesDataStore,
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

/** How long the read may take, in milliseconds. It reads no database of a store. */
const DATA_STORE_USED_BY_TIMEOUT_MS = 15_000;

/** The kind of an App and its rights, as the kind `app` registers them. */
const APP = {
  kind: "app",
  read: "app.read",
  use: "app.use",
  write: "app.write",
  publish: "app.publish",
  approve: "app.approve"
} as const;

/**
 * Who may read what one stored revision of an App would show: whoever may change it, publish
 * it, or decide a held publish of it.
 */
const APP_REVISION_RIGHTS = [APP.write, APP.publish, APP.approve] as const;

const sourceSchema = z.object({
  /** The id of the Connection whose operations the definition calls. */
  connection: z.string().optional(),
  knowledgeBase: z.string().optional(),
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
  dataFlows: workflowDataFlowsSchema.optional(),
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
  knowledge?: readonly string[];
}

/** Whether an operation of the store adds rows: one that needs more than the right to read. */
function verbWrites(verb: string): boolean {
  if (verb === "records.propose") return true;
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
    connections: connectionsOf(operations),
    knowledge: [
      ...new Set(
        operations.flatMap((operation) => {
          const [prefix, name] = operation.split(".");
          return prefix === "knowledge" && name ? [name] : [];
        })
      )
    ]
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
export function appUse(asset: ConfigAssetRecord, store: string): StoreUse | undefined {
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
export function knowledgeBaseUse(asset: ConfigAssetRecord, store: string): string | undefined {
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
  const knowledgeSources = recordKnowledgeSources(
    usingWorkflows.shown.map(({ asset, use }) => ({
      id: asset.id,
      knowledge: use.knowledge ?? []
    })),
    knowledgeBases,
    access
  );
  const using = ({ asset, use }: { asset: ConfigAssetRecord; use: StoreUse }) => ({
    id: asset.id,
    name: asset.name,
    title: use.title,
    reads: use.reads,
    writes: use.writes,
    sources: use.writes
      ? [
          ...use.connections.map((connection) => ({
            connection,
            title: sourceTitles.get(connection) ?? connection
          })),
          ...(knowledgeSources.get(asset.id) ?? [])
        ]
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
  const dataFlows = workflowDataFlows(workflows, { kind: "data_store", name }, access);
  return {
    ...(dataFlows ? { dataFlows } : {}),
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
      ),
      /**
       * No store the App may reach stands under the name: none, a retired one, or one of
       * another workspace, which a publish refuses. Nothing of such a store is told: `title` is
       * the name the App declares, and it has no fillers and no measurement.
       */
      unavailable: z.literal(true).optional(),
      /** Of one revision: the names of its reading `sql` actions on the store. */
      actions: z.array(z.string()).optional(),
      /**
       * Of one revision: the store's last measurement, for the whole store. It bounds what the
       * actions may select and is not what they select: they take parameters.
       */
      rows: z
        .object({ estimate: z.number().int(), tables: z.number().int(), measuredAt: z.string() })
        .optional()
    })
  ),
  /** The revision described, where one was asked for. */
  revision: z.number().int().optional(),
  /** Of one revision: who may use the App, and so sees what its `sql` actions select. */
  audience: audienceSchema.optional(),
  truncated: z.boolean()
});

type AppSources = z.infer<typeof appSourcesSchema>;

const storeTitleSchema = z.object({ title: z.string().min(1) });

/** The reading `sql` actions of a revision's config by store, each name once, in manifest order. */
function readingActionsByStore(config: unknown): Map<string, string[]> {
  const parsed = appConfigSchema.safeParse(config);
  const byStore = new Map<string, string[]>();
  if (!parsed.success) return byStore;
  for (const action of parsed.data.manifest.actions) {
    const sql = readingSqlActionSchema.safeParse(action);
    if (!sql.success || sql.data.effect === "changing") continue;
    const names = byStore.get(sql.data.dataStore) ?? [];
    if (!names.includes(sql.data.name)) names.push(sql.data.name);
    byStore.set(sql.data.dataStore, names);
  }
  return byStore;
}

const readingSqlActionSchema = z.object({
  kind: z.literal("sql"),
  name: z.string(),
  dataStore: z.string(),
  effect: z.string()
});

/**
 * Where the data of one published App comes from, for whoever uses it: each store its reading
 * statements name, and each published Workflow and App that adds rows to it with the
 * Connections it calls. It is what the App declares, so its user reads every name of it, as on
 * the App itself; an account is never named. An App the caller may neither use nor read is not
 * there for it.
 *
 * With `revision`, the same of that stored revision, whether or not it is published, for
 * whoever may change, publish or approve the App (DS-13b): what a publish of it would show and
 * to whom. Each store also carries the reading actions on it and its last measurement, and the
 * answer carries the App's audience. It reads no database of a store and no statement leaves.
 *
 * A store is described only where a publish of the App would reach it, by the rule the publish
 * asks (`appReachesDataStore`): a draft may name any store, and naming one tells nothing of it.
 * Any other is named as the App declares it and marked unavailable.
 */
export async function appDataSources(
  runtime: DataStoreRuntime,
  access: ActorAccess,
  app: string,
  revision?: number
): Promise<AppSources> {
  const { clientInstanceId, stores } = runtime;
  const published = (kind: string, names?: readonly string[]) =>
    stores.configAssets.listPublishedConfigAssets({
      clientInstanceId,
      kind,
      ...(names ? { names } : {}),
      limit: names ? names.length : DATA_STORE_USED_BY_MAX_ASSETS + 1
    });
  const [record, config] =
    revision === undefined
      ? await publishedApp(runtime, access, app)
      : await storedRevision(runtime, access, app, revision);
  const actionsByStore = readingActionsByStore(config);
  const read = [...actionsByStore.keys()];
  const audience = revision === undefined ? undefined : await appAudience(runtime, access, record);
  const described = {
    ...(revision === undefined ? {} : { revision }),
    ...(audience ? { audience: audience.audience } : {})
  };
  if (read.length === 0) {
    return { stores: [], ...described, truncated: audience?.truncated ?? false };
  }
  const [storeAssets, apps, workflows] = await Promise.all([
    published(DATA_STORE_ASSET_KIND, read),
    published(APP.kind),
    published(WORKFLOW_ASSET_KIND)
  ]);
  // Only the stores a publish of the App would reach, by the publish's own rule.
  const inReach = storeAssets.filter(
    (asset) => asset.status === "active" && appReachesDataStore(record.scope, asset.scope)
  );
  // Point reads of the selected stores only; no operation discovery or store database calls.
  const standing = (
    await Promise.all(
      inReach.map((asset) => stores.dataStores.getDataStore({ clientInstanceId, id: asset.id }))
    )
  ).flatMap((store) => (store && store.status !== "retired" ? [store] : []));
  const reachable = new Set(standing.map((store) => store.name));
  const titles = new Map(
    inReach.flatMap((asset) => {
      const parsed = storeTitleSchema.safeParse(asset.publishedConfig);
      return parsed.success && reachable.has(asset.name)
        ? [[asset.name, parsed.data.title] as const]
        : [];
    })
  );
  const rowsOf = new Map(
    standing.flatMap((store) =>
      revision === undefined ||
      store.rowEstimate === undefined ||
      store.tableCount === undefined ||
      store.sizeMeasuredAt === undefined
        ? []
        : [
            [
              store.name,
              {
                estimate: store.rowEstimate,
                tables: store.tableCount,
                measuredAt: store.sizeMeasuredAt
              }
            ] as const
          ]
    )
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
  const byStore = read.map((store) => ({
    store,
    fillers: reachable.has(store) ? fillersOf(store) : []
  }));
  const connections = await connectionTitles(
    runtime,
    undefined,
    byStore.flatMap(({ fillers }) => fillers.flatMap(({ use }) => use.connections))
  );
  return {
    stores: byStore.map(({ store, fillers }) => {
      const rows = rowsOf.get(store);
      return {
        name: store,
        title: titles.get(store) ?? store,
        ...(reachable.has(store) ? {} : { unavailable: true as const }),
        fillers: fillers.map(({ kind, asset, use }) => ({
          kind,
          name: asset.name,
          title: use.title,
          connections: use.connections.map(
            (connection) => connections.get(connection) ?? connection
          )
        })),
        ...(revision === undefined
          ? {}
          : { actions: actionsByStore.get(store) ?? [], ...(rows ? { rows } : {}) })
      };
    }),
    ...described,
    truncated:
      Math.max(apps.length, workflows.length) > DATA_STORE_USED_BY_MAX_ASSETS ||
      (audience?.truncated ?? false)
  };
}

/** The published App and its published config, for whoever may use or read it. */
async function publishedApp(
  runtime: DataStoreRuntime,
  access: ActorAccess,
  app: string
): Promise<[ConfigAssetRecord, unknown]> {
  const [record] = await runtime.stores.configAssets.listPublishedConfigAssets({
    clientInstanceId: runtime.clientInstanceId,
    kind: APP.kind,
    names: [app],
    limit: 1
  });
  if (!mayAsk(access, record, [APP.use, APP.read])) throw appNotAvailable();
  return [record, record.publishedConfig];
}

/** One stored revision of an App and its config, for whoever may change, publish or approve it. */
async function storedRevision(
  runtime: DataStoreRuntime,
  access: ActorAccess,
  app: string,
  revision: number
): Promise<[ConfigAssetRecord, unknown]> {
  const { clientInstanceId, stores } = runtime;
  const record = await stores.configAssets.getConfigAsset({
    clientInstanceId,
    kind: APP.kind,
    name: app
  });
  if (!mayAsk(access, record, APP_REVISION_RIGHTS)) throw appNotAvailable();
  const stored = await stores.configAssets.getConfigAssetRevision({
    clientInstanceId,
    kind: APP.kind,
    name: app,
    revision
  });
  // A revision number outlives a delete and a new App of the name: it must be this App's.
  if (stored?.assetId !== record.id) {
    throw new AppError("NOT_FOUND", "App revision is not available");
  }
  return [record, stored.config];
}

/** Whether the App stands and the caller holds one of the rights on it. */
function mayAsk(
  access: ActorAccess,
  record: ConfigAssetRecord | undefined,
  rights: readonly string[]
): record is ConfigAssetRecord {
  if (record?.status !== "active") return false;
  const resource = assetResource(record);
  return rights.some((right) => access.authorize(right, resource).allowed);
}

function appNotAvailable(): AppError {
  return new AppError("NOT_FOUND", "App is not available");
}

/**
 * Who may use an App, as the store's page names the audience of each App on it: the members of
 * the workspace that owns it, and the holders of `app.use` by a grant, named only to a caller
 * who administers users.
 */
async function appAudience(
  runtime: DataStoreRuntime,
  access: ActorAccess,
  app: ConfigAssetRecord
): Promise<{ audience: z.infer<typeof audienceSchema>; truncated: boolean }> {
  const audiences = createAudienceReader(runtime, access);
  const audience = await audiences.of(APP.use, assetResource(app));
  return { audience, truncated: audiences.truncated() };
}
