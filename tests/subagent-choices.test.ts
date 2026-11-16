import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asClientInstanceId,
  asCollaborationWorkspaceId,
  asConversationId,
  RUN_AGENT_LISTED_AGENTS_MAX,
  type AgentConfig,
  type AuthenticatedUser,
  type RuntimeAssetSnapshot
} from "@work-shape/catalyst-core";
import { subagentChoices, type SubagentChoiceOptions } from "@work-shape/catalyst-server";
import { describeRunAgentTool } from "@work-shape/catalyst-tool-execution";
import { createTestConfig } from "./support/fixtures";

// CR-3m: what a run's `run_agent` tool lists, generated from live config and the person's
// rights. Check 165 of events-workflows-and-guardrails.md for the tool's definition.

const OWN = "orchestrator";
const TEAM_WORKSPACE = asCollaborationWorkspaceId("cw_team");
const root = { id: asConversationId("conv_root"), collaborationWorkspaceId: TEAM_WORKSPACE };
const actor = {
  id: "user-1",
  externalUserId: "user-1",
  displayLabel: "User",
  roles: ["user"],
  permissionRefs: [],
  clientInstanceId: asClientInstanceId("demo-local"),
  authSource: "test"
} satisfies AuthenticatedUser;

const config = createTestConfig({
  modelBindings: [
    { id: "large", providerId: "local", label: "Large 5", usageTier: "high" },
    {
      id: "small",
      providerId: "local",
      label: "Small 5",
      description: "Fast, for mechanical work",
      usageTier: "low"
    },
    { id: "other", providerId: "local", label: "Other 5" }
  ]
});

function agent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name,
    displayName: { en: `${name} (en)`, de: `${name} (de)` },
    instructions: "Work.",
    modelBindingId: "large",
    toolNames: [],
    skillNames: [],
    initialPrompts: [],
    ...overrides
  };
}

function options(
  available: (name: string) => boolean = () => true,
  allowedModelBindingIds?: string[]
): SubagentChoiceOptions {
  return {
    clientInstanceId: asClientInstanceId(config.clientInstance.id),
    config,
    stores: {
      workspaces: {
        getWorkspace: async () => (allowedModelBindingIds ? { allowedModelBindingIds } : {})
      }
    },
    agentAvailable: async ({ agentName }) => available(agentName)
  };
}

const choose = (
  agents: AgentConfig[],
  choiceOptions = options(),
  agentKeys?: RuntimeAssetSnapshot["agentKeys"]
) =>
  subagentChoices(choiceOptions, {
    assets: { agents, ...(agentKeys ? { agentKeys } : {}) },
    parentAgentName: OWN,
    root,
    actor,
    locale: "de"
  });

