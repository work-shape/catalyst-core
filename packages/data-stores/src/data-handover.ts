import { createHash } from "node:crypto";
import {
  CONNECTION_ACTIONS,
  CONNECTION_ASSET_KIND,
  DATA_STORE_ACTIONS,
  DATA_STORE_ASSET_KIND,
  DATA_STORE_OPERATION_PREFIX,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_BASE_ASSET_KIND,
  WORKFLOW_ASSET_KIND,
  createActorAccess,
  workflowStepsDeep,
  type AccessResource,
  type ActorAccess,
  type ConfigAssetRecord,
  type DataHandover,
  type DataHandoverAnswer,
  type DataHandoverPair,
  type DataHandoverPublish,
  type JsonObject
} from "@work-shape/catalyst-core";
import { z } from "zod";
import type { DataStoreRuntime } from "./runtime";
import { assetResource } from "./store-audience";
import { agentUse, appUse, knowledgeBaseUse, workflowUse } from "./used-by";
import { DATA_STORE_USED_BY_MAX_ASSETS } from "./workflow-data-flows";

// The widening check (DS-13c): everyone who can read a store's rows may use each of its sources.
// It is asked of the instance as it would be once a publish is live, beside the instance as it
// is now, so a publish is asked to confirm only whom it newly hands a source's data to: a gap
// that was confirmed before, or that a later grant change opened, is the store page's to show.
//
// A reader is a person who may read the rows: through `data_store.read` on the store, through
// `app.use` on an App whose `sql` actions read it, or through `knowledge_base.use` on a
// Knowledge Base on it. A source is every Connection a published App, Workflow or agent that adds
// rows to the store calls, as the store's page counts them (DS-13a). Each person's rights are
// decided by the one evaluator, so a deny, a role, a group or a workspace availability counts
// as it does at a call. People are counted and never named.

const APP_KIND = "app";
const APP_USE = "app.use";

/** How many people one page of the instance's people holds while the check reads them. */
const PEOPLE_PAGE = 200;

/** The ways into a store's rows, and its sources, in one state of the instance. */
interface StoreState {
  ways: { action: string; resource: AccessResource }[];
  sources: Set<string>;
}

const storeTitleSchema = z.object({ title: z.string().min(1) });
const appActionsSchema = z.object({
  manifest: z.object({ actions: z.array(z.unknown()) })
});
const sqlActionSchema = z.object({ kind: z.literal("sql"), dataStore: z.string() });
const workflowSchema = z.object({
  manifest: z.object({ steps: z.unknown(), tools: z.array(z.string()).optional() })
});
const knowledgeBaseSchema = z.object({ backend: z.object({ dataStore: z.string() }) });

/** The stores a revision of an asset names, by its kind. */
function storesNamed(kind: string, config: JsonObject | null): string[] {
  if (kind === APP_KIND) {
    const parsed = appActionsSchema.safeParse(config);
    return parsed.success
      ? parsed.data.manifest.actions.flatMap((action) => {
          const sql = sqlActionSchema.safeParse(action);
          return sql.success ? [sql.data.dataStore] : [];
        })
      : [];
  }
  if (kind === WORKFLOW_ASSET_KIND) {
    const parsed = workflowSchema.safeParse(config);
    if (!parsed.success) return [];
    const operations = [
      ...workflowStepsDeep(parsed.data.manifest.steps).flatMap((step) =>
        step.type === "operation" && typeof step.operation === "string" ? [step.operation] : []
      ),
      ...(parsed.data.manifest.tools ?? [])
    ];
    return operations.flatMap((operation) =>
      operation.startsWith(DATA_STORE_OPERATION_PREFIX)
        ? [operation.slice(DATA_STORE_OPERATION_PREFIX.length).split(".")[0] ?? ""]
        : []
    );
  }
  if (kind === KNOWLEDGE_BASE_ASSET_KIND) {
    const parsed = knowledgeBaseSchema.safeParse(config);
    return parsed.success ? [parsed.data.backend.dataStore] : [];
  }
  return [];
}

