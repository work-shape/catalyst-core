import type { CapabilityPackage } from "@work-shape/catalyst-api-contract";
import type { ActorAccess } from "@work-shape/catalyst-core";
import { readableAgents, type ReadableAgent } from "../assets/readable-agents";
import { configAssetReferences } from "../config-assets/config-asset-service";
import type { ChatServerOptions } from "../types";

// What Studio's "Fähigkeiten" page shows (TOOLS-2): what this instance's agents can be given, one
// package per module, with what no module owns first and the instance's own tools last, each
// with the agents the reader may read that use it. Read from the same references as the agent
// page's Tools section. It changes nothing: a module is switched in the deployment's config and
// a tool is attached on the agent page.

/**
 * The right of who is told of a module that is off: an instance admin, who can ask Workshape to
 * turn it on. Nobody else learns of it, and the agent page shows it to nobody.
 */
const OFF_MODULE_READER_RIGHT = "users.manage";

type CapabilityTool = CapabilityPackage["tools"][number];

export async function readCapabilities(
  options: Pick<ChatServerOptions, "clientInstanceId" | "configAssets" | "modules">,
  access: ActorAccess
): Promise<{ packages: CapabilityPackage[] }> {
  const references = configAssetReferences(options);
  const offered = references.tools;
  const skills = options.configAssets.skills?.() ?? [];
  const showsOff = access.authorize(OFF_MODULE_READER_RIGHT).allowed;
  const agents = await readableAgents(options, access);
  const described = new Map(
    (options.configAssets.tools?.() ?? []).map((tool) => [tool.name, tool])
  );

  const packageOf = (
    head: Pick<CapabilityPackage, "kind" | "module" | "enabled">,
    tools: readonly CapabilityTool[],
    skillsOf: CapabilityPackage["skills"]
  ): CapabilityPackage[] =>
    tools.length + skillsOf.length === 0
      ? []
      : [
          { ...head, tools: [...tools], skills: skillsOf, agents: usersOf(agents, tools, skillsOf) }
        ];
  const skillsOfModule = (module: string | undefined) =>
    skills
      .filter((skill) => skill.module === module)
      .map(({ name, title, summary, icon }) => ({
        name,
        title,
        ...(summary === undefined ? {} : { summary }),
        ...(icon === undefined ? {} : { icon })
      }));
  const ownTool = (tool: CapabilityTool) => tool.group === undefined || tool.group === "instance";

  const general = packageOf(
    { kind: "general", enabled: true },
    offered.filter((tool) => tool.module === undefined && !ownTool(tool)),
    skillsOfModule(undefined)
  );
  const modules = options.modules.modules
    .filter((state) => state.definition !== undefined && (state.enabled || showsOff))
    .toSorted((one, other) => Number(other.enabled) - Number(one.enabled))
    .flatMap((state) =>
      packageOf(
        { kind: "module", module: state.name, enabled: state.enabled },
        state.enabled
          ? offered.filter((tool) => tool.module === state.name)
          : references.unavailableTools
              .filter((tool) => tool.module === state.name)
              .map((tool) => ({
                ...described.get(tool.name),
                name: tool.name,
                module: tool.module
              })),
        skillsOfModule(state.name)
      )
    );
  const own = packageOf(
    { kind: "own", enabled: true },
    offered.filter((tool) => tool.module === undefined && ownTool(tool)),
    []
  );
  return { packages: [...general, ...modules, ...own] };
}

/** The agents that list one of the tools or skills, in the order they were read. */
function usersOf(
  agents: readonly ReadableAgent[],
  tools: readonly CapabilityTool[],
  skills: CapabilityPackage["skills"]
): CapabilityPackage["agents"] {
  const toolNames = new Set(tools.map((tool) => tool.name));
  const skillNames = new Set(skills.map((skill) => skill.name));
  return agents
    .filter(
      (agent) =>
        agent.toolNames.some((name) => toolNames.has(name)) ||
        agent.skillNames.some((name) => skillNames.has(name))
    )
    .map((agent) => ({ name: agent.name, title: agent.title }));
}
