import { createSkillAssetKind, seedShippedSkills } from "@vivd-catalyst/chat-server";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  WORKFLOW_ASSET_KIND,
  type ClientInstanceId,
  type Logger,
  type ModuleSnapshot,
  type PlatformStores,
  type ShippedSkill
} from "@vivd-catalyst/core";
import { workflowAuthoringSkill, workflowsModule } from "@vivd-catalyst/workflows";
import { platformSkill } from "./platform-skill";

// The skills that ship with the platform. The API process stores them at start as read-only
// skills of origin `release`; a conversation is offered them by name.

/**
 * The skill kind of an instance. A skill of the instance's own takes the name of no skill this
 * build ships, whichever modules are on.
 */
export function createInstanceSkillAssetKind(config: ClientInstanceConfig) {
  return createSkillAssetKind({
    config,
    shippedSkillNames: [platformSkill, workflowAuthoringSkill].map((skill) => skill.name)
  });
}

/** The skills the platform ships for the assets of one kind, offered where one is the subject. */
function subjectSkillsOf(kind: string, modules: ModuleSnapshot): ShippedSkill[] {
  return kind === WORKFLOW_ASSET_KIND && modules.isEnabled(workflowsModule.name)
    ? [workflowAuthoringSkill]
    : [];
}

/**
 * The names of the shipped skills a conversation is offered: the guide to the platform in every
 * one, and the skills for its subject in one about an asset.
 */
export function offeredSkillNames(
  subject: { kind: string } | undefined,
  modules: ModuleSnapshot
): string[] {
  return [platformSkill, ...(subject ? subjectSkillsOf(subject.kind, modules) : [])].map(
    (skill) => skill.name
  );
}

/** Every skill this build ships with the modules that are on. A module that is off ships none. */
function shippedSkillsOf(modules: ModuleSnapshot): ShippedSkill[] {
  return [platformSkill, ...subjectSkillsOf(WORKFLOW_ASSET_KIND, modules)];
}

/** Makes the stored shipped skills what this build ships, and logs what it changed. */
export async function seedInstanceShippedSkills(execution: {
  clientInstanceId: ClientInstanceId;
  store: Pick<PlatformStores, "configAssets">;
  modules: ModuleSnapshot;
  logger: Logger;
}): Promise<void> {
  const result = await seedShippedSkills({
    clientInstanceId: execution.clientInstanceId,
    stores: execution.store,
    skills: shippedSkillsOf(execution.modules)
  });
  if (result.created.length + result.updated.length + result.removed.length > 0) {
    execution.logger.info({ skills: result }, "Shipped skills reconciled");
  }
}
