import { skillConfigSchema } from "@vivd-catalyst/config-schema";
import {
  AppError,
  isAppError,
  type AuditActor,
  type ClientInstanceId,
  type ConfigAssetMutation,
  type ConfigAssetRecord,
  type JsonObject,
  type PlatformStores,
  type ShippedSkill
} from "@vivd-catalyst/core";
import { configValuesEqual, readDefinitionField } from "./asset-kinds/shared";

// The seed of the skills that ship with the platform. When the API process starts it makes the
// stored skills of origin `release` equal to what this build ships: a new one is created, a
// changed one gets a revision, and one the build no longer ships is deleted. It writes to the
// store and through no operation, which refuse every write to such a skill.

const SKILL_KIND = "skill";

/** Who a seeded revision is written by, as History shows it. */
const SYSTEM_ACTOR: AuditActor = { displayLabel: "System", roles: [] };

/** What one start changed, by skill name. */
export interface ShippedSkillSeedResult {
  created: string[];
  updated: string[];
  removed: string[];
}

export interface SeedShippedSkillsInput {
  clientInstanceId: ClientInstanceId;
  stores: Pick<PlatformStores, "configAssets">;
  /** What this build ships, with the modules that are on. */
  skills: readonly ShippedSkill[];
}

function definitionOf(skill: ShippedSkill): JsonObject {
  const parsed = skillConfigSchema.safeParse({ ...skill, origin: "release" });
  if (!parsed.success) {
    throw new AppError(
      "INTERNAL",
      `The platform ships the skill '${skill.name}', which is no valid skill: ${parsed.error.issues[0]?.message ?? ""}`
    );
  }
  const { name, title, description, content, resources, icon } = parsed.data;
  return {
    name,
    title,
    description,
    content,
    ...(resources?.length ? { resources } : {}),
    origin: "release",
    ...(icon ? { icon } : {})
  };
}

const isShipped = (asset: ConfigAssetRecord) =>
  readDefinitionField(asset.config, "origin") === "release";

/**
 * Reconciles the stored skills of origin `release` with what this build ships. Safe on every
 * start and in several processes at once: a start that finds everything as shipped writes
 * nothing, and one that lost a race to another start reads again and finds that.
 */
export async function seedShippedSkills(
  input: SeedShippedSkillsInput
): Promise<ShippedSkillSeedResult> {
  try {
    return await reconcile(input);
  } catch (error) {
    // A write against revisions another start changed answers REVISION_CONFLICT.
    if (!isAppError(error) || (error.code !== "REVISION_CONFLICT" && error.code !== "CONFLICT")) {
      throw error;
    }
    return reconcile(input);
  }
}

async function reconcile(input: SeedShippedSkillsInput): Promise<ShippedSkillSeedResult> {
  const { clientInstanceId } = input;
  const store = input.stores.configAssets;
  const shipped = new Map(input.skills.map((skill) => [skill.name, definitionOf(skill)]));
  const stored = new Map(
    (await store.listActiveConfigAssets({ clientInstanceId, kind: SKILL_KIND })).map((asset) => [
      asset.name,
      asset
    ])
  );
  const result: ShippedSkillSeedResult = { created: [], updated: [], removed: [] };
  const mutations: ConfigAssetMutation[] = [];
  const baseRevisions: Record<string, number | null> = {};
  for (const [name, config] of shipped) {
    const asset = stored.get(name);
    if (asset && !isShipped(asset)) {
      // A skill of the instance's own is never touched. The name is the platform's.
      throw new AppError(
        "VALIDATION_FAILED",
        `The platform ships the skill '${name}', and a skill of that name was created on the instance. Rename that skill: the name is reserved for the platform`
      );
    }
    if (asset && configValuesEqual(asset.config, config)) continue;
    // A skill the platform shipped once and dropped left a deleted row: the release that
    // brings it back continues its revisions.
    const row = asset ?? (await store.getConfigAsset({ clientInstanceId, kind: SKILL_KIND, name }));
    mutations.push({ type: "upsert", kind: SKILL_KIND, name, config });
    baseRevisions[`${SKILL_KIND}:${name}`] = row?.revision ?? null;
    (asset ? result.updated : result.created).push(name);
  }
  for (const asset of stored.values()) {
    if (!isShipped(asset) || shipped.has(asset.name)) continue;
    mutations.push({ type: "delete", kind: SKILL_KIND, name: asset.name });
    baseRevisions[`${SKILL_KIND}:${asset.name}`] = asset.revision;
    result.removed.push(asset.name);
  }
  if (mutations.length > 0) {
    await store.applyConfigAssetMutations({
      clientInstanceId,
      actor: SYSTEM_ACTOR,
      baseRevisions,
      mutations
    });
  }
  return result;
}