/** The ways in and the sources of one store, in one state of the published assets. */
function storeState(
  store: ConfigAssetRecord,
  assets: {
    apps: readonly ConfigAssetRecord[];
    workflows: readonly ConfigAssetRecord[];
    knowledgeBases: readonly ConfigAssetRecord[];
    agents: readonly ConfigAssetRecord[];
  },
  locale: DataStoreRuntime["defaultLocale"]
): StoreState {
  const name = store.name;
  const ways: StoreState["ways"] = [
    { action: DATA_STORE_ACTIONS.read, resource: assetResource(store) }
  ];
  const sources = new Set<string>();
  for (const app of assets.apps) {
    const use = appUse(app, name);
    if (use?.reads) ways.push({ action: APP_USE, resource: assetResource(app) });
    if (use?.writes) for (const connection of use.connections) sources.add(connection);
  }
  for (const workflow of assets.workflows) {
    const use = workflowUse(workflow, name);
    if (use?.writes) for (const connection of use.connections) sources.add(connection);
  }
  for (const agent of assets.agents) {
    const use = agentUse(agent, name, locale);
    if (use?.writes) for (const connection of use.connections) sources.add(connection);
  }
  for (const base of assets.knowledgeBases) {
    if (knowledgeBaseUse(base, name) !== undefined) {
      ways.push({ action: KNOWLEDGE_BASE_ACTIONS.use, resource: assetResource(base) });
    }
  }
  return { ways, sources };
}

/** The published assets of a kind with each asset a publish makes live in its place. */
function withPublished(
  live: readonly ConfigAssetRecord[],
  publishing: readonly ConfigAssetRecord[],
  kind: string
): ConfigAssetRecord[] {
  const theirs = publishing.filter((asset) => asset.kind === kind);
  const replaced = new Set(theirs.map((asset) => asset.id));
  return [...live.filter((asset) => !replaced.has(asset.id)), ...theirs];
}