describe("the agents and models a run's run_agent lists (CR-3m)", () => {
  it("lists its own agent first, then the agents it names by name, each with its models", async () => {
    const agents = [
      agent("zeta", { description: { en: "Sorts.", de: "Sortiert Belege.\nZweite Zeile." } }),
      agent(OWN, {
        subagentNames: ["zeta", "alpha"],
        userSelectableModelBindingIds: ["small"]
      }),
      agent("alpha", { modelBindingId: "small", userSelectableModelBindingIds: ["large"] }),
      agent("unlisted")
    ];
    const choices = await choose(agents);
    expect(choices.agents.map((choice) => choice.name)).toEqual([OWN, "alpha", "zeta"]);
    expect(choices.agents[2]).toEqual({
      name: "zeta",
      displayName: "zeta (de)",
      description: "Sortiert Belege.",
      modelBindingIds: ["large"]
    });
    expect(choices.agents[1]?.modelBindingIds).toEqual(["large", "small"]);
    expect(choices.models).toEqual([
      { bindingId: "large", label: "Large 5", usageTier: "high" },
      {
        bindingId: "small",
        label: "Small 5",
        description: "Fast, for mechanical work",
        usageTier: "low"
      }
    ]);
    expect(choices.moreAgents).toBe(false);

    // The same config and rights give the same definition, whatever order the snapshot has.
    const again = await choose([...agents].reverse());
    expect(describeRunAgentTool(again)).toEqual(describeRunAgentTool(choices));

    // Check 169: files reach a child by name, and parallel children write apart.
    const { description } = describeRunAgentTool(choices);
    expect(description).toContain("name the ones it needs in the task by file name");
    expect(description).toContain("/workspace/agents/<a short name for its task>/");
  });

  it("lists every agent the person may use for '*', and leaves out one they may not", async () => {
    const agents = [
      agent(OWN, { subagentNames: "*" }),
      agent("beta"),
      agent("hidden"),
      agent("alpha")
    ];
    const choices = await choose(
      agents,
      options((name) => name !== "hidden")
    );
    expect(choices.agents.map((choice) => choice.name)).toEqual([OWN, "alpha", "beta"]);
  });

  it("lists at most twenty agents and says that more exist", async () => {
    const many = Array.from({ length: RUN_AGENT_LISTED_AGENTS_MAX + 3 }, (_, index) =>
      agent(`helper_${String(index).padStart(2, "0")}`)
    );
    const choices = await choose([agent(OWN, { subagentNames: "*" }), ...many]);
    expect(choices.agents).toHaveLength(RUN_AGENT_LISTED_AGENTS_MAX);
    expect(choices.agents[0]?.name).toBe(OWN);
    expect(choices.moreAgents).toBe(true);
    expect(JSON.stringify(describeRunAgentTool(choices))).toContain(
      `More than ${RUN_AGENT_LISTED_AGENTS_MAX} agents are available`
    );
  });

  it("narrows a workspace's agent to the models its workspace allows", async () => {
    const agents = [agent(OWN, { userSelectableModelBindingIds: ["small", "other"] })];
    const keys: RuntimeAssetSnapshot["agentKeys"] = new Map([
      [OWN, { id: "asset_own", scope: { kind: "workspace", workspaceId: TEAM_WORKSPACE } }]
    ]);
    const choices = await choose(
      agents,
      options(() => true, ["large", "small"]),
      keys
    );
    expect(choices.agents[0]?.modelBindingIds).toEqual(["large", "small"]);
    // An agent of the instance is narrowed by no workspace.
    const instance = await choose(
      agents,
      options(() => true, ["large"])
    );
    expect(instance.agents[0]?.modelBindingIds).toEqual(["large", "other", "small"]);
  });

  it("gives the model enums of the agents and models, one line per value", async () => {
    const choices = await choose([
      agent(OWN, { subagentNames: ["alpha"], userSelectableModelBindingIds: ["small"] }),
      agent("alpha", { description: { en: "Sorts.", de: "Sortiert." } })
    ]);
    const tool = describeRunAgentTool(choices);
    const properties = z
      .object({
        properties: z.record(
          z.string(),
          z.object({ enum: z.array(z.string()).optional(), description: z.string() })
        )
      })
      .parse(tool.inputJsonSchema).properties;
    expect(properties.agent?.enum).toEqual([OWN, "alpha"]);
    expect(properties.model?.enum).toEqual(["large", "small"]);
    expect(properties.agent?.description).toContain(`- ${OWN}: ${OWN} (de) (yourself)`);
    expect(properties.agent?.description).toContain(
      "- alpha: alpha (de) — Sortiert. (models: large)"
    );
    expect(properties.model?.description).toContain(
      "- small: Small 5 — Fast, for mechanical work (usage: low)"
    );
    // Nothing to name leaves the property out.
    const bare = describeRunAgentTool({ ...choices, models: [] });
    expect(
      Object.keys(
        z.object({ properties: z.record(z.string(), z.unknown()) }).parse(bare.inputJsonSchema)
          .properties
      )
    ).not.toContain("model");
  });
});
