import { describe, expect, it } from "vitest";
import { buildingAgentNameFor } from "@vivd-catalyst/chat-ui/agents";

// The New buttons of NAV-2: where an agent here holds the platform's asset tools, "New" opens
// the dock with a conversation with it, and its first save creates the asset.

describe("the agent of a New button", () => {
  it("starts a New button's conversation with an agent that builds assets, the chosen one first", () => {
    const agents = [
      { name: "general" },
      { name: "builder", buildsAssets: true },
      { name: "studio", buildsAssets: true }
    ];

    expect(buildingAgentNameFor(agents, "studio")).toBe("studio");
    expect(buildingAgentNameFor(agents, "general")).toBe("builder");
    expect(buildingAgentNameFor(agents, undefined)).toBe("builder");
    // No agent here builds: the New buttons keep their forms.
    expect(buildingAgentNameFor([{ name: "general" }], "general")).toBeUndefined();
  });
});
