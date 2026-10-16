import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createPlatformTools,
  platformDocsSkill,
  platformModules
} from "@work-shape/catalyst-client-assembly";
import { createModuleRegistry } from "@work-shape/catalyst-core";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { createWorkspaceHarness } from "./support/workspace-tools-harness";

// What an agent knows of the platform comes in three layers: the rules every agent gets, and,
// only for an agent whose own definition lists the platform's tools, those tools, the
// orientation in its system prompt and the shipped skill `platform-docs`. Fails without the
// change: every conversation offered the platform's tools and its guide, whatever the agent's
// definition listed, and the guide was a hand-written skill without the product's docs.

const PLATFORM_TOOLS = [
  "platform.context",
  "platform.assets.list",
  "platform.files.list",
  "platform.assets.open",
  "platform.assets.get",
  "platform.assets.validate",
  "platform.assets.put",
  "platform.assets.operations"
];
const PAGE_TOOLS = ["workspace.open", "app.save", "workspace.write_file"];

const stand = (name: string) =>
  defineTool({
    name,
    effect: "reading",
    description: name,
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    execute: () => toolSuccess({})
  });

/** What a conversation of an agent that lists `agentToolNames` is offered. */
async function offerFor(agentToolNames: string[], subject?: { kind: string; name: string }) {
  const harness = await createWorkspaceHarness();
  const modules = createModuleRegistry(platformModules).snapshot({
    apps: { enabled: true },
    workflows: { enabled: true },
    assetManagement: { enabled: true }
  });
  const platform = createPlatformTools({ stores: harness.store, modules });
  platform.registry(
    [
      stand("read_skill"),
      stand("workspace.open"),
      stand("workspace.write_file"),
      ...platform.tools
    ],
    new Set(["workspace.write_file"])
  );
  if (subject) {
    await harness.store.conversations.setConversationSubject({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      subject
    });
  }
  const offer = await platform.conversationOffer.offerOf({
    clientInstanceId: harness.clientInstanceId,
    conversationId: harness.conversation.id,
    agentToolNames
  });
  if (!offer) throw new Error("The conversation has no offer");
  return offer;
}

describe("the platform's knowledge of an agent", () => {
  it("is none of the tools, the orientation or the docs for an agent that lists no platform tool, also about a Workflow", async () => {
    for (const subject of [undefined, { kind: "workflow", name: "month-end" }]) {
      const offer = await offerFor(["read_skill", "show_view"], subject);
      expect(offer.toolNames.filter((name) => PLATFORM_TOOLS.includes(name))).toEqual([]);
      expect(offer.orientation).toBeUndefined();
      expect(offer.skillNames).toEqual([]);
      // The App tools are no part of the gate.
      expect(offer.toolNames).toEqual(expect.arrayContaining(PAGE_TOOLS));
    }
  });

  it("is the tools it lists, the orientation and the docs for an agent that lists them", async () => {
    const offer = await offerFor(PLATFORM_TOOLS);
    expect(offer.toolNames).toEqual(expect.arrayContaining([...PLATFORM_TOOLS, "read_skill"]));
    expect(offer.orientation).toContain("platform.assets.list");
    expect(offer.orientation).toContain("'platform-docs'");
    expect(offer.skillNames).toContain("platform-docs");
    expect(offer.skillNames).not.toContain("platform-guide");

    // Only the platform's tools it lists: holding one is no grant of the others.
    const narrow = await offerFor(["platform.context", "platform.assets.get"]);
    expect(narrow.toolNames.filter((name) => PLATFORM_TOOLS.includes(name)).sort()).toEqual([
      "platform.assets.get",
      "platform.context"
    ]);
    expect(narrow.orientation).toBeDefined();

    // About a Workflow, the skill for writing one as well.
    const about = await offerFor(PLATFORM_TOOLS, { kind: "workflow", name: "month-end" });
    expect(about.skillNames).toEqual(["platform-docs", "workflow-authoring"]);
  });
});

