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
  asCollaborationWorkspaceId,
  createActorAccess,
  workflowStepsDeep,
  type AccessResource,
  type ActorAccess,
  type AgentAvailability,
  type ConfigAssetRecord,
  type DataHandover,
  type DataHandoverAnswer,
  type DataHandoverPair,
  type DataHandoverPublish,
  type JsonObject,
  type PersistedAccess
} from "@work-shape/catalyst-core";
import { z } from "zod";
import type { DataStoreRuntime } from "./runtime";
import { assetResource } from "./store-audience";
import { agentUse, appUse, knowledgeBaseUse, workflowUse } from "./used-by";
import { DATA_STORE_USED_BY_MAX_ASSETS } from "./workflow-data-flows";

// The widening check (DS-13c): everyone who can read a store's rows may use each of its sources.
// It is asked of the instance as it would be once a change is made, beside the instance as it
// is now, so a change is asked to confirm only whom it newly hands a source's data to: a gap
// that was confirmed before, or that a later grant change opened, is the store page's to show.
//
// A store is a Data Store, or a Knowledge Base with synced sources, whose documents are rows of
// their own. A reader of a Data Store is a person who may read its rows: through
// `data_store.read` on the store, through `app.use` on an App whose `sql` actions read it, or
// through `knowledge_base.use` on a Knowledge Base on it. A reader of a Knowledge Base with
// synced sources is who may use it. A source of a Data Store is every Connection a published
// App, Workflow or agent that adds rows to the store calls, as the store's page counts them
// (DS-13a); a source of a Knowledge Base is the Connection of each synced source. Each person's
// rights are decided by the one evaluator, so a deny, a role, a group or a workspace
// availability counts as it does at a call. People are counted and never named.

const APP_KIND = "app";
const AGENT_KIND = "agent";
const APP_USE = "app.use";

/** How many people one page of the instance's people holds while the check reads them. */
const PEOPLE_PAGE = 200;

/** The ways into a store's rows, and its sources, in one state of the instance. */
interface StoreState {
  ways: { action: string; resource: AccessResource }[];
  sources: Set<string>;
}

/** One store the change reaches: as it is now and as it would be. */
interface Checked {
  store: ConfigAssetRecord;
  before: StoreState;
  after: StoreState;
}

const storeTitleSchema = z.object({ title: z.string().min(1) });
const appActionsSchema = z.object({
  manifest: z.object({ actions: z.array(z.unknown()) })
});
const sqlActionSchema = z.object({ kind: z.literal("sql"), dataStore: z.string() });
const workflowSchema = z.object({
  manifest: z.object({ steps: z.unknown(), tools: z.array(z.string()).optional() })
});
const agentToolsSchema = z.object({ toolNames: z.array(z.string()) });
const knowledgeBaseSchema = z.object({ backend: z.object({ dataStore: z.string() }) });
const syncedSourcesSchema = z.object({
  sources: z.array(z.object({ connection: z.string() })).min(1)
});

/** What an asset's live config is: an agent's own config, the published one of any other. */
function liveConfig(asset: ConfigAssetRecord): JsonObject | null {
  return (asset.kind === AGENT_KIND ? asset.config : asset.publishedConfig) ?? null;
}

/** The Data Stores of operations that name one. */
function storesOfOperations(operations: readonly string[]): string[] {
  return operations.flatMap((operation) =>
    operation.startsWith(DATA_STORE_OPERATION_PREFIX)
      ? [operation.slice(DATA_STORE_OPERATION_PREFIX.length).split(".")[0] ?? ""]
      : []
  );
}

/** The Data Stores a config of an asset names, by its kind. */
function storesNamed(kind: string, config: JsonObject | null): string[] {
  if (kind === DATA_STORE_ASSET_KIND) return [];
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
    return storesOfOperations([
      ...workflowStepsDeep(parsed.data.manifest.steps).flatMap((step) =>
        step.type === "operation" && typeof step.operation === "string" ? [step.operation] : []
      ),
      ...(parsed.data.manifest.tools ?? [])
    ]);
  }
  if (kind === AGENT_KIND) {
    const parsed = agentToolsSchema.safeParse(config);
    return parsed.success ? storesOfOperations(parsed.data.toolNames) : [];
  }
  if (kind === KNOWLEDGE_BASE_ASSET_KIND) {
    const parsed = knowledgeBaseSchema.safeParse(config);
    return parsed.success ? [parsed.data.backend.dataStore] : [];
  }
  return [];
}

