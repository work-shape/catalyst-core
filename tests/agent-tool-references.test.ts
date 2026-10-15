import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { configAssetReferencesSchema, toolGroupSchema } from "@vivd-catalyst/api-contract";
import { agentToolReferences } from "@vivd-catalyst/client-assembly";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import { TOOL_GROUPS } from "@vivd-catalyst/core";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, getTestExecution } from "./support/test-instance";

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

  it.each([false, true])(
    "validates the incident sentence against the assembled registry (apps enabled: %s)",
    async (enabled) => {
      const workspaceObjectRoot = await mkdtemp(join(tmpdir(), "catalyst-page-references-"));
      const pageTools = ["page.save", "page.save_as_app"];
      const config = createTestConfig({
        executionWorkspaces: { enabled: true },
        workspaceObjectRoot,
        tools: ["workspace.write_file", ...(enabled ? pageTools : [])].map((name) => ({
          name,
          enabled: true
        }))
      });
      config.modules.apps = { enabled };
      config.modules.assetManagement = { enabled: true };
      config.administration.agentConfiguration.allowAgentCreation = true;
      config.administration.agentConfiguration.editableAgentFields = [
        "displayName",
        "instructions",
        "toolNames",
        "skillNames",
        "initialPrompts"
      ];
      config.infrastructure.objectStorage.files = {
        provider: "filesystem",
        root: join(workspaceObjectRoot, "files")
      };
      const instance = await createTestInstance({
        config,
        tools: [],
        env: { CHAT_SESSION_TOKEN_SECRET: "page-tool-reference-test-".repeat(2) }
      });
      try {
        // The full module registry knows Page tools even with apps off. The enabled set
        // must not infer them from the workspace file tool on this instance.
        const references = configAssetReferencesSchema.parse(
          (await instance.call("platform.references.get", {})).json()
        );
        expect(references.enabledToolNames).toContain("workspace.write_file");
        for (const name of pageTools)
          expect(references.enabledToolNames.includes(name)).toBe(enabled);
        const agentConfig = {
          name: "page-helper",
          displayName: "Page helper",
          modelProviderId: "local",
          toolNames: [],
          skillNames: [],
          initialPrompts: [],
          instructions:
            "Help.\nBuild a Page in the chat with page.save. When the user wants to keep or share it, save that Page as an App with page.save_as_app."
        };
        const validation = await instance.call("assets.validate", {
          params: { kind: "agent" },
          payload: { config: agentConfig }
        });
        expect(validation.statusCode, validation.body).toBe(200);
        expect(validation.json()).toMatchObject({ valid: enabled });
        if (!enabled) {
          for (const name of pageTools)
            expect(validation.body).toContain(
              `Agent 'page-helper' references unavailable tool '${name}' in instructions line 2`
            );
        }
        const write = await instance.call("assets.put", {
          params: { kind: "agent", name: agentConfig.name },
          payload: { config: agentConfig, expectedRevision: null }
        });
        expect(write.statusCode, write.body).toBe(enabled ? 200 : 422);
      } finally {
        await instance.close();
        await rm(workspaceObjectRoot, { recursive: true, force: true });
      }
    }
  );

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

  // The agent page shows a tool without a title by its id, and one without a group among the
  // instance's own: a tool the platform ships carries both, so neither happens to it.
  it("has a title and a group on every tool the platform ships", async () => {
    const workspaceObjectRoot = await mkdtemp(join(tmpdir(), "catalyst-tool-references-"));
    // Everything that adds tools is on, so that the registry holds every tool of the platform.
    const config = createTestConfig({
      executionWorkspaces: { enabled: true },
      workspaceObjectRoot,
      webAccess: { enabled: true, fetch: { enabled: true } }
    });
    config.administration.agentConfiguration.agentSkillChanges.enabled = true;
    config.modules.apps = { enabled: true };
    config.modules.assetManagement = { enabled: true };
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
        env: { CHAT_SESSION_TOKEN_SECRET: "tool-references-test-".repeat(2) }
      }
    }).then(getTestExecution);
    try {
      const tools = assembly.localAgentRuntimeOptions.toolRegistry.listDefined();
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "show_view",
          "page.save",
          "workspace.exec",
          "structured_data.publish",
          "web_fetch",
          "read_skill",
          "propose_skill_change",
          "platform.assets.put",
          "platform.connections.draft_tools"
        ])
      );
      const untold = tools
        .filter((tool) => !tool.title?.en || !tool.title.de || !tool.group)
        .map((tool) => tool.name);
      expect(untold).toEqual([]);
    } finally {
      await assembly.close();
      await rm(workspaceObjectRoot, { recursive: true, force: true });
    }
  });

  it("knows the same groups on both sides of the API", () => {
    expect(toolGroupSchema.options).toEqual([...TOOL_GROUPS]);
  });
});