const docsRoot = fileURLToPath(new URL("../packages/docs/src/content/docs/", import.meta.url));
const generator = fileURLToPath(
  new URL("../packages/client-assembly/scripts/platform-docs.ts", import.meta.url)
);

describe("the shipped skill platform-docs", () => {
  it("tells an agent asked for a Google font to carry fonts and libraries locally or use the kit", () => {
    const guide = platformDocsSkill.resources?.find(
      (resource) => resource.path === "references/apps/build.md"
    );
    expect(guide?.content).toContain(
      "Put fonts and libraries in the App's folder or use the kit's; an outside address (Google Fonts, Adobe Fonts or a CDN) will not load."
    );
    expect(guide?.content).toContain("/app-runtime/kit/1.5.0/fonts/fonts.css");
  });
  it("carries every page of the platform's docs as a reference that its index names", async () => {
    const pages = (await readdir(docsRoot, { recursive: true }))
      .filter((path) => path.endsWith(".md") && !path.startsWith("reference/api/"))
      .map((path) => path.replace(/\.md$/u, ""))
      .sort((left, right) => left.localeCompare(right));
    expect(pages.length).toBeGreaterThan(10);
    const references = (platformDocsSkill.resources ?? []).map((resource) => resource.path);
    expect(references).toEqual(pages.map((page) => `references/${page}.md`));
    for (const reference of references) {
      expect(platformDocsSkill.content).toContain(`\`${reference}\`: `);
    }
  });

  it("ships the CLI resource with its title and package", () => {
    const page = platformDocsSkill.resources?.find(
      (resource) => resource.path === "references/configure/cli.md"
    );
    expect(page?.path).toBe("references/configure/cli.md");
    expect(page?.content.startsWith("# The Catalyst CLI\n")).toBe(true);
    expect(page?.content).toContain("@work-shape/catalyst-cli");
  });

  it("is generated from the docs pages: a changed page fails here until `pnpm generate:platform-docs` ran", async () => {
    await expect(
      promisify(execFile)(process.execPath, [generator, "--check"])
    ).resolves.toBeDefined();
  });
});

// Platform Access acceptance check 55 (CONNECT-1a): an agent that holds the platform tools can
// walk a person through connecting a local agent from its docs, and no agent can issue a key or
// a connect code. Fails without the change: the docs had no such page.
describe("connecting a local agent, as an agent knows it", () => {
  const keyOperations =
    platformModules.find((module) => module.name === "personalApiKeys")?.operations ?? [];

  it("is a page of platform-docs that leads to /settings/you/connect and says no agent issues a key", () => {
    const page = (platformDocsSkill.resources ?? []).find(
      (resource) => resource.path === "references/getting-started/local-agent.md"
    );
    expect(page?.content).toContain("Connect a local agent");
    expect(page?.content).toContain("/settings/you/connect");
    expect(page?.content).toContain("Lokalen Agenten verbinden");
    expect(page?.content).toContain("no agent can make one");
    expect(platformDocsSkill.content).toMatch(
      /`references\/getting-started\/local-agent\.md`: [^\n]*\/settings\/you\/connect/u
    );
  });

  it("is no tool: no module offers one for personal API keys or connect codes, and no agent is offered one", async () => {
    expect(keyOperations).toEqual(
      expect.arrayContaining(["me.api_keys.create", "connect_codes.start"])
    );
    const keyTool = /api_keys|api-keys|connect_codes|connect-codes/u;
    for (const module of platformModules) {
      expect(
        (module.tools ?? []).filter((name) => keyTool.test(name)),
        module.name
      ).toEqual([]);
    }
    const offer = await offerFor(PLATFORM_TOOLS);
    expect(
      offer.toolNames.filter((name) => keyTool.test(name) || keyOperations.includes(name))
    ).toEqual([]);
  });
});
