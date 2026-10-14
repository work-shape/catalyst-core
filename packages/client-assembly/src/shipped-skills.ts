import { seedShippedSkills } from "@vivd-catalyst/chat-server";
import {
  WORKFLOW_ASSET_KIND,
  type ClientInstanceId,
  type Logger,
  type ModuleSnapshot,
  type PlatformStores,
  type ShippedSkill
} from "@vivd-catalyst/core";
import { workflowAuthoringSkill, workflowsModule } from "@vivd-catalyst/workflows";
import { platformDocsSkill } from "./platform-docs-skill";

// The skills that ship with the platform. The API process stores them at start as read-only
// skills of origin `release`; a conversation whose agent holds the platform's tools is offered
// them by name. A skill a release no longer ships, such as the former `platform-guide`, the
// seed deletes.

/**
 * The names of every skill this build ships, whichever modules are on. A skill of the instance's
 * own takes none of them.
 */
export const shippedSkillNames: readonly string[] = [platformSkill, workflowAuthoringSkill].map(
  (skill) => skill.name
);

/** The kinds the platform ships a skill for. */
const SHIPPED_SKILL_KINDS = [WORKFLOW_ASSET_KIND];

/** The skills the platform ships for the assets of one kind, offered where one is the subject. */
function subjectSkillsOf(kind: string, modules: ModuleSnapshot): ShippedSkill[] {
  return kind === WORKFLOW_ASSET_KIND && modules.isEnabled(workflowsModule.name)
    ? [workflowAuthoringSkill]
    : [];
}

/**
 * The names of the shipped skills a conversation of an agent that holds the platform's tools is
 * offered: the platform's documentation in every one, the skills for its subject in one about an
 * asset, and in one about none yet those of every kind, since the agent may open any.
 */
export function offeredSkillNames(
  subject: { kind: string } | undefined,
  modules: ModuleSnapshot
): string[] {
  return [
    platformDocsSkill,
    ...(subject
      ? subjectSkillsOf(subject.kind, modules)
      : SHIPPED_SKILL_KINDS.flatMap((kind) => subjectSkillsOf(kind, modules)))
  ].map((skill) => skill.name);
}

/** Every skill this build ships with the modules that are on. A module that is off ships none. */
function shippedSkillsOf(modules: ModuleSnapshot): ShippedSkill[] {
  return [
    platformDocsSkill,
    ...SHIPPED_SKILL_KINDS.flatMap((kind) => subjectSkillsOf(kind, modules))
  ];
}

/** Makes the stored shipped skills what this build ships, and logs what it changed. */
export async function seedInstanceShippedSkills(execution: {
  clientInstanceId: ClientInstanceId;
  store: Pick<PlatformStores, "configAssets" | "audit">;
  modules: ModuleSnapshot;
  logger: Logger;
}): Promise<void> {
  const result = await seedShippedSkills({
    clientInstanceId: execution.clientInstanceId,
    stores: execution.store,
    skills: shippedSkillsOf(execution.modules)
  });
  if (result.created.length + result.updated.length + result.removed.length > 0) {
    // Names only: the skills, and the agents that listed a removed one.
    execution.logger.info({ skills: result }, "Shipped skills reconciled");
  }
}
