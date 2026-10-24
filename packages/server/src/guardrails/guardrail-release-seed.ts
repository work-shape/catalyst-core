import {
  guardrailConfigSchema,
  guardrailFromRelease,
  type ReleaseGuardrailConfig
} from "@work-shape/catalyst-config-schema";
import {
  GUARDRAIL_ASSET_KIND,
  sameJson,
  type AuditActor,
  type ClientInstanceId,
  type ConfigAssetRecord,
  type ConfigAssetMutation,
  type JsonObject,
  type PlatformStores
} from "@work-shape/catalyst-core";

// The release seed of Guardrails. When the API process starts it makes the stored Guardrails of
// release config equal to `guardrails` of release config, each published: in one transaction,
// under one lock, so two processes that start together write once. Build lists what it stored.
// The guardrails of the floor that run are read from release config itself, so a seed that has
// not run yet checks nothing less. A guardrail written as an asset is never touched.

/** Who a seeded revision is written by. */
const SYSTEM_ACTOR: AuditActor = { displayLabel: "System", roles: [] };

/** What one start changed, by Guardrail name. */
export interface GuardrailSeedResult {
  created: string[];
  updated: string[];
  removed: string[];
  /**
   * Names of release config a guardrail written as an asset holds already. The floor runs
   * from release config all the same; the store keeps the asset, and Build lists it.
   */
  conflicts: string[];
}

function toJsonObject(name: string, entry: ReleaseGuardrailConfig): JsonObject {
  // Parsed again so the stored revision holds exactly what the kind reads.
  const guardrail = guardrailConfigSchema.parse(guardrailFromRelease(name, entry));
  return {
    name: guardrail.name,
    displayName: guardrail.displayName,
    ...(guardrail.description === undefined ? {} : { description: guardrail.description }),
    on: guardrail.on,
    ...(guardrail.filter === undefined ? {} : { filter: { ...guardrail.filter } }),
    check: { ...guardrail.check },
    outcome: guardrail.outcome,
    origin: guardrail.origin
  };
}

/**
 * Reconciles the stored Guardrails with release config. Safe to run in several processes at
 * once and on every start: a start that finds everything as config says writes no revision.
 */
export async function seedReleaseGuardrails(input: {
  clientInstanceId: ClientInstanceId;
  /** `guardrails` of release config. */
  guardrails: Readonly<Record<string, ReleaseGuardrailConfig>>;
  /** The guardrails' records and the config assets, written in one transaction. */
  stores: {
    transaction<Result>(
      fn: (stores: Pick<PlatformStores, "guardrails" | "configAssets">) => Promise<Result>
    ): Promise<Result>;
  };
}): Promise<GuardrailSeedResult> {
  const { clientInstanceId } = input;
  const configured = new Map(
    Object.entries(input.guardrails).map(([name, entry]) => [name, toJsonObject(name, entry)])
  );
  return input.stores.transaction(async (stores) => {
    await stores.guardrails.lockReleaseSeed({ clientInstanceId });
    const active = await stores.configAssets.listActiveConfigAssets({
      clientInstanceId,
      kind: GUARDRAIL_ASSET_KIND
    });
    const isRelease = (asset: ConfigAssetRecord) => asset.config?.origin === "release";
    const stored = new Map(active.filter(isRelease).map((asset) => [asset.name, asset]));
    const assets = new Set(active.filter((asset) => !isRelease(asset)).map((asset) => asset.name));
    const result: GuardrailSeedResult = { created: [], updated: [], removed: [], conflicts: [] };
    const mutations: ConfigAssetMutation[] = [];
    const baseRevisions: Record<string, number | null> = {};
    for (const [name, config] of configured) {
      if (assets.has(name)) {
        result.conflicts.push(name);
        continue;
      }
      const asset = stored.get(name);
      if (asset && sameJson(asset.config, config)) continue;
      mutations.push({ type: "upsert", kind: GUARDRAIL_ASSET_KIND, name, config });
      // A name release config had once and dropped left a deleted row: the seed that brings
      // the entry back continues its revisions.
      const row =
        asset ??
        (await stores.configAssets.getConfigAsset({
          clientInstanceId,
          kind: GUARDRAIL_ASSET_KIND,
          name
        }));
      baseRevisions[`${GUARDRAIL_ASSET_KIND}:${name}`] = row?.revision ?? null;
      (asset ? result.updated : result.created).push(name);
    }
    for (const asset of stored.values()) {
      if (configured.has(asset.name)) continue;
      mutations.push({ type: "delete", kind: GUARDRAIL_ASSET_KIND, name: asset.name });
      baseRevisions[`${GUARDRAIL_ASSET_KIND}:${asset.name}`] = asset.revision;
      result.removed.push(asset.name);
    }
    if (mutations.length > 0) {
      await stores.configAssets.applyConfigAssetMutations({
        clientInstanceId,
        actor: SYSTEM_ACTOR,
        baseRevisions,
        mutations
      });
    }
    // The floor is live as written: each guardrail of release config is published at its
    // newest revision, also one a seed before this release wrote as the only revision.
    for (const name of configured.keys()) {
      if (assets.has(name)) continue;
      const asset = await stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: GUARDRAIL_ASSET_KIND,
        name
      });
      if (
        !asset ||
        asset.status !== "active" ||
        asset.publishedRevisionId === asset.activeRevisionId
      ) {
        continue;
      }
      await stores.configAssets.publishConfigAssetRevision({
        clientInstanceId,
        kind: GUARDRAIL_ASSET_KIND,
        name,
        assetId: asset.id,
        revision: asset.revision,
        revisionId: asset.activeRevisionId
      });
    }
    return result;
  });
}
