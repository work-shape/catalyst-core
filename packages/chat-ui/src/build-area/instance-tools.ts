import type {
  AgentToolReference,
  ConfigAssetReferences,
  ToolGroupName
} from "@vivd-catalyst/api-client";
import { isConnectionToolName, type ConnectionToolsRead } from "./connection-tools";

// The tools of an agent's Tools section as the page shows them: one row per package ("Paket"),
// per own tool of this instance and per Connection, each with its tools folded below it and a
// switch for all of them. Pure, so the page and its tests read the same answer.

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

/**
 * Tools that come with another and stand on the page only through it: the agent holds the one
 * exactly while it holds the other. Keeping a fact sheet includes reading it.
 */
const COMPANION_TOOLS: ReadonlyMap<string, string> = new Map([
  ["structured_data.read", "structured_data.publish"]
]);

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

/** One group of the instance's tools: its tools, and those with a check box. */
interface InstanceToolGroupView {
  group: ToolGroupName;
  tools: InstanceToolView[];
  /** The tools with a check box: what adding and removing the group turns on and off. */
  choosable: string[];
}

/**
 * One row of the section: a package of the platform, one own tool of this instance, or one
 * Connection.
 */
export interface ToolPackageView {
  /** Unique within the section: `package:<group>`, `own:<tool>` or `connection:<name>`. */
  key: string;
  kind: "package" | "own" | "connection";
  /** The package's group. Its title, sentence and icon are the interface's own words. */
  group?: ToolGroupName;
  /** The name people read of an own tool or a Connection. */
  title?: string;
  /** The sentence of an own tool, or nothing. */
  summary?: string;
  /** The Connection: its name for the way to its page, and what picks its icon. */
  connection?: { name: string; service?: string; connectorType?: string };
  tools: InstanceToolView[];
  /** The tools with a check box: what the row's switch turns on and off. */
  choosable: string[];
  /** How many of its tools the agent holds, the included ones counted. */
  heldCount: number;
}

/**
 * The tools an agent holds because of something else, with the reason. `read_skill` is one
 * while the agent has a skill.
 */
function impliedTools(skillNames: readonly string[]): Map<string, ToolInclusionReason> {
  return new Map(skillNames.length > 0 ? [[READ_SKILL_TOOL_NAME, "skills"]] : []);
}

/**
 * The companions that share their tool's check box on this instance: those whose two tools it
 * offers both of. Where it offers only the tool, that stands alone as before.
 */
function pairedCompanions(offeredNames: readonly string[] | undefined): Map<string, string> {
  return new Map(
    [...COMPANION_TOOLS].filter(
      ([companion, lead]) =>
        (offeredNames?.includes(companion) ?? false) && offeredNames?.includes(lead)
    )
  );
}

/**
 * The tool names with each companion the instance pairs held exactly while its tool is: added
 * where the tool is held, removed where it is not. `offeredNames` are the instance's tools;
 * without them nothing is paired.
 */
export function withCompanionTools(
  toolNames: readonly string[],
  offeredNames: readonly string[] | undefined
): string[] {
  const paired = pairedCompanions(offeredNames);
  const chosen = toolNames.filter((name) => {
    const lead = paired.get(name);
    return lead === undefined || toolNames.includes(lead);
  });
  const companions = [...paired]
    .filter(([companion, lead]) => chosen.includes(lead) && !chosen.includes(companion))
    .map(([companion]) => companion);
  return [...chosen, ...companions];
}

/**
 * The tool names an agent is saved with: its chosen ones and those it holds by implication, a
 * companion with its tool among them. `offeredNames` are the instance's tools.
 */
export function withImpliedTools(
  toolNames: readonly string[],
  skillNames: readonly string[],
  offeredNames: readonly string[] | undefined
): string[] {
  const held = withCompanionTools(toolNames, offeredNames);
  const implied = [...impliedTools(skillNames).keys()].filter((name) => !held.includes(name));
  return [...held, ...implied];
}

/**
 * The instance's tools on offer, grouped, and after them the names the agent holds that the
 * reader was not told of, which stand among the instance's own by their name. `isOtherSource`
 * answers for a name another group of the section shows, a tool of a Connection or an App.
 */
