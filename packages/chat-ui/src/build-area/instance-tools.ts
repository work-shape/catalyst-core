import type {
  AgentToolReference,
  ConfigAssetReferences,
  ToolGroupName
} from "@vivd-catalyst/api-client";

// The instance's own tools in an agent's Tools section, grouped as the page shows them: what is
// in each group, what the group's switch shows, and the tools an agent holds because of
// something else. Pure, so the page and its tests read the same answer.

/** The groups in the order the page shows them. A group without tools is left out. */
const INSTANCE_TOOL_GROUPS: readonly ToolGroupName[] = [
  "documents",
  "web",
  "files",
  "results",
  "skills",
  "platform",
  "instance"
];

/** Why an agent holds a tool without a check box for it. */
type ToolInclusionReason = "skills";

/** The tool that reads the agent's skills: every agent with a skill holds it. */
const READ_SKILL_TOOL_NAME = "read_skill";

/** One tool as its group shows it. */
export interface InstanceToolView {
  name: string;
  /** The title in the reader's language, or the name where the tool has none. */
  title: string;
  summary?: string;
  effect?: AgentToolReference["effect"];
  module?: string;
  icon?: string;
  /** Held because of something else: shown as included, with no check box. */
  includedBecause?: ToolInclusionReason;
}

/** One group: its tools, and its switch over those that have a check box. */
export interface InstanceToolGroupView {
  group: ToolGroupName;
  tools: InstanceToolView[];
  /** The names the switch turns on and off: the tools with a check box. */
  choosable: string[];
  /** On, off, or mixed while only some of `choosable` are on. Off with nothing to choose. */
  state: "on" | "off" | "mixed";
  /** How many of the group's tools the agent holds, the included ones counted. */
  heldCount: number;
}

/**
 * The tools an agent holds because of something else, with the reason. `read_skill` is one
 * while the agent has a skill.
 */
function impliedTools(skillNames: readonly string[]): Map<string, ToolInclusionReason> {
  return new Map(skillNames.length > 0 ? [[READ_SKILL_TOOL_NAME, "skills"]] : []);
}

/** The tool names an agent is saved with: its chosen ones and those it holds by implication. */
export function withImpliedTools(
  toolNames: readonly string[],
  skillNames: readonly string[]
): string[] {
  const implied = [...impliedTools(skillNames).keys()].filter((name) => !toolNames.includes(name));
  return [...toolNames, ...implied];
}

/**
 * The instance's tools on offer, grouped, and after them the names the agent holds that the
 * reader was not told of, which stand among the instance's own by their name. `isOtherSource`
 * answers for a name another group of the section shows, a tool of a Connection or an App.
 */
export function instanceToolGroups(input: {
  references: ConfigAssetReferences | undefined;
  selected: readonly string[];
  skillNames: readonly string[];
  locale: "en" | "de";
  isOtherSource?: (name: string) => boolean;
}): InstanceToolGroupView[] {
  const { references, selected, locale } = input;
  const offered = offeredTools(references);
  const offeredNames = new Set(offered.map((tool) => tool.name));
  const off = new Set((references?.moduleOffTools ?? []).map((tool) => tool.name));
  const held = selected
    .filter(
      (name) => !offeredNames.has(name) && !off.has(name) && !(input.isOtherSource?.(name) ?? false)
    )
    .map((name): AgentToolReference => ({ name }));
  const implied = impliedTools(input.skillNames);

  const byGroup = new Map<ToolGroupName, InstanceToolView[]>();
  for (const tool of [...offered, ...held]) {
    const group = tool.group ?? "instance";
    const includedBecause = implied.get(tool.name);
    byGroup.set(group, [
      ...(byGroup.get(group) ?? []),
      {
        name: tool.name,
        title: tool.title?.[locale].trim() || tool.name,
        ...(tool.summary?.[locale].trim() ? { summary: tool.summary[locale].trim() } : {}),
        ...(tool.effect ? { effect: tool.effect } : {}),
        ...(tool.module ? { module: tool.module } : {}),
        ...(tool.icon ? { icon: tool.icon } : {}),
        ...(includedBecause ? { includedBecause } : {})
      }
    ]);
  }

  return INSTANCE_TOOL_GROUPS.flatMap((group) => {
    const tools = byGroup.get(group);
    if (!tools) {
      return [];
    }
    const choosable = tools.filter((tool) => !tool.includedBecause).map((tool) => tool.name);
    const on = choosable.filter((name) => selected.includes(name)).length;
    return [
      {
        group,
        tools,
        choosable,
        state: on === 0 ? "off" : on === choosable.length ? "on" : "mixed",
        heldCount: tools.filter((tool) => tool.includedBecause || selected.includes(tool.name))
          .length
      }
    ];
  });
}

/** The agent's tool names after a group's switch was turned on or off. The rest keep their order. */
export function switchToolGroup(
  selected: readonly string[],
  group: Pick<InstanceToolGroupView, "choosable">,
  on: boolean
): string[] {
  return on
    ? [...selected, ...group.choosable.filter((name) => !selected.includes(name))]
    : selected.filter((name) => !group.choosable.includes(name));
}

/** What the server describes, or the bare names of a server that describes nothing. */
function offeredTools(references: ConfigAssetReferences | undefined): AgentToolReference[] {
  if (!references) {
    return [];
  }
  const described = new Map((references.tools ?? []).map((tool) => [tool.name, tool]));
  return references.enabledToolNames.map((name) => described.get(name) ?? { name });
}
