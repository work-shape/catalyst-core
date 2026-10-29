import { declaredDataStoresOf } from "@work-shape/catalyst-app-build";
import {
  AppError,
  DATA_STORE_ACTIONS,
  DATA_STORE_ASSET_KIND,
  WORKFLOW_ASSET_KIND,
  appReachesDataStore,
  dataStoreRefusalError,
  type ActorAccess,
  type AssetScope,
  type ConfigAssetRecord,
  type JsonObject
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { accessResource } from "../assets/asset-access";
import type { AssetWorkflowOptions } from "../types";

// The Workflows an App's revision reaches (DP-3): those its `workflow` actions name and,
// through the revision of each that would be live, their child Workflows. It is computed when
// it is needed and never stored. Spec: events-workflows-and-guardrails.md, LIVE-2; the
// drafts-together design, section 3.

type ClosureOptions = Pick<AssetWorkflowOptions, "clientInstanceId" | "configAssets">;

/** One Workflow of an App's closure. */
export interface ClosureWorkflow {
  name: string;
  /** Its row, where an active Workflow of the name stands where the App reaches it. */
  asset: ConfigAssetRecord | undefined;
}

/**
 * The Workflows `config`, an App's revision, reaches, children before the Workflows that start
 * them, each once. `liveConfig` says which revision of a Workflow its children are read from:
 * the one that would be live. A Workflow that is missing, inactive or out of the App's reach is
 * listed without its row and its children are not read.
 */
export async function appWorkflowClosure(
  options: ClosureOptions,
  app: { scope: AssetScope; config: JsonObject },
  liveConfig: (asset: ConfigAssetRecord) => JsonObject | undefined
): Promise<ClosureWorkflow[]> {
  const ordered: ClosureWorkflow[] = [];
  const seen = new Set<string>();
  const workflowsOf = (kind: string, config: JsonObject) =>
    (options.configAssets.kinds.get(kind)?.references?.(config) ?? [])
      .filter((reference) => reference.kind === WORKFLOW_ASSET_KIND)
      .map(({ name }) => name);
  const visit = async (name: string): Promise<void> => {
    if (seen.has(name)) return;
    seen.add(name);
    const row = await options.configAssets.store.getConfigAsset({
      clientInstanceId: options.clientInstanceId,
      kind: WORKFLOW_ASSET_KIND,
      name
    });
    const asset =
      row?.status === "active" && appReachesDataStore(app.scope, row.scope) ? row : undefined;
    const config = asset ? liveConfig(asset) : undefined;
    for (const child of config ? workflowsOf(WORKFLOW_ASSET_KIND, config) : []) {
      await visit(child);
    }
    ordered.push({ name, asset });
  };
  for (const name of workflowsOf("app", app.config)) await visit(name);
  return ordered;
}

/** An asset's title as a person reads it: its own title, its manifest's name, or its name. */
export function assetTitle(config: JsonObject | null | undefined, name: string): string {
  const manifest = config?.manifest;
  const named =
    typeof config?.title === "string" && config.title.length > 0
      ? config.title
      : typeof manifest === "object" && manifest !== null && "name" in manifest
        ? manifest.name
        : undefined;
  return typeof named === "string" && named.length > 0 ? named : name;
}

/** A Workflow draft has changes its published revision does not, or was never published. */
export function workflowPending(asset: ConfigAssetRecord): boolean {
  return asset.publishedRevision === undefined || asset.publishedRevision !== asset.revision;
}

/**
 * The Workflows a publish of an App names to make live with it, checked against the App's
 * closure and ordered children first: each one once, active, reached by the App's revision
 * through the revisions that would be live, and named at a revision of its own.
 */
export async function workflowsPublishedWith(
  options: ClosureOptions,
  app: { scope: AssetScope; config: JsonObject },
  named: readonly { name: string; revision: number }[]
): Promise<{ name: string; revision: number; asset: ConfigAssetRecord }[]> {
  const revisions = new Map<string, number>();
  for (const { name, revision } of named) {
    if (revisions.has(name)) {
      throw new AppError("VALIDATION_FAILED", `The Workflow '${name}' is named twice`, {
        reason: "workflow_named_twice",
        workflow: name
      });
    }
    revisions.set(name, revision);
  }
  // The revision of each named Workflow that would be live is the one named.
  const configs = new Map<string, JsonObject>();
  for (const [name, revision] of revisions) {
    const stored = await options.configAssets.store.getConfigAssetRevision({
      clientInstanceId: options.clientInstanceId,
      kind: WORKFLOW_ASSET_KIND,
      name,
      revision
    });
    if (stored?.config) configs.set(name, stored.config);
  }
  const closure = await appWorkflowClosure(
    options,
    app,
    (asset) => configs.get(asset.name) ?? asset.publishedConfig
  );
  const reached = new Map(closure.map((member) => [member.name, member.asset]));
  for (const name of revisions.keys()) {
    if (!reached.get(name)) {
      throw new AppError(
        "VALIDATION_FAILED",
        `The App's revision does not reach the Workflow '${name}', so it is not published with it`,
        { reason: "workflow_not_reached", workflow: name },
        { exposeMessage: true }
      );
    }
  }
  return closure.flatMap(({ name, asset }) => {
    const revision = revisions.get(name);
    return asset && revision !== undefined ? [{ name, revision, asset }] : [];
  });
}

/** A Data Store a publish of an App names to publish with it (GOLIVE-1). */
export interface StorePublishedWith {
  name: string;
  revision: number;
  asset: ConfigAssetRecord;
  title: string;
  /** The level the named revision brings the store to: the number of its last migration. */
  level: number;
  /** The names of the named revision's migrations, by number. */
  migrations: ReadonlyMap<number, string>;
  /** The level the App needs, and whether the named revision has a config to tell its level. */
  minSchema: number | undefined;
  stored: boolean;
}

const storeMigrationsSchema = z.object({
  migrations: z.array(z.object({ number: z.number(), name: z.string() }))
});

/** The migrations a revision of a Data Store holds, by number, and the last one's number. */
export function storeMigrationsOf(config: unknown): {
  level: number;
  migrations: Map<number, string>;
} {
  const listed = storeMigrationsSchema.safeParse(config).data?.migrations ?? [];
  return {
    level: Math.max(0, ...listed.map(({ number }) => number)),
    migrations: new Map(listed.map(({ number, name }) => [number, name]))
  };
}

/** The revision of an App or a Workflow whose Publish carries the Data Stores it binds. */
export interface StoreBinder {
  /** `app` or `workflow`. */
  kind: string;
  scope: AssetScope;
  config: JsonObject;
}

/**
 * The Data Stores a revision binds, each once (LIVE-2): an App's those its manifest lists under
 * `dataStores`, with the level it asks of each; a Workflow's those its steps and tools call,
 * which ask no level beyond the store's live revision.
 */
function storesBoundBy(
  options: Pick<ClosureOptions, "configAssets">,
  binder: StoreBinder
): { name: string; minSchema: number | undefined }[] {
  if (binder.kind !== WORKFLOW_ASSET_KIND) {
    return declaredDataStoresOf(binder.config.manifest).map(({ name, minSchema }) => ({
      name,
      minSchema
    }));
  }
  const references = options.configAssets.kinds
    .get(WORKFLOW_ASSET_KIND)
    ?.references?.(binder.config);
  const names = new Set(
    (references ?? []).filter(({ kind }) => kind === DATA_STORE_ASSET_KIND).map(({ name }) => name)
  );
  return [...names].map((name) => ({ name, minSchema: undefined }));
}

/**
 * The Data Stores a publish of an App or a Workflow names to publish with it, checked against
 * its revision: each once, bound by it, active where it reaches it, and named at a revision
 * that reaches the level an App asks of it. So no store is published for an App or a Workflow
 * that could not use it.
 */
export async function dataStoresPublishedWith(
  options: ClosureOptions,
  app: StoreBinder,
  named: readonly { name: string; revision: number }[]
): Promise<StorePublishedWith[]> {
  const bound = new Map(
    storesBoundBy(options, app).map(({ name, minSchema }) => [name, minSchema])
  );
  const seen = new Set<string>();
  const stores: StorePublishedWith[] = [];
  for (const { name, revision } of named) {
    if (seen.has(name)) {
      throw new AppError("VALIDATION_FAILED", `The Data Store '${name}' is named twice`, {
        reason: "data_store_named_twice",
        dataStore: name
      });
    }
    seen.add(name);
    if (!bound.has(name)) throw dataStoreRefusalError("data_store_not_reached", name);
    const asset = await options.configAssets.store.getConfigAsset({
      clientInstanceId: options.clientInstanceId,
      kind: DATA_STORE_ASSET_KIND,
      name
    });
    if (asset?.status !== "active" || !appReachesDataStore(app.scope, asset.scope)) {
      throw dataStoreRefusalError("data_store_unavailable", name);
    }
    const stored = await options.configAssets.store.getConfigAssetRevision({
      clientInstanceId: options.clientInstanceId,
      kind: DATA_STORE_ASSET_KIND,
      name,
      revision
    });
    const title = assetTitle(stored?.config, name);
    const { level, migrations } = storeMigrationsOf(stored?.config);
    stores.push({
      name,
      revision,
      asset,
      title,
      level,
      migrations,
      minSchema: bound.get(name),
      stored: stored?.config !== undefined
    });
  }
  return stores;
}

/**
 * Refuses a store whose named revision stays below the level the App needs. Asked only after
 * the caller's publish right on each store: the refusal names the store's title and level.
 */
export function requireStoreLevels(stores: readonly StorePublishedWith[]): void {
  for (const { name, title, level, minSchema, stored } of stores) {
    if (stored && minSchema !== undefined && level < minSchema) {
      throw dataStoreRefusalError("data_store_draft_below_min_schema", name, {
        title,
        minSchema,
        level
      });
    }
  }
}

/** A Data Store the App's revision binds whose live revision is still being applied. */
export interface StoreStillMigrating {
  name: string;
  title: string;
  asset: ConfigAssetRecord;
  /** The level the store's record is at now. */
  recordLevel: number;
  /** The level its live revision brings it to: the number of that revision's last migration. */
  level: number;
  /** The names of the live revision's migrations, by number. */
  migrations: ReadonlyMap<number, string>;
}

/**
 * The Data Stores the revision binds that are live and not yet at the level it needs, where
 * their live revision reaches it (GOLIVE-1, LIVE-2): an earlier Publish published them and its
 * wait ran out. An App needs the level its manifest asks; a Workflow the level of the store's
 * live revision. A Publish waits for them as for a store it publishes, so publishing again
 * carries on. A store named in `skip` is published by the Publish itself; one that is not there
 * for an App or whose live revision stays below is refused by the App's own publish.
 */
export async function storesStillMigrating(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "configAssets" | "stores">,
  app: StoreBinder,
  skip: ReadonlySet<string> = new Set()
): Promise<StoreStillMigrating[]> {
  const { clientInstanceId } = options;
  const migrating: StoreStillMigrating[] = [];
  const asksLevel = app.kind !== WORKFLOW_ASSET_KIND;
  for (const { name, minSchema } of storesBoundBy(options, app)) {
    if ((asksLevel && minSchema === undefined) || skip.has(name)) continue;
    const asset = await options.configAssets.store.getConfigAsset({
      clientInstanceId,
      kind: DATA_STORE_ASSET_KIND,
      name
    });
    if (
      asset?.status !== "active" ||
      asset.publishedConfig === undefined ||
      !appReachesDataStore(app.scope, asset.scope)
    ) {
      continue;
    }
    const record = await options.stores.dataStores.getDataStore({ clientInstanceId, id: asset.id });
    const { level, migrations } = storeMigrationsOf(asset.publishedConfig);
    const needed = minSchema ?? level;
    if (!record || record.status === "retired" || record.level >= needed) continue;
    if (level < needed) continue;
    migrating.push({
      name,
      title: assetTitle(asset.publishedConfig, name),
      asset,
      recordLevel: record.level,
      level,
      migrations
    });
  }
  return migrating;
}

/** A Data Store a Workflow's Publish would publish with it, as its question names it (LIVE-2). */
export interface StorePendingWith {
  name: string;
  title: string;
  /** The store's draft revision, which the publish names. */
  revision: number;
  publishedRevision?: number;
  /** The number of the last migration the store has applied. Zero before the first. */
  liveLevel: number;
  /** The names of the draft's migrations above the live level, in the order they apply. */
  pendingMigrations: string[];
}

/**
 * The Data Stores a Workflow's revision calls whose draft is not published and which `access`
 * may publish (LIVE-2): one Publish of the Workflow names them and publishes each first. A
 * store the reader may not publish is not named, as a store's level is told only to who may
 * publish it; the Workflow's Publish then leaves it as it is, as before.
 */
export async function storesPendingWith(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "configAssets" | "stores">,
  binder: StoreBinder,
  access: Pick<ActorAccess, "authorize">
): Promise<StorePendingWith[]> {
  const { clientInstanceId } = options;
  const pending: StorePendingWith[] = [];
  for (const { name } of storesBoundBy(options, binder)) {
    const asset = await options.configAssets.store.getConfigAsset({
      clientInstanceId,
      kind: DATA_STORE_ASSET_KIND,
      name
    });
    if (
      asset?.status !== "active" ||
      !appReachesDataStore(binder.scope, asset.scope) ||
      asset.publishedRevision === asset.revision ||
      !access.authorize(
        DATA_STORE_ACTIONS.publish,
        accessResource(DATA_STORE_ASSET_KIND, name, asset.scope, asset.id)
      ).allowed
    ) {
      continue;
    }
    const record = await options.stores.dataStores.getDataStore({ clientInstanceId, id: asset.id });
    const liveLevel = record?.level ?? 0;
    const draft = storeMigrationsOf(asset.config);
    pending.push({
      name,
      title: assetTitle(asset.config, name),
      revision: asset.revision,
      ...(asset.publishedRevision === undefined
        ? {}
        : { publishedRevision: asset.publishedRevision }),
      liveLevel,
      pendingMigrations: [...draft.migrations]
        .filter(([number]) => number > liveLevel)
        .sort(([a], [b]) => a - b)
        .map(([, migration]) => migration)
    });
  }
  return pending;
}
