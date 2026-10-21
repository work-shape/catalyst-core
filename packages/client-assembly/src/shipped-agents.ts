import { seedShippedAgents } from "@work-shape/catalyst-server";
import type {
  ClientInstanceId,
  Logger,
  ModuleSnapshot,
  PlatformStores,
  ShippedAgent,
  ShippedSkill
} from "@work-shape/catalyst-core";
import { workshaperModule } from "./platform-modules/workshaper";
import { WORKSHAPER_AGENT_NAME, workshaperAgent } from "./workshaper";

// The agents that ship with the platform: Workshaper alone. Its tools and skills are derived
// at each start from what the instance has (the architect's planning pass of 2026-10-15), so a
// module switched on brings its tools with the next start and one switched off takes them away.

/** The names of every agent this build ships, whichever modules are on. */
export const SHIPPED_AGENT_NAMES: readonly string[] = [WORKSHAPER_AGENT_NAME];

/**
 * A tool that works on one asset, such as a Connection's operation, an App's action or a
 * Workflow's start. The instance gives such tools to Workshaper itself; none ships with it.
 */
function isPerAssetTool(name: string): boolean {
  return (
    name.startsWith("connection.") ||
    name.startsWith("knowledge.") ||
    name.startsWith("app.") ||
    /^workflow\..+\.start$/u.test(name)
  );
}

/**
 * The agents this build ships to one instance, with their tools and skills: every tool an agent
 * of the instance may list that it can run, other than a per-asset tool and `run_agent`, and
 * every skill a capability ships to it. The platform's own skills need no listing: an agent that
 * holds the platform's tools is offered them. A module that is off ships no agent.
 */
export function shippedAgentsOf(input: {
  modules: ModuleSnapshot;
  /** Every tool an agent of the instance may list. */
  listableToolNames: readonly string[];
  /** Whether an agent of the instance can run the tool: its module is on and its model fits. */
  runsTool(toolName: string): boolean;
  /** What this build ships to the instance, from `shippedSkillsOf`. */
  shippedSkills: readonly ShippedSkill[];
  /** The shipped skills an agent that holds the platform's tools is offered by name. */
  offeredSkillNames: readonly string[];
  /** The tool that starts a subagent, which needs agents named beside it. */
  runAgentToolName: string;
}): ShippedAgent[] {
  if (!input.modules.isEnabled(workshaperModule.name)) return [];
  const offered = new Set(input.offeredSkillNames);
  return [
    workshaperAgent({
      toolNames: input.listableToolNames.filter(
        (name) => name !== input.runAgentToolName && !isPerAssetTool(name) && input.runsTool(name)
      ),
      skillNames: input.shippedSkills
        .map((skill) => skill.name)
        .filter((name) => !offered.has(name))
    })
  ];
}

/** Brings the stored shipped agents up to what this build ships, and logs what it changed. */
export async function seedInstanceShippedAgents(execution: {
  clientInstanceId: ClientInstanceId;
  store: Pick<PlatformStores, "configAssets">;
  /** What this build ships to the instance, from `shippedAgentsOf`. */
  shippedAgents: readonly ShippedAgent[];
  logger: Logger;
}): Promise<void> {
  const result = await seedShippedAgents({
    clientInstanceId: execution.clientInstanceId,
    stores: execution.store,
    agents: execution.shippedAgents
  });
  if (result.retained.length > 0) {
    execution.logger.warn(
      { agentNames: result.retained },
      "Instance agents share shipped agent names; keeping the instance's own. Rename them to receive the shipped agents"
    );
  }
  if (result.created.length + result.updated.length > 0) {
    // Names only.
    execution.logger.info({ agents: result }, "Shipped agents reconciled");
  }
}