/** The Connections of a Knowledge Base's synced sources, or nothing. */
function syncedSources(base: ConfigAssetRecord): Set<string> | undefined {
  const parsed = syncedSourcesSchema.safeParse(liveConfig(base));
  return parsed.success
    ? new Set(parsed.data.sources.map((source) => source.connection))
    : undefined;
}

interface PublishedAssets {
  apps: readonly ConfigAssetRecord[];
  workflows: readonly ConfigAssetRecord[];
  knowledgeBases: readonly ConfigAssetRecord[];
  agents: readonly ConfigAssetRecord[];
}

/** The ways in and the sources of one Data Store, in one state of the published assets. */
function storeState(
  store: ConfigAssetRecord,
  assets: PublishedAssets,
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

/** A Knowledge Base with synced sources as a store: who may use it, and its Connections. */
function syncedState(base: ConfigAssetRecord | undefined): StoreState {
  if (!base) return { ways: [], sources: new Set() };
  return {
    ways: [{ action: KNOWLEDGE_BASE_ACTIONS.use, resource: assetResource(base) }],
    sources: syncedSources(base) ?? new Set()
  };
}

/** The published assets of a kind with each asset a change makes live in its place. */
function withChanged(
  live: readonly ConfigAssetRecord[],
  changed: readonly ConfigAssetRecord[],
  kind: string
): ConfigAssetRecord[] {
  const theirs = changed.filter((asset) => asset.kind === kind);
  const replaced = new Set(theirs.map((asset) => asset.id));
  return [...live.filter((asset) => !replaced.has(asset.id)), ...theirs];
}

/** An asset as a change leaves it: its config, its App availability and its owner. */
function asChanged(asset: ConfigAssetRecord, change: DataHandoverPublish): ConfigAssetRecord {
  return {
    ...asset,
    ...(change.config === undefined
      ? {}
      : asset.kind === AGENT_KIND
        ? { config: change.config }
        : { publishedConfig: change.config ?? undefined }),
    ...(change.appAvailability ? { appAvailability: change.appAvailability } : {}),
    ...(change.scope
      ? {
          scope:
            change.scope.kind === "workspace"
              ? {
                  kind: "workspace" as const,
                  workspaceId: asCollaborationWorkspaceId(change.scope.workspaceId)
                }
              : { kind: "instance" as const }
        }
      : {})
  };
}

/** An asset the change makes, as it would be stored: no id or revision of its own yet. */
function madeBy(
  clientInstanceId: DataStoreRuntime["clientInstanceId"],
  change: DataHandoverPublish
): ConfigAssetRecord {
  return {
    id: `new:${change.kind}:${change.name}`,
    clientInstanceId,
    kind: change.kind,
    name: change.name,
    scope: { kind: "instance" },
    status: "active",
    activeRevisionId: "",
    revision: 0,
    config: change.config ?? null,
    createdAt: "",
    updatedAt: ""
  };
}

/** One sha256 over who the change hands which source's data to, as the confirmation. */
function confirmationOf(
  newly: ReadonlyMap<string, Set<string>>,
  truncated: { stores: readonly string[]; pairs: readonly string[] } | undefined
): string | undefined {
  const entries = [...newly.entries()]
    .filter(([, people]) => people.size > 0)
    .map(([pair, people]) => [pair, [...people].sort()] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  if (entries.length === 0 && truncated === undefined) return undefined;
  return createHash("sha256")
    .update(JSON.stringify(truncated ? { entries, truncated } : entries))
    .digest("hex");
}

/**
 * The workspaces an asset offered as `availability` is used in, for a person who is a member
 * of `memberWorkspaceIds`: as the store reads availability (`availableThroughMembership`).
 */
function availableTo(
  availability: AgentAvailability,
  memberWorkspaceIds: readonly string[],
  personal: (workspaceId: string) => boolean
): boolean {
  if (availability.mode === "all") return memberWorkspaceIds.length > 0;
  return memberWorkspaceIds.some(
    (workspaceId) =>
      (availability.personalWorkspaces && personal(workspaceId)) ||
      availability.collaborationWorkspaceIds.some((id) => id === workspaceId)
  );
}

/**
 * Asks the invariant of the stores a change reaches, for the caller: the readers of each store
 * once the change is made, and per source how many of them may not use it, how many of those
 * the change newly hands the data to, and whether the caller may confirm that.
 */
async function checkDataHandover(
  runtime: DataStoreRuntime,
  access: ActorAccess | undefined,
  changes: readonly DataHandoverPublish[]
): Promise<DataHandoverAnswer> {
  const { clientInstanceId, stores } = runtime;
  const assetOf = (kind: string, name: string) =>
    stores.configAssets.getConfigAsset({ clientInstanceId, kind, name });
  // Each asset as it would be once the change is made. One the change makes is read as it
  // would be made, and nothing of it is there before.
  const found = (
    await Promise.all(
      changes.map(async (change) => {
        const asset = await assetOf(change.kind, change.name);
        if (asset?.status === "active") return [{ asset, change, fresh: change.fresh === true }];
        return change.config
          ? [{ asset: madeBy(clientInstanceId, change), change, fresh: true }]
          : [];
      })
    )
  ).flat();
  const fresh = new Set(found.flatMap(({ asset, fresh }) => (fresh ? [asset.id] : [])));
  const candidates = found.map(({ asset, change }) => asChanged(asset, change));
  const availability = new Map(
    found.flatMap(({ asset, change }) =>
      change.availability && asset.kind === KNOWLEDGE_BASE_ASSET_KIND
        ? [[asset.id, change.availability] as const]
        : []
    )
  );
  const named = [
    ...new Set([
      ...candidates.flatMap((asset) => storesNamed(asset.kind, liveConfig(asset))),
      ...candidates.flatMap((asset) => (asset.kind === DATA_STORE_ASSET_KIND ? [asset.name] : []))
    ])
  ];
  const syncedBases = candidates.filter(
    (asset) => asset.kind === KNOWLEDGE_BASE_ASSET_KIND && syncedSources(asset) !== undefined
  );
  if (named.length === 0 && syncedBases.length === 0) return { pairs: [], truncated: false };

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
      kind: AGENT_KIND,
      limit: DATA_STORE_USED_BY_MAX_ASSETS + 1
    }),
    Promise.all(named.map((name) => assetOf(DATA_STORE_ASSET_KIND, name)))
  ]);
  const truncated =
    Math.max(apps.length, workflows.length, knowledgeBases.length, agents.length) >
    DATA_STORE_USED_BY_MAX_ASSETS;
  const active = (assets: readonly ConfigAssetRecord[]) =>
    assets
      .slice(0, DATA_STORE_USED_BY_MAX_ASSETS)
      .filter((asset) => asset.status === "active" && !fresh.has(asset.id));
  const now: PublishedAssets = {
    apps: active(apps),
    workflows: active(workflows),
    knowledgeBases: active(knowledgeBases),
    agents: active(agents)
  };
  const then: PublishedAssets = {
    apps: withChanged(now.apps, candidates, APP_KIND),
    workflows: withChanged(now.workflows, candidates, WORKFLOW_ASSET_KIND),
    knowledgeBases: withChanged(now.knowledgeBases, candidates, KNOWLEDGE_BASE_ASSET_KIND),
    agents: withChanged(now.agents, candidates, AGENT_KIND)
  };
  const checked: Checked[] = [
    ...storeAssets.flatMap((store): Checked[] => {
      if (store?.status !== "active") return [];
      const moved = candidates.find((asset) => asset.id === store.id) ?? store;
      const after = storeState(moved, then, runtime.defaultLocale);
      if (after.sources.size === 0) return [];
      return [{ store, before: storeState(store, now, runtime.defaultLocale), after }];
    }),
    ...syncedBases.map((base) => ({
      store: base,
      before: syncedState(now.knowledgeBases.find((live) => live.id === base.id)),
      after: syncedState(base)
    }))
  ];
  if (checked.length === 0) {
    // A source among the assets the read did not reach cannot be told: it is never let pass.
    const confirmation = truncated
      ? confirmationOf(new Map(), { stores: named, pairs: [] })
      : undefined;
    return { pairs: [], ...(confirmation ? { confirmation } : {}), truncated };
  }

  // Each source once, as the evaluator reads it. A Connection that is gone gives no data any more.
  const connectionNames = [...new Set(checked.flatMap(({ after }) => [...after.sources]))];
  const connections = new Map(
    (await Promise.all(connectionNames.map((name) => assetOf(CONNECTION_ASSET_KIND, name))))
      .filter((asset): asset is ConfigAssetRecord => asset?.status === "active")
      .map((asset) => [asset.name, asset] as const)
  );

  // Whether a workspace is a person's own, for an availability that offers those.
  const personal = new Map<string, boolean>();
  const personalWorkspace = async (workspaceId: string): Promise<boolean> => {
    const known = personal.get(workspaceId);
    if (known !== undefined) return known;
    const workspace = await stores.workspaces.getWorkspace(
      clientInstanceId,
      asCollaborationWorkspaceId(workspaceId)
    );
    const own = workspace?.kind === "personal";
    personal.set(workspaceId, own);
    return own;
  };
  /** What a person's rights would be once the change is made: the availability it sets. */
  const thenPersisted = async (persisted: PersistedAccess): Promise<PersistedAccess> => {
    if (availability.size === 0) return persisted;
    const members = persisted.memberWorkspaceIds ?? [];
    const own = new Set<string>();
    for (const workspaceId of members)
      if (await personalWorkspace(workspaceId)) own.add(workspaceId);
    const kept = (persisted.availableAssets ?? []).filter(
      (asset) => !availability.has(asset.assetId)
    );
    const gained: NonNullable<PersistedAccess["availableAssets"]> = [
      ...availability.entries()
    ].flatMap(([assetId, offer]) =>
      availableTo(offer, members, (workspaceId) => own.has(workspaceId))
        ? [{ assetId, kind: KNOWLEDGE_BASE_ASSET_KIND }]
        : []
    );
    return { ...persisted, availableAssets: [...kept, ...gained] };
  };

  const key = (store: string, connection: string) => `${store}\u0000${connection}`;
  const storeKey = (store: ConfigAssetRecord) => `${store.kind}:${store.name}`;
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
      const holder = {
        kind: "user" as const,
        id: person.id,
        clientInstanceId,
        roles: person.roles,
        permissionRefs: person.permissionRefs
      };
      const theirs = createActorAccess(holder, persisted);
      const theirsThen =
        availability.size === 0
          ? theirs
          : createActorAccess(holder, await thenPersisted(persisted));
      const reads = (state: StoreState, rights: ActorAccess) =>
        state.ways.some(({ action, resource }) => rights.authorize(action, resource).allowed);
      for (const { store, before, after: next } of checked) {
        if (!reads(next, theirsThen)) continue;
        const name = storeKey(store);
        readers.set(name, (readers.get(name) ?? 0) + 1);
        const readBefore = reads(before, theirs);
        for (const source of next.sources) {
          const connection = connections.get(source);
          if (!connection) continue;
          if (theirsThen.authorize(CONNECTION_ACTIONS.use, assetResource(connection)).allowed)
            continue;
          const pair = key(name, source);
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

  const shownBy = (rights: readonly string[], resource: AccessResource) =>
    access !== undefined && rights.some((right) => access.authorize(right, resource).allowed);
  const pairs: DataHandoverPair[] = checked.flatMap(({ store, after: next }) => {
    const synced = store.kind === KNOWLEDGE_BASE_ASSET_KIND;
    const storeShown = shownBy(
      synced
        ? [KNOWLEDGE_BASE_ACTIONS.use, KNOWLEDGE_BASE_ACTIONS.read, KNOWLEDGE_BASE_ACTIONS.write]
        : [DATA_STORE_ACTIONS.read, DATA_STORE_ACTIONS.write],
      assetResource(store)
    );
    const title =
      (storeShown
        ? storeTitleSchema.safeParse(liveConfig(store) ?? store.config).data?.title
        : undefined) ?? store.name;
    const name = storeKey(store);
    return [...next.sources].flatMap((source) => {
      const connection = connections.get(source);
      if (!connection) return [];
      const resource = assetResource(connection);
      // Who may confirm the hand-over sees what they confirm.
      const connectionShown = shownBy(
        [CONNECTION_ACTIONS.read, CONNECTION_ACTIONS.use, CONNECTION_ACTIONS.write],
        resource
      );
      const connectionTitle = z
        .object({ displayName: z.string().min(1) })
        .safeParse(connection.config).data?.displayName;
      const pair = key(name, source);
      return [
        {
          store: { kind: store.kind, name: store.name, title },
          connection: {
            name: source,
            assetId: connection.id,
            ...(connection.scope.kind === "workspace"
              ? { workspaceId: connection.scope.workspaceId }
              : {}),
            ...(connectionShown ? { title: connectionTitle ?? source } : {})
          },
          readers: readers.get(name) ?? 0,
          lacking: lacking.get(pair) ?? 0,
          newlyLacking: newly.get(pair)?.size ?? 0,
          mayConfirm:
            access !== undefined && access.authorize(CONNECTION_ACTIONS.write, resource).allowed
        }
      ];
    });
  });
  const confirmation = confirmationOf(
    newly,
    truncated
      ? {
          stores: checked.map(({ store }) => storeKey(store)).sort(),
          pairs: pairs
            .map((pair) => key(`${pair.store.kind}:${pair.store.name}`, pair.connection.name))
            .sort()
        }
      : undefined
  );
  return { pairs, ...(confirmation ? { confirmation } : {}), truncated };
}

/** The widening check of the stored-data module. */
export function createDataHandover(runtime: DataStoreRuntime): DataHandover {
  return { check: (access, changes) => checkDataHandover(runtime, access, changes) };
}
