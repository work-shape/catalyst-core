import { declaredDataStoresOf } from "@work-shape/catalyst-app-build";
import {
  AppError,
  DATA_STORE_ASSET_KIND,
  WORKFLOW_ASSET_KIND,
  appReachesDataStore,
  dataStoreRefusalError,
  type AssetScope,
  type ConfigAssetRecord,
  type JsonObject
} from "@work-shape/catalyst-core";
import { z } from "zod";
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

/**
 * The Data Stores a publish of an App names to publish with it, checked against the App's
 * revision: each once, bound by its manifest under `dataStores`, active where the App reaches
 * it, and named at a revision that reaches the level the App asks of it. So no store is
 * published for an App that could not use it.
 */
export async function dataStoresPublishedWith(
  options: ClosureOptions,
  app: { scope: AssetScope; config: JsonObject },
  named: readonly { name: string; revision: number }[]
): Promise<StorePublishedWith[]> {
  const bound = new Map(
    declaredDataStoresOf(app.config.manifest).map(({ name, minSchema }) => [name, minSchema])
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
 * The Data Stores the App's revision binds that are live and not yet at the level the App
 * needs, where their live revision reaches it (GOLIVE-1): an earlier Publish of the App
 * published them and its wait ran out. A Publish of the App waits for them as for a store it
 * publishes, so publishing again carries on. A store named in `skip` is published by the
 * Publish itself; one that is not there for the App or whose live revision stays below is
 * refused by the App's own publish.
 */
export async function storesStillMigrating(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "configAssets" | "stores">,
  app: { scope: AssetScope; config: JsonObject },
  skip: ReadonlySet<string> = new Set()
): Promise<StoreStillMigrating[]> {
  const { clientInstanceId } = options;
  const migrating: StoreStillMigrating[] = [];
  for (const { name, minSchema } of declaredDataStoresOf(app.config.manifest)) {
    if (minSchema === undefined || skip.has(name)) continue;
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
    if (!record || record.status === "retired" || record.level >= minSchema) continue;
    const { level, migrations } = storeMigrationsOf(asset.publishedConfig);
    if (level < minSchema) continue;
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
