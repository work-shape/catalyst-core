import { describe, expect, it } from "vitest";
import { z } from "zod";
import { configAssetReferencesSchema, toolGroupSchema } from "@vivd-catalyst/api-contract";
import { agentToolReferences } from "@vivd-catalyst/client-assembly";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import { TOOL_GROUPS } from "@vivd-catalyst/core";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance } from "./support/test-instance";

// What the agent page reads about the tools it offers (TOOLS-1): each tool's title, summary,
// group, icon and effect from its registered definition, and the module whose switch governs
// it. A tool registered without wording is listed by its name, and the page shows the id.

const titled = defineTool({
  name: "crm.lookup",
  title: { en: "Look up customer", de: "Kunden nachschlagen" },
  summary: {
    en: "Finds a customer in the CRM by name.",
    de: "Findet einen Kunden im CRM nach Namen."
  },
  icon: "database",
  effect: "reading",
  description: "Look up a customer record by name; returns the id and the owner.",
  inputSchema: z.object({ name: z.string() }),
  execute: () => toolSuccess({})
});
const bare = defineTool({
  name: "crm.export",
  effect: "reading",
  description: "Export the customer list.",
  inputSchema: z.object({}),
  execute: () => toolSuccess({})
});

describe("the tools the agent page is told of", () => {
  it("names each offered tool with what it tells people, and the id alone where it tells nothing", async () => {
    const names = ["read_skill", titled.name, bare.name];
    const app = await createTestInstance({
      config: parseClientInstanceConfig({
        ...createTestConfig({
          tools: names.map((name) => ({ name, enabled: true })),
          toolNames: names
        }),
        modules: { assetManagement: { enabled: true } }
      }),
      env: {},
      tools: [titled, bare]
    });

    const references = configAssetReferencesSchema.parse(
      (await app.call("platform.references.get", {})).json()
    );
    const byName = new Map(references.tools?.map((tool) => [tool.name, tool]));

    // Every offered tool is described, in the order of the names.
    expect(references.tools?.map((tool) => tool.name)).toEqual(references.enabledToolNames);
    expect(byName.get("read_skill")).toEqual({
      name: "read_skill",
      title: { en: "Read assigned skill", de: "Zugewiesenen Skill lesen" },
      summary: {
        en: "Reads the instructions of the skills assigned to the agent.",
        de: "Liest die Anleitungen der Skills, die dem Agenten zugewiesen sind."
      },
      group: "skills",
      icon: "skill",
      effect: "reading"
    });
    // A deployment's tool carries its own wording and stands among the instance's own tools.
    expect(byName.get("crm.lookup")).toMatchObject({
      title: { en: "Look up customer", de: "Kunden nachschlagen" },
      icon: "database",
      effect: "reading"
    });
    expect(byName.get("crm.lookup")).not.toHaveProperty("group");
    expect(byName.get("crm.export")).toEqual({ name: "crm.export", effect: "reading" });
    // The asset save belongs to the module that switches it.
    expect(byName.get("platform.assets.put")).toMatchObject({
      module: "assetManagement",
      group: "platform",
      effect: "changing"
    });
    // A core tool has no module.
    expect(byName.get("read_skill")).not.toHaveProperty("module");
  });

  it("describes the model's own web search, which no code registers", () => {
    expect(agentToolReferences(["web_search", "unknown.tool"], [])).toEqual([
      expect.objectContaining({
        name: "web_search",
        title: { en: "Search the web", de: "Im Web suchen" },
        group: "web",
        effect: "reading"
      }),
      { name: "unknown.tool" }
    ]);
  });

  it("knows the same groups on both sides of the API", () => {
    expect(toolGroupSchema.options).toEqual([...TOOL_GROUPS]);
  });
});
