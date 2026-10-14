import { skillConfigSchema } from "@vivd-catalyst/config-schema";
import {
  AppError,
  createPlatformId,
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
// changed one gets a revision, and one the build no longer ships is deleted. An agent that lists
// a skill being deleted gets a revision without it first, in the same write, or every later
// write of the instance would be refused for the reference it left. It writes to the store and
// through no operation, which refuse every write to such a skill.

const SKILL_KIND = "skill";
const AGENT_KIND = "agent";

/** Who a seeded revision is written by, as History shows it. */
const SYSTEM_ACTOR: AuditActor = { displayLabel: "System", roles: [] };

/** What one start changed, by skill name. */
export interface ShippedSkillSeedResult {
  created: string[];
  updated: string[];
  removed: string[];
  /** The agents that listed a removed skill and were written without it. */
  unlisted: { agentName: string; skillName: string }[];
}

export interface SeedShippedSkillsInput {
  clientInstanceId: ClientInstanceId;
  stores: Pick<PlatformStores, "configAssets" | "audit">;
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
  const { name, title, description, summary, content, resources, icon } = parsed.data;
  return {
    name,
    title,
    description,
    ...(summary === undefined ? {} : { summary }),
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
  const result: ShippedSkillSeedResult = { created: [], updated: [], removed: [], unlisted: [] };
  const mutations: ConfigAssetMutation[] = [];
  const baseRevisions: Record<string, number | null> = {};
  for (const [name, config] of shipped) {
    const asset = stored.get(name);
    if (asset && !isShipped(asset)) {
      // A skill of the instance's own is never touched, not even deleted: it may hold what
      // the instance's people wrote. The name is the platform's, so the start stops.
      throw new AppError(
        "VALIDATION_FAILED",
        `The platform ships the skill '${name}', and the instance holds a skill of its own named '${name}'. Remove the instance copy with 'catalyst config push' after pulling, with the previous release still running: pull, delete skills/${name}, take '${name}' out of the agents' skillNames, push with --prune. Then start this release`,
        { skillName: name }
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
  if (result.removed.length > 0) {
    const removed = new Set(result.removed);
    for (const agent of await store.listActiveConfigAssets({
      clientInstanceId,
      kind: AGENT_KIND
    })) {
      const config = agent.config;
      const skillNames = config?.skillNames;
      if (!config || !Array.isArray(skillNames)) continue;
      const listsRemoved = (name: unknown): name is string =>
        typeof name === "string" && removed.has(name);
      const dropped = skillNames.filter(listsRemoved);
      if (dropped.length === 0) continue;
      // Only the reference goes; a copy of the skill under a name of the instance's own stays.
      mutations.push({
        type: "upsert",
        kind: AGENT_KIND,
        name: agent.name,
        config: { ...config, skillNames: skillNames.filter((name) => !listsRemoved(name)) }
      });
      baseRevisions[`${AGENT_KIND}:${agent.name}`] = agent.revision;
      for (const skillName of dropped) result.unlisted.push({ agentName: agent.name, skillName });
    }
  }
  const written =
    mutations.length > 0
      ? await store.applyConfigAssetMutations({
          clientInstanceId,
          actor: SYSTEM_ACTOR,
          baseRevisions,
          mutations
        })
      : undefined;
  if (written && result.unlisted.length > 0) {
    // One correlation for the start that wrote them; names only, never an agent's content.
    const correlationId = createPlatformId("seed");
    for (const { agentName, skillName } of result.unlisted) {
      await input.stores.audit.appendAuditEvent({
        clientInstanceId,
        type: "config_asset.shipped_skill_unlisted",
        status: "success",
        actor: SYSTEM_ACTOR,
        correlationId,
        metadata: {
          kind: AGENT_KIND,
          name: agentName,
          skillName,
          revision: written.revisions[`${AGENT_KIND}:${agentName}`] ?? null,
          version: written.version
        }
      });
    }
  }
  return result;
}
