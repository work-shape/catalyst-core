import { skillConfigSchema } from "@work-shape/catalyst-config-schema";
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
} from "@work-shape/catalyst-core";
import { configValuesEqual, readDefinitionField } from "../asset-kinds/shared";

// The seed of the skills that ship with the platform. When the API process starts it makes the
// stored skills of origin `release` equal to what this build ships: a new one is created, a
// changed one gets a revision, and one the build no longer ships is deleted. An agent that lists
// a skill being deleted gets a revision without it first, in the same write, or every later
// write of the instance would be refused for the reference it left. It writes to the store and
// through no operation, which refuse every write to such a skill.
//
// An instance skill under a shipped name that no person ever wrote, only a service principal
// such as a config release or System, is an earlier copy of the shipped skill: the seed adopts
// it, writing the shipped skill over it as it updates one. Agents keep listing it by name. A
// copy a person wrote once is the instance's own and stays.

const SKILL_KIND = "skill";
const AGENT_KIND = "agent";

/** Who a seeded revision is written by, as History shows it. */
const SYSTEM_ACTOR: AuditActor = { displayLabel: "System", roles: [] };

/** What one start changed, by skill name. */
export interface ShippedSkillSeedResult {
  /** Existing names kept intact when their content or owner conflicts with a shipped skill. */
  retained: string[];
  /** Instance copies no person ever wrote, now the shipped skill of their name. */
  adopted: string[];
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

/** Whether a revision was written by a person: a user, never a service principal or System. */
const writtenByPerson = (actor: AuditActor | null) =>
  actor !== null &&
  actor.principalKind !== "service" &&
  (actor.principalKind === "user" ||
    actor.userId !== undefined ||
    actor.externalUserId !== undefined);

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

/** Whether every stored revision of the instance skill was written by no person. */
async function notWrittenByPerson(input: SeedShippedSkillsInput, name: string): Promise<boolean> {
  const revisions = await input.stores.configAssets.listConfigAssetRevisions({
    clientInstanceId: input.clientInstanceId,
    kind: SKILL_KIND,
    name
  });
  return revisions.length > 0 && revisions.every((revision) => !writtenByPerson(revision.actor));
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
  const result: ShippedSkillSeedResult = {
    retained: [],
    adopted: [],
    created: [],
    updated: [],
    removed: [],
    unlisted: []
  };
  const mutations: ConfigAssetMutation[] = [];
  const baseRevisions: Record<string, number | null> = {};
  for (const [name, config] of shipped) {
    const asset = stored.get(name);
    // Deleted rows keep their owner too: an instance upsert cannot reclaim a workspace name.
    const row = asset ?? (await store.getConfigAsset({ clientInstanceId, kind: SKILL_KIND, name }));
    const adopt =
      row?.scope.kind === "instance" &&
      asset !== undefined &&
      !isShipped(asset) &&
      (await notWrittenByPerson(input, name));
    if (!adopt && ((row && row.scope.kind !== "instance") || (asset && !isShipped(asset)))) {
      // Keep user content and ownership intact, and leave the admin API available to resolve
      // collisions. Removing an instance copy lets a later start seed the shipped skill;
      // a workspace's name remains with that workspace even after deletion.
      result.retained.push(name);
      continue;
    }
    if (asset && configValuesEqual(asset.config, config)) continue;
    // A skill the platform shipped once and dropped left a deleted row: the release that
    // brings it back continues its revisions.
    mutations.push({ type: "upsert", kind: SKILL_KIND, name, config });
    baseRevisions[`${SKILL_KIND}:${name}`] = row?.revision ?? null;
    (adopt ? result.adopted : asset ? result.updated : result.created).push(name);
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
      // The agent stays with its owner: a workspace's agent is written in that workspace.
      mutations.push({
        type: "upsert",
        kind: AGENT_KIND,
        name: agent.name,
        scope: agent.scope,
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
