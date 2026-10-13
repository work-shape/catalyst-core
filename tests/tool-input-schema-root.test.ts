import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@vivd-catalyst/core";
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
          "page.save",
          "workspace.exec",
          "workspace.preview_images",
          "structured_data.publish",
          "web_fetch",
          "read_skill",
          "platform.assets.put",
          "platform.assets.list",
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

  it("says what is wrong with a root that is a union or carries a combinator", () => {
    expect(rootIssue({ oneOf: [{ type: "object" }, { type: "object" }] })).toBe(
      "has 'oneOf' at its root"
    );
    expect(rootIssue({ type: "object", properties: {}, anyOf: [{ required: ["a"] }] })).toBe(
      "has 'anyOf' at its root"
    );
    expect(rootIssue({ type: "object" })).toBe("has no 'properties' at its root");
    expect(rootIssue({ type: "object", properties: {} })).toBeUndefined();
  });
});
