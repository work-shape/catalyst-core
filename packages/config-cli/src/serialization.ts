import yaml from "js-yaml";
import {
  agentConfigSchema,
  parseSkillMarkdown,
  skillConfigSchema,
  type AgentConfig,
  type SkillConfig
} from "@vivd-catalyst/config-schema";

export interface AssetProvenance {
  instance: string;
  version: number;
}

const yamlDumpOptions: yaml.DumpOptions = {
  lineWidth: -1,
  noCompatMode: true,
  noRefs: true,
  sortKeys: false
};

export function parseAgentYaml(contents: string): AgentConfig {
  return agentConfigSchema.parse(yaml.load(contents));
}

export function canonicalizeAgentConfig(input: unknown): AgentConfig {
  const agent = agentConfigSchema.parse(input);
  return {
    name: agent.name,
    displayName: agent.displayName,
    ...(agent.description === undefined ? {} : { description: agent.description }),
    ...(agent.welcomeMessage === undefined ? {} : { welcomeMessage: agent.welcomeMessage }),
    ...(agent.welcomeSubtitle === undefined ? {} : { welcomeSubtitle: agent.welcomeSubtitle }),
    instructions: agent.instructions,
    ...(agent.modelProviderId === undefined ? {} : { modelProviderId: agent.modelProviderId }),
    ...(agent.modelBindingId === undefined ? {} : { modelBindingId: agent.modelBindingId }),
    ...(agent.reasoningEffort === undefined ? {} : { reasoningEffort: agent.reasoningEffort }),
    ...(agent.fastMode ? { fastMode: true } : {}),
    ...(agent.userSelectableModelBindingIds?.length
      ? { userSelectableModelBindingIds: agent.userSelectableModelBindingIds }
      : {}),
    ...(agent.maxSteps === undefined ? {} : { maxSteps: agent.maxSteps }),
    toolNames: agent.toolNames,
    skillNames: agent.skillNames,
    initialPrompts: agent.initialPrompts
  };
}

export function serializeAgentYaml(input: unknown, provenance?: AssetProvenance): string {
  const body = yaml.dump(canonicalizeAgentConfig(input), yamlDumpOptions);
  return provenance ? `${provenanceComments(provenance)}${body}` : body;
}

export function parseSkillFile(contents: string, skillFile = "SKILL.md"): SkillConfig {
  return skillConfigSchema.parse(parseSkillMarkdown(contents, skillFile, skillFile));
}

export function canonicalizeSkillConfig(input: unknown): SkillConfig {
  const skill = skillConfigSchema.parse(input);
  const resources = skill.resources
    ? [...skill.resources].sort((left, right) => left.path.localeCompare(right.path))
    : undefined;
  return {
    name: skill.name,
    title: skill.title,
    description: skill.description,
    content: skill.content,
    ...(resources?.length ? { resources } : {})
  };
}

export function serializeSkillMarkdown(input: unknown, provenance?: AssetProvenance): string {
  const skill = canonicalizeSkillConfig(input);
  const frontmatter = yaml.dump(
    {
      name: skill.name,
      title: skill.title,
      description: skill.description
    },
    yamlDumpOptions
  );
  const comments = provenance ? provenanceComments(provenance) : "";
  return `---\n${comments}${frontmatter}---\n\n${skill.content.trim()}\n`;
}

export function serializeSkillPackageForDisplay(input: unknown): string {
  const skill = canonicalizeSkillConfig(input);
  const root = serializeSkillMarkdown(skill).trimEnd();
  const resources = (skill.resources ?? []).map(
    (resource) =>
      `===== ${resource.path} (${resource.mediaType}) =====\n\n${resource.content.trimEnd()}`
  );
  return [root, ...resources].join("\n\n");
}

function provenanceComments(provenance: AssetProvenance): string {
  const instance = provenance.instance.replaceAll(/[\r\n]+/gu, " ");
  return (
    `# Pulled from ${instance} (config version ${provenance.version}).\n` +
    "# Local edits are NOT live until 'catalyst config push'.\n"
  );
}
