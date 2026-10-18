import yaml from "js-yaml";
import {
  agentConfigSchema,
  loadYamlData,
  parseSkillMarkdown,
  skillConfigSchema,
  type AgentConfig,
  SKILL_FRONTMATTER_FIELDS,
  type SkillConfig
} from "@work-shape/catalyst-asset-schemas";

export interface AssetProvenance {
  instance: string;
  /** The instance's config version; a working copy of one Namespace does not read it. */
  version?: number;
}

const yamlDumpOptions: yaml.DumpOptions = {
  lineWidth: -1,
  noCompatMode: true,
  noRefs: true,
  sortKeys: false
};

export function parseAgentYaml(contents: string): AgentConfig {
  return agentConfigSchema.parse(loadYamlData(contents, "agent YAML"));
}

export function canonicalizeAgentConfig(input: unknown): AgentConfig {
  return agentConfigSchema.parse(sortKeys(agentConfigSchema.parse(input)));
}

export function serializeAgentYaml(input: unknown, provenance?: AssetProvenance): string {
  const body = yaml.dump(canonicalizeAgentConfig(input), yamlDumpOptions);
  return provenance ? `${provenanceComments(provenance)}${body}` : body;
}

export function parseSkillFile(contents: string, skillFile = "SKILL.md"): SkillConfig {
  return skillConfigSchema.parse(parseSkillMarkdown(contents, skillFile, skillFile));
}

export function canonicalizeSkillConfig(input: unknown): SkillConfig {
  const skill = skillConfigSchema.parse(sortKeys(skillConfigSchema.parse(input)));
  return {
    ...skill,
    ...(skill.resources === undefined
      ? {}
      : {
          resources: [...skill.resources].sort((left, right) => left.path.localeCompare(right.path))
        })
  };
}

/** Schema parsing orders declared fields; sorting first also stabilizes free-form maps. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortKeys(item)])
  );
}

export function serializeSkillMarkdown(input: unknown, provenance?: AssetProvenance): string {
  const skill = canonicalizeSkillConfig(input);
  const frontmatter = yaml.dump(
    {
      ...skill.frontmatter,
      ...Object.fromEntries(
        SKILL_FRONTMATTER_FIELDS.flatMap((key) =>
          skill[key] === undefined ? [] : [[key, skill[key]]]
        )
      )
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
    `# Pulled from ${instance}${provenance.version === undefined ? "" : ` (config version ${provenance.version})`}.\n` +
    "# Local edits are NOT live until 'catalyst config push'.\n"
  );
}
