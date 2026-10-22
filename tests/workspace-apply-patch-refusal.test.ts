import { describe, expect, it, vi } from "vitest";
import {
  agentConfigSchema,
  findAgentToolReferenceIssues,
  formerAgentToolWarnings,
  formerReleaseToolWarnings,
  resolveStoredAgentReferences
} from "@work-shape/catalyst-config-schema";
import { createLogger } from "@work-shape/catalyst-client-assembly";
import { asClientInstanceId, isJsonObject, unknownToJsonValue } from "@work-shape/catalyst-core";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance } from "./support/test-instance";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { WorkspaceCommandService } from "@work-shape/catalyst-tool-execution";
import { createWorkspaceHarness } from "./support/workspace-tools-harness";

const retiredAgent = agentConfigSchema.parse({
  name: "retired_patch_agent",
  displayName: "Retired patch agent",
  instructions: "Edit with workspace.apply_patch.",
  modelProviderId: "local",
  toolNames: ["workspace.apply_patch", "workspace.read_file"],
  skillNames: []
});

const warning = (where: string) =>
  `${where} names the retired tool 'workspace.apply_patch'. Use 'workspace.edit_file' with exact text edits instead; the old patch input is unsupported and has no alias.`;

describe("retired workspace.apply_patch", () => {
  it("is absent from the registry and service, without an alias to edit_file", async () => {
    const harness = await createWorkspaceHarness();
    expect(harness.tools.map((tool) => tool.name)).not.toContain("workspace.apply_patch");
    expect(harness.tools.map((tool) => tool.name)).toContain("workspace.edit_file");
    expect(WorkspaceCommandService.prototype).not.toHaveProperty("applyPatch");
  });

  it("accepts stale references with a retirement warning and never grants either editing tool", () => {
    expect(
      findAgentToolReferenceIssues({
        agents: [retiredAgent],
        enabledToolNames: ["workspace.read_file", "workspace.edit_file"]
      })
    ).toEqual([]);
    expect(formerReleaseToolWarnings(["workspace.apply_patch"])).toEqual([
      warning("The release config")
    ]);
    expect(formerAgentToolWarnings(retiredAgent)).toEqual([warning("Agent 'retired_patch_agent'")]);
    expect(formerAgentToolWarnings({ ...retiredAgent, toolNames: [] })).toEqual([
      warning("Agent 'retired_patch_agent'")
    ]);
    const resolved = resolveStoredAgentReferences(retiredAgent, [], {
      enabledToolNames: ["workspace.read_file", "workspace.edit_file"],
      modelProviderIds: ["local"],
      modelBindingIds: []
    });
    expect(resolved.unavailableTools).toEqual([]);
    expect(resolved.agent.toolNames).toEqual(["workspace.read_file"]);
  });

  it("starts an existing instance with stale release and stored agent references and logs the warning", async () => {
    const config = createTestConfig();
    config.modules = { assetManagement: { enabled: true } };
    const first = await createTestInstance({ config, env: {}, tools: [], seedAssets: true });
    try {
      const storedConfig = unknownToJsonValue({
        ...retiredAgent,
        toolNames: ["workspace.apply_patch"]
      });
      if (!isJsonObject(storedConfig)) throw new Error("Expected agent config");
      await applyAtCurrentRevisions(first.stores.configAssets, {
        clientInstanceId: asClientInstanceId(config.clientInstance.id),
        mutations: [
          {
            type: "upsert",
            kind: "agent",
            name: retiredAgent.name,
            config: storedConfig
          }
        ]
      });
    } finally {
      await first.close();
    }
    config.tools.push({ name: "workspace.apply_patch", enabled: true, config: {} });
    const warn = vi.spyOn(createLogger(), "warn");
    const instance = await createTestInstance({ config, env: {}, tools: [] });
    try {
      expect((await instance.call("ready.get")).statusCode).toBe(200);
      const response = await instance.call("assets.get", {
        params: { kind: "agent", name: retiredAgent.name }
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ chatAvailable: true, unavailableTools: [] });
      const messages = warn.mock.calls.flat();
      expect(messages).toContain(warning("The release config"));
      expect(messages).toContain(warning("Agent 'retired_patch_agent'"));
    } finally {
      await instance.close();
      warn.mockRestore();
    }
  });
});