function instanceToolGroups(input: {
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
  // A companion the instance pairs has no row: its tool's check box holds it.
  const paired = pairedCompanions(references?.enabledToolNames);

  const byGroup = new Map<ToolGroupName, InstanceToolView[]>();
  for (const tool of [...offered, ...held]) {
    if (paired.has(tool.name)) {
      continue;
    }
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
    return [{ group, tools, choosable: choosableOf(tools) }];
  });
}

/**
 * Every row of the section, in its order: the packages, then this instance's own tools, one row
 * each, then the Connections; those the agent holds no tool of too. `isOtherSource` answers for
 * a name a later group shows, a tool of an App.
 */
export function toolPackages(input: {
  references: ConfigAssetReferences | undefined;
  selected: readonly string[];
  skillNames: readonly string[];
  locale: "en" | "de";
  connections?: ConnectionToolsRead;
  isOtherSource?: (name: string) => boolean;
}): ToolPackageView[] {
  const { selected } = input;
  const held = (tools: readonly InstanceToolView[]) =>
    tools.filter((tool) => tool.includedBecause || selected.includes(tool.name)).length;
  const groups = instanceToolGroups({
    ...input,
    isOtherSource: (name) => isConnectionToolName(name) || (input.isOtherSource?.(name) ?? false)
  });
  const packages = groups
    .filter((group) => group.group !== "instance")
    .map((group): ToolPackageView => ({
      key: `package:${group.group}`,
      kind: "package",
      group: group.group,
      tools: group.tools,
      choosable: group.choosable,
      heldCount: held(group.tools)
    }));
  const own = (groups.find((group) => group.group === "instance")?.tools ?? []).map(
    (tool): ToolPackageView => ({
      key: `own:${tool.name}`,
      kind: "own",
      title: tool.title,
      ...(tool.summary ? { summary: tool.summary } : {}),
      tools: [tool],
      choosable: choosableOf([tool]),
      heldCount: held([tool])
    })
  );
  const connections =
    input.connections?.status === "ready"
      ? input.connections.connections.map((connection): ToolPackageView => {
          const tools = connection.tools.map((tool): InstanceToolView => ({
            name: tool.toolName,
            title: tool.operation,
            ...(tool.description ? { summary: tool.description } : {}),
            effect: tool.effect
          }));
          return {
            key: `connection:${connection.name}`,
            kind: "connection",
            title: connection.title.trim() || connection.name,
            connection: {
              name: connection.name,
              ...(connection.service ? { service: connection.service } : {}),
              ...(connection.connectorType ? { connectorType: connection.connectorType } : {})
            },
            tools,
            choosable: choosableOf(tools),
            heldCount: held(tools)
          };
        })
      : [];
  return [...packages, ...own, ...connections];
}

/** The agent's tool names with all tools of a row on, or none. The rest keep their order. */
export function setPackageTools(
  selected: readonly string[],
  item: Pick<ToolPackageView, "choosable">,
  on: boolean
): string[] {
  return on
    ? [...selected, ...item.choosable.filter((name) => !selected.includes(name))]
    : selected.filter((name) => !item.choosable.includes(name));
}

/**
 * Where a row's switch stands: on while every tool with a check box is on, off while none is,
 * mixed between. A tool held because of something else does not move it.
 */
export function packageSwitchState(
  item: Pick<ToolPackageView, "choosable">,
  selected: readonly string[]
): "on" | "off" | "mixed" {
  const on = item.choosable.filter((name) => selected.includes(name)).length;
  return on === 0 ? "off" : on === item.choosable.length ? "on" : "mixed";
}

/** How many tools the rows hold together: the number the section's heading shows. */
export function heldToolCount(items: readonly Pick<ToolPackageView, "heldCount">[]): number {
  return items.reduce((sum, item) => sum + item.heldCount, 0);
}

function choosableOf(tools: readonly InstanceToolView[]): string[] {
  return tools.filter((tool) => !tool.includedBecause).map((tool) => tool.name);
}

/** What the server describes, or the bare names of a server that describes nothing. */
function offeredTools(references: ConfigAssetReferences | undefined): AgentToolReference[] {
  if (!references) {
    return [];
  }
  const described = new Map((references.tools ?? []).map((tool) => [tool.name, tool]));
  return references.enabledToolNames.map((name) => described.get(name) ?? { name });
}