/** One sha256 over who the publish hands which source's data to, as the confirmation. */
function confirmationOf(newly: ReadonlyMap<string, Set<string>>): string | undefined {
  const entries = [...newly.entries()]
    .filter(([, people]) => people.size > 0)
    .map(([pair, people]) => [pair, [...people].sort()] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  if (entries.length === 0) return undefined;
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/**
 * Asks the invariant of the stores a publish reaches, for the caller: the readers of each store
 * once the publish is live, and per source how many of them may not use it, how many of those
 * the publish newly hands the data to, and whether the caller may confirm that.
 */
async function checkDataHandover(
  runtime: DataStoreRuntime,
  access: ActorAccess,
  publishing: readonly DataHandoverPublish[]
): Promise<DataHandoverAnswer> {
  const { clientInstanceId, stores } = runtime;
  const assetOf = (kind: string, name: string) =>
    stores.configAssets.getConfigAsset({ clientInstanceId, kind, name });
  // Each asset as it would be live: its revision's config in place of the published one.
  const candidates = (
    await Promise.all(
      publishing.map(async (item): Promise<ConfigAssetRecord[]> => {
        const asset = await assetOf(item.kind, item.name);
        if (asset?.status !== "active") return [];
        return [
          {
            ...asset,
            publishedConfig: item.config ?? undefined,
            ...(item.appAvailability ? { appAvailability: item.appAvailability } : {})
          }
        ];
      })
    )
  ).flat();
  const named = [
    ...new Set(
      candidates.flatMap((asset) => storesNamed(asset.kind, asset.publishedConfig ?? null))
    )
  ];
  if (named.length === 0) return { pairs: [], truncated: false };

  const published = (kind: string) =>
    stores.configAssets.listPublishedConfigAssets({
      clientInstanceId,
      kind,
      limit: DATA_STORE_USED_BY_MAX_ASSETS + 1
    });
  const [apps, workflows, knowledgeBases, agents, storeAssets] = await Promise.all([
    published(APP_KIND),
    published(WORKFLOW_ASSET_KIND),
    published(KNOWLEDGE_BASE_ASSET_KIND),
    stores.configAssets.listActiveConfigAssets({
      clientInstanceId,
      kind: "agent",
      limit: DATA_STORE_USED_BY_MAX_ASSETS + 1
    }),
    Promise.all(named.map((name) => assetOf(DATA_STORE_ASSET_KIND, name)))
  ]);
  const truncated =
    Math.max(apps.length, workflows.length, knowledgeBases.length, agents.length) >
    DATA_STORE_USED_BY_MAX_ASSETS;
  const active = (assets: readonly ConfigAssetRecord[]) =>
    assets.slice(0, DATA_STORE_USED_BY_MAX_ASSETS).filter((asset) => asset.status === "active");
  const now = {
    apps: active(apps),
    workflows: active(workflows),
    knowledgeBases: active(knowledgeBases),
    agents: active(agents)
  };
  const then = {
    apps: withPublished(now.apps, candidates, APP_KIND),
    workflows: withPublished(now.workflows, candidates, WORKFLOW_ASSET_KIND),
    knowledgeBases: withPublished(now.knowledgeBases, candidates, KNOWLEDGE_BASE_ASSET_KIND),
    agents: now.agents
  };
  const checked = storeAssets.flatMap((store) => {
    if (store?.status !== "active") return [];
    const after = storeState(store, then, runtime.defaultLocale);
    if (after.sources.size === 0) return [];
    return [{ store, before: storeState(store, now, runtime.defaultLocale), after }];
  });
  if (checked.length === 0) return { pairs: [], truncated };

  // Each source once, as the evaluator reads it. A Connection that is gone gives no data any more.
  const connectionNames = [...new Set(checked.flatMap(({ after }) => [...after.sources]))];
  const connections = new Map(
    (await Promise.all(connectionNames.map((name) => assetOf(CONNECTION_ASSET_KIND, name))))
      .filter((asset): asset is ConfigAssetRecord => asset?.status === "active")
      .map((asset) => [asset.name, asset] as const)
  );

  const key = (store: string, connection: string) => `${store}\u0000${connection}`;
  const readers = new Map<string, number>();
  const lacking = new Map<string, number>();
  const newly = new Map<string, Set<string>>();
  let after: readonly (string | number)[] | undefined;
  for (;;) {
    const people = await stores.users.listUsers({
      clientInstanceId,
      activeOnly: true,
      page: { limit: PEOPLE_PAGE, ...(after ? { after } : {}) }
    });
    for (const person of people) {
      const persisted = await stores.access.loadPersistedAccess({
        clientInstanceId,
        holder: { kind: "user", id: person.id }
      });
      const theirs = createActorAccess(
        {
          kind: "user",
          id: person.id,
          clientInstanceId,
          roles: person.roles,
          permissionRefs: person.permissionRefs
        },
        persisted
      );
      const reads = (state: StoreState) =>
        state.ways.some(({ action, resource }) => theirs.authorize(action, resource).allowed);
      for (const { store, before, after: next } of checked) {
        if (!reads(next)) continue;
        readers.set(store.name, (readers.get(store.name) ?? 0) + 1);
        const readBefore = reads(before);
        for (const source of next.sources) {
          const connection = connections.get(source);
          if (!connection) continue;
          if (theirs.authorize(CONNECTION_ACTIONS.use, assetResource(connection)).allowed) continue;
          const pair = key(store.name, source);
          lacking.set(pair, (lacking.get(pair) ?? 0) + 1);
          if (readBefore && before.sources.has(source)) continue;
          const set = newly.get(pair) ?? new Set<string>();
          set.add(person.id);
          newly.set(pair, set);
        }
      }
    }
    const last = people.at(-1);
    if (people.length < PEOPLE_PAGE || !last) break;
    after = [last.displayLabel, last.id];
  }

  const pairs: DataHandoverPair[] = checked.flatMap(({ store, after: next }) => {
    const storeShown = [DATA_STORE_ACTIONS.read, DATA_STORE_ACTIONS.write].some(
      (right) => access.authorize(right, assetResource(store)).allowed
    );
    const title =
      (storeShown
        ? storeTitleSchema.safeParse(store.publishedConfig ?? store.config).data?.title
        : undefined) ?? store.name;
    return [...next.sources].flatMap((source) => {
      const connection = connections.get(source);
      if (!connection) return [];
      const resource = assetResource(connection);
      // Who may confirm the hand-over sees what they confirm.
      const connectionShown = [
        CONNECTION_ACTIONS.read,
        CONNECTION_ACTIONS.use,
        CONNECTION_ACTIONS.write
      ].some((right) => access.authorize(right, resource).allowed);
      const connectionTitle = z
        .object({ displayName: z.string().min(1) })
        .safeParse(connection.config).data?.displayName;
      const pair = key(store.name, source);
      return [
        {
          store: { name: store.name, title },
          connection: {
            name: source,
            ...(connectionShown ? { title: connectionTitle ?? source } : {})
          },
          readers: readers.get(store.name) ?? 0,
          lacking: lacking.get(pair) ?? 0,
          newlyLacking: newly.get(pair)?.size ?? 0,
          mayConfirm: access.authorize(CONNECTION_ACTIONS.write, resource).allowed
        }
      ];
    });
  });
  const confirmation = confirmationOf(newly);
  return { pairs, ...(confirmation ? { confirmation } : {}), truncated };
}

/** The widening check of the stored-data module. */
export function createDataHandover(runtime: DataStoreRuntime): DataHandover {
  return { check: (access, publishing) => checkDataHandover(runtime, access, publishing) };
}
