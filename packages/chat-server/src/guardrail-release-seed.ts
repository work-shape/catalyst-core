import {
  guardrailConfigSchema,
  guardrailFromRelease,
  type ReleaseGuardrailConfig
} from "@vivd-catalyst/config-schema";
import {
  GUARDRAIL_ASSET_KIND,
  sameJson,
  type AuditActor,
  type ClientInstanceId,
  type ConfigAssetMutation,
  type JsonObject,
  type PlatformStores
} from "@vivd-catalyst/core";

// The release seed of Guardrails. When the API process starts it makes the stored Guardrails
// equal to `guardrails` of release config: in one transaction, under one lock, so two
// processes that start together write once. Build lists what it stored. The guardrails that
// run are read from release config itself, so a seed that has not run yet checks nothing less.

/** Who a seeded revision is written by. */
const SYSTEM_ACTOR: AuditActor = { displayLabel: "System", roles: [] };

/** What one start changed, by Guardrail name. */
export interface GuardrailSeedResult {
  created: string[];
  updated: string[];
  removed: string[];
}

function toJsonObject(name: string, entry: ReleaseGuardrailConfig): JsonObject {
  // Parsed again so the stored revision holds exactly what the kind reads.
  const guardrail = guardrailConfigSchema.parse(guardrailFromRelease(name, entry));
  return {
    name: guardrail.name,
    displayName: guardrail.displayName,
    ...(guardrail.description === undefined ? {} : { description: guardrail.description }),
    on: guardrail.on,
    ...(guardrail.filter?.kind === undefined ? {} : { filter: { kind: guardrail.filter.kind } }),
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
  stores: PlatformStores;
}): Promise<GuardrailSeedResult> {
  const { clientInstanceId } = input;
  const configured = new Map(
    Object.entries(input.guardrails).map(([name, entry]) => [name, toJsonObject(name, entry)])
  );
  return input.stores.transaction(async (stores) => {
    await stores.guardrails.lockReleaseSeed({ clientInstanceId });
    const stored = new Map(
      (
        await stores.configAssets.listActiveConfigAssets({
          clientInstanceId,
          kind: GUARDRAIL_ASSET_KIND
        })
      ).map((asset) => [asset.name, asset])
    );
    const result: GuardrailSeedResult = { created: [], updated: [], removed: [] };
    const mutations: ConfigAssetMutation[] = [];
    const baseRevisions: Record<string, number | null> = {};
    for (const [name, config] of configured) {
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
    return result;
  });
}
