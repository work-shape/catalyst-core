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
    ...(agent.welcomeMessage === undefined ? {} : { welcomeMessage: agent.welcomeMessage }),
    ...(agent.welcomeSubtitle === undefined ? {} : { welcomeSubtitle: agent.welcomeSubtitle }),
    instructions: agent.instructions,
    ...(agent.modelProviderId === undefined ? {} : { modelProviderId: agent.modelProviderId }),
    ...(agent.modelBindingId === undefined ? {} : { modelBindingId: agent.modelBindingId }),
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

export function serializeSkillMarkdown(input: unknown, provenance?: AssetProvenance): string {
  const skill = skillConfigSchema.parse(input);
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

function provenanceComments(provenance: AssetProvenance): string {
  const instance = provenance.instance.replaceAll(/[\r\n]+/gu, " ");
  return (
    `# Pulled from ${instance} (config version ${provenance.version}).\n` +
    "# Local edits are NOT live until 'catalyst config push'.\n"
  );
}
