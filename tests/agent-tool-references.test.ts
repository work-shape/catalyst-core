import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { configAssetReferencesSchema, toolGroupSchema } from "@work-shape/catalyst-api-contract";
import { agentToolReferences } from "@work-shape/catalyst-client-assembly";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import { TOOL_GROUPS } from "@work-shape/catalyst-core";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
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
      const pageTools = ["workspace.open", "app.save", "app.edit"];
      const config = createTestConfig({
        executionWorkspaces: { enabled: true },
        workspaceObjectRoot,
        tools: ["workspace.write_file"].map((name) => ({
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
            "Help.\nShow it in the chat with workspace.open. When the user wants to keep it, save it as an App with app.save and reload with app.edit."
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
          "workspace.open",
          "workspace.exec",
          "structured_data.publish",
          "web_fetch",
          "read_skill",
          "propose_skill_change",
          "platform.assets.put",
          "platform.connections.propose",
          "platform.connections.draft_tools",
          "platform.connections.offer_to_agent"
        ])
      );
      const proposal = tools.find((tool) => tool.name === "platform.connections.propose");
      expect(
        proposal?.inputSchema.safeParse({ entry: { id: "mail", part: "tools" } }).success
      ).toBe(true);
      expect(
        proposal?.inputSchema.safeParse({
          entry: { id: "mail", part: "tools" },
          clientSecret: "never-in-chat"
        }).success
      ).toBe(false);
      expect(proposal?.description).toContain("do not web-search the provider");
      expect(proposal?.description).toContain(
        "Never ask a question in the same turn as an approval card"
      );
      // How a Connection is proposed is said by its tools, once: the orientation names the kind.
      expect(proposal?.description).toContain("Read catalogue.entries in platform.context first");
      expect(proposal?.description).toContain(
        "credentialMode (user for mail, calendar and personal files)"
      );
      expect(proposal?.description).toContain("Never say a service is unsupported");
      const draft = tools.find((tool) => tool.name === "platform.connections.draft_tools");
      expect(draft?.description).toContain("Read catalogue.entries and connectorTypes");
      expect(draft?.description).toContain("draft nothing against a host it covers");
      const untold = tools
        .filter((tool) => !tool.title?.en || !tool.title.de || !tool.group)
        .map((tool) => tool.name);
      expect(untold).toEqual([]);
      // Check 53 of apps-and-pages: nothing a model reads of a tool names a former tool name.
      // Fails without OPEN-1: the descriptions of the open and of the view named page.save.
      const descriptors = assembly.localAgentRuntimeOptions.toolRegistry.listDescriptorsForAgent(
        tools.map((tool) => tool.name)
      );
      expect(descriptors.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["workspace.open", "app.save"])
      );
      const naming = descriptors
        .filter((tool) =>
          /\bpage\.save/u.test(JSON.stringify([tool.description, tool.inputJsonSchema]))
        )
        .map((tool) => tool.name);
      expect(naming).toEqual([]);
      // Check 57: what a member reads of the two tools says App and never Page or Seite.
      const told = tools
        .filter((tool) => tool.name === "workspace.open" || tool.name === "app.save")
        .map((tool) => JSON.stringify([tool.title, tool.summary]));
      expect(told).toHaveLength(2);
      expect(told.filter((text) => /\b(?:pages?|seiten?)\b/iu.test(text))).toEqual([]);
    } finally {
      await assembly.close();
      await rm(workspaceObjectRoot, { recursive: true, force: true });
    }
  });

  it("knows the same groups on both sides of the API", () => {
    expect(toolGroupSchema.options).toEqual([...TOOL_GROUPS]);
  });
});
