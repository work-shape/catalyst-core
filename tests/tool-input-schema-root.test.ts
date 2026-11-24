import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { JsonObject } from "@work-shape/catalyst-core";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, getTestExecution } from "./support/test-instance";

/** Why a model provider would refuse this input schema at its root. Nothing when it would not. */
function rootIssue(schema: JsonObject): string | undefined {
  const combinator = ["anyOf", "oneOf", "allOf"].find((keyword) => keyword in schema);
  if (combinator !== undefined) return `has '${combinator}' at its root`;
  if (schema.type !== "object") return `has the root type ${JSON.stringify(schema.type)}`;
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return "has no 'properties' at its root";
  }
  return undefined;
}

describe("the input schema a model is shown for a tool", () => {
  // Anthropic's Messages format, also on Amazon Bedrock, takes a tool only when its input
  // schema is `type: object` at the root and has no `anyOf`, `oneOf` or `allOf` there. One
  // tool that breaks this fails every run of every agent that lists it.
  it("is a plain object at its root, for every tool an assembly registers", async () => {
    const workspaceObjectRoot = await mkdtemp(join(tmpdir(), "catalyst-tool-schema-root-"));
    // Everything that adds tools is on, so that the registry holds every tool of the release.
    const config = createTestConfig({
      executionWorkspaces: { enabled: true },
      workspaceObjectRoot,
      webAccess: { enabled: true, fetch: { enabled: true } }
    });
    config.administration.agentConfiguration.agentSkillChanges.enabled = true;
    config.modules.apps = { enabled: true };
    config.modules.connections = { enabled: true };
    config.infrastructure.objectStorage.files = {
      provider: "filesystem",
      root: join(workspaceObjectRoot, "files")
    };
    const assembly = await createTestInstance({
      // The apps module signs what serves a Page with a key from this name.
      execution: {
        config,
        tools: [],
        env: { CHAT_SESSION_TOKEN_SECRET: "tool-schema-root-test-".repeat(2) }
      }
    }).then(getTestExecution);
    try {
      const tools = assembly.localAgentRuntimeOptions.toolRegistry.listDefined();
      // The parts of the assembly that add tools only when they are on did add theirs.
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "show_view",
          "workspace.open",
          "workspace.exec",
          "workspace.preview_images",
          "structured_data.publish",
          "web_fetch",
          "read_skill",
          "platform.assets.put",
          "platform.assets.list",
          "platform.connections.propose",
          "platform.connections.draft_tools",
          "propose_skill_change"
        ])
      );

      const refused = tools.flatMap((tool) => {
        const issue = rootIssue(tool.inputJsonSchema);
        return issue === undefined
          ? []
          : [`Tool '${tool.name}': its input schema ${issue}. Make the root one object.`];
      });

      expect(refused).toEqual([]);
    } finally {
      await assembly.close();
      await rm(workspaceObjectRoot, { recursive: true, force: true });
    }
  });
});

describe("what a tool must declare for an instance to start", () => {
  // A changing tool without a mode now uses the instance confirmation default.
  it("W1-8: rejects a missing effect and starts a changing tool using default confirmation", async () => {
    const changing = defineTool({
      name: "demo.modeless",
      effect: "changing",
      description: "Changes something and names no permission mode.",
      inputSchema: z.object({}),
      execute: () => toolSuccess({})
    });
    const start = (tool: typeof changing) =>
      createTestInstance({
        config: createTestConfig({
          tools: [{ name: tool.name, enabled: true }],
          toolNames: [tool.name]
        }),
        env: {},
        tools: [tool]
      });

    await expect(
      start(Object.assign({}, changing, { name: "demo.effectless", effect: undefined }))
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: {
        issues: [{ message: expect.stringContaining("'demo.effectless' declares no effect") }]
      }
    });
    const app = await start(changing);
    await app.close();
  });
});
