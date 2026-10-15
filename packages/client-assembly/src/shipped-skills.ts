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
import type { ClientInstanceCapability } from "./capabilities";
import { platformDocsSkill } from "./platform-docs-skill";

// The skills that ship with the platform and with the capabilities of the build, such as the
// general skills for spreadsheets, documents, presentations and PDF. The API process stores
// them at start as read-only skills of origin `release`; a conversation whose agent holds the
// platform's tools is offered the platform's own by name, and an agent lists a capability's
// like any other skill. A skill a release no longer ships, such as the former `platform-guide`,
// the seed deletes.

/** The skills the capabilities of this build ship, whichever tools the instance has. */
function capabilitySkillsOf(capabilities: readonly ClientInstanceCapability[]): ShippedSkill[] {
  return capabilities.flatMap((capability) => capability.skills ?? []);
}

/**
 * The names of every skill this build ships, whichever modules are on and tools the instance
 * has. A skill of the instance's own takes none of them.
 */
export function shippedSkillNamesOf(
  capabilities: readonly ClientInstanceCapability[]
): readonly string[] {
  return [platformDocsSkill, workflowAuthoringSkill, ...capabilitySkillsOf(capabilities)].map(
    (skill) => skill.name
  );
}

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

/**
 * Every skill this build ships to one instance: those of the modules that are on, and those of
 * the capabilities whose tools the instance has. A module that is off ships none, and a skill
 * whose tools are off or of a module that is off is not shipped either.
 */
export function shippedSkillsOf(input: {
  modules: ModuleSnapshot;
  capabilities: readonly ClientInstanceCapability[];
  /** Whether the instance has a tool: registered, enabled and of no module that is off. */
  hasTool(toolName: string): boolean;
}): ShippedSkill[] {
  return [
    platformDocsSkill,
    ...SHIPPED_SKILL_KINDS.flatMap((kind) => subjectSkillsOf(kind, input.modules)),
    ...capabilitySkillsOf(input.capabilities).filter((skill) =>
      (skill.tools ?? []).every((toolName) => input.hasTool(toolName))
    )
  ];
}

/** Makes the stored shipped skills what this build ships, and logs what it changed. */
export async function seedInstanceShippedSkills(execution: {
  clientInstanceId: ClientInstanceId;
  store: Pick<PlatformStores, "configAssets" | "audit">;
  /** What this build ships to the instance, from `shippedSkillsOf`. */
  shippedSkills: readonly ShippedSkill[];
  logger: Logger;
}): Promise<void> {
  const result = await seedShippedSkills({
    clientInstanceId: execution.clientInstanceId,
    stores: execution.store,
    skills: execution.shippedSkills
  });
  if (result.retained.length > 0) {
    execution.logger.warn(
      { skillNames: result.retained },
      "Instance skills share shipped skill names; keeping the instance copies. Pull config assets and rename the instance copies before adopting the shipped skills"
    );
  }
  if (result.created.length + result.updated.length + result.removed.length > 0) {
    // Names only: the skills, and the agents that listed a removed one.
    execution.logger.info({ skills: result }, "Shipped skills reconciled");
  }
}
