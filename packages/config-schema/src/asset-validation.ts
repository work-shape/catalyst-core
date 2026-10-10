import { AppError } from "@vivd-catalyst/core";
import {
  agentConfigSchema,
  skillConfigSchema,
  type AgentConfig,
  type SkillConfig
} from "./schemas";
import {
  findAgentModelReferenceIssues,
  findDefaultAgentReferenceIssues,
  findDuplicates,
  findMissingAgentSkillReferences,
  findMissingAgentToolReferences
} from "./reference-validation";

export function validateConfigAssetBundle(input: {
  agents: unknown[];
  skills: unknown[];
  defaultAgentName?: string;
  refs: {
    modelProviderIds: string[];
    modelBindingIds: string[];
    fastModeModelBindingIds: string[];
    enabledToolNames: string[];
  };
}): { agents: AgentConfig[]; skills: SkillConfig[] } {
  const issues: ConfigAssetValidationIssue[] = [];
  const agents = parseAssets(input.agents, "agent", agentConfigSchema, issues);
  const skills = parseAssets(input.skills, "skill", skillConfigSchema, issues);

  for (const duplicate of findDuplicates(agents.map((agent) => agent.name))) {
    issues.push({ message: `Duplicate agent definitions: ${duplicate}` });
  }
  for (const duplicate of findDuplicates(skills.map((skill) => skill.name))) {
    issues.push({ message: `Duplicate skill definitions: ${duplicate}` });
  }
  issues.push(
    ...findDefaultAgentReferenceIssues({
      agentNames: agents.map((agent) => agent.name),
      defaultAgentName: input.defaultAgentName
    }).map(toValidationIssue),
    ...findAgentReferenceIssues({
      agents,
      skillNames: skills.map((skill) => skill.name),
      refs: input.refs
    }).map(toValidationIssue)
  );

  if (issues.length > 0) {
    throw new AppError("VALIDATION_FAILED", "Config asset bundle is invalid", { issues });
  }
  return { agents, skills };
}

/**
 * What an agent refers to and this instance does not offer: a model provider or binding, a
 * skill, a tool, or skills without the tool that reads them.
 */
export function findAgentReferenceIssues(input: {
  agents: readonly AgentConfig[];
  skillNames: readonly string[];
  refs: {
    modelProviderIds: readonly string[];
    modelBindingIds: readonly string[];
    fastModeModelBindingIds: readonly string[];
    enabledToolNames: readonly string[];
  };
}): string[] {
  return [
    ...findAgentModelReferenceIssues({
      agents: input.agents,
      modelProviderIds: input.refs.modelProviderIds,
      modelBindingIds: input.refs.modelBindingIds,
      fastModeModelBindingIds: input.refs.fastModeModelBindingIds
    }),
    ...findMissingAgentSkillReferences(input.agents, input.skillNames).map(
      (issue) => `Agent '${issue.agentName}' references missing skill '${issue.referenceName}'`
    ),
    ...findMissingAgentToolReferences(input.agents, input.refs.enabledToolNames).map(
      (issue) => `Agent '${issue.agentName}' references unavailable tool '${issue.referenceName}'`
    ),
    ...input.agents
      .filter((agent) => agent.skillNames.length > 0 && !agent.toolNames.includes("read_skill"))
      .map((agent) => `Agent '${agent.name}' references skills but does not allow 'read_skill'`)
  ];
}

interface ConfigAssetValidationIssue {
  message: string;
  assetKind?: "agent" | "skill";
  assetName?: string;
  index?: number;
  path?: PropertyKey[];
}

interface AssetSchema<Output> {
  safeParse(input: unknown):
    | { success: true; data: Output }
    | {
        success: false;
        error: { issues: Array<{ message: string; path: PropertyKey[] }> };
      };
}

function parseAssets<Output>(
  inputs: unknown[],
  assetKind: "agent" | "skill",
  schema: AssetSchema<Output>,
  issues: ConfigAssetValidationIssue[]
): Output[] {
  const parsedAssets: Output[] = [];
  for (const [index, input] of inputs.entries()) {
    const parsed = schema.safeParse(input);
    if (parsed.success) {
      parsedAssets.push(parsed.data);
      continue;
    }
    const assetName = readAssetName(input);
    for (const issue of parsed.error.issues) {
      issues.push({
        message: issue.message,
        assetKind,
        ...(assetName === undefined ? {} : { assetName }),
        index,
        path: issue.path
      });
    }
  }
  return parsedAssets;
}

function readAssetName(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("name" in input)) {
    return undefined;
  }
  const name = (input as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function toValidationIssue(message: string): ConfigAssetValidationIssue {
  return { message };
}
