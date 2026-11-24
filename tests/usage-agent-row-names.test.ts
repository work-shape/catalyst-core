import { describe, expect, it } from "vitest";
import { asClientInstanceId } from "@work-shape/catalyst-core";
import { agentRowNames } from "@work-shape/catalyst-server";

const workflow = {
  status: "active",
  config: { title: "Draft title" },
  publishedConfig: { title: "Price lists" }
};

const deps = {
  clientInstanceId: asClientInstanceId("usage-names"),
  configAssets: {
    source: {
      getSnapshot: async () => ({
        version: 1,
        agents: [{ name: "assistant", displayName: { en: "Ada", de: "Ada (de)" } }],
        skills: []
      })
    },
    store: {
      getConfigAsset: async ({ name }: { name: string }) =>
        name === "price-lists" ? workflow : undefined
    }
  }
} as unknown as Parameters<typeof agentRowNames>[0];

describe("the names of a Breakdown by agent", () => {
  it("names an agent by its display name and a Workflow step by its Workflow, whatever workspace the reader is in", async () => {
    const names = await agentRowNames(
      deps,
      [
        { key: "assistant" },
        { key: "workflow.price-lists.read" },
        { key: "workflow.gone.read" },
        { key: "unknown" },
        { key: "" }
      ],
      { shown: "de", fallback: "en" }
    );

    expect(Object.fromEntries(names)).toEqual({
      assistant: "Ada (de)",
      "workflow.price-lists.read": "Price lists · read"
    });
  });
});
