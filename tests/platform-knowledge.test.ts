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
import { createPlatformDiscoveryTools } from "@work-shape/catalyst-tool-execution";
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
async function offerFor(
  agentToolNames: string[],
  subject?: { kind: string; name: string },
  connections = false
) {
  const harness = await createWorkspaceHarness();
  const modules = createModuleRegistry(platformModules).snapshot({
    connections: { enabled: connections },
    apps: { enabled: true },
    workflows: { enabled: true },
    assetManagement: { enabled: true }
  });
  const platform = createPlatformTools({ stores: harness.store, modules });
  platform.registry(
    [
      stand("read_skill"),
      stand("platform.connections.draft_tools"),
      stand("platform.connections.offer_to_agent"),
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
  // ACCEPT-FIX-5: no shipped-agent eval harness exists; pin the instructions actually offered.
  it("ACCEPT-FIX-5: ships record honesty, the actual owner, the availability handoff and the navigation in the offered orientation and guide", async () => {
    const offer = await offerFor(PLATFORM_TOOLS);
    const shipped = [
      [
        "record honesty",
        [
          "successful tool result proves that exact action and target",
          "hand-written table",
          "only with a data_store.<store>.<verb> tool in your tool list",
          "Without such a tool, say so before offering sample rows",
          "App or Workflow that writes records",
          "never use a migration",
          "Pending confirmation means nothing has been saved"
        ]
      ],
      [
        "actual owner",
        [
          "report the workspaceId returned by the save",
          "team- is not an owner",
          "must switch to that workspace"
        ]
      ],
      [
        "availability handoff",
        [
          "Studio > Agents > the saved agent > Available in > Selected workspaces",
          "Studio > Agenten",
          "Änderungen speichern",
          "Never claim availability before that save",
          "Personal workspaces for all personal workspaces",
          "Publish (Veröffentlichen)"
        ]
      ],
      [
        "navigation and terminology",
        [
          "Workflows and Apps in the main navigation",
          "Inbox (Eingang)",
          "Studio > Knowledge Bases (Studio > Wissensbasen)",
          "Knowledge (Wissen)",
          "Studio > Agenten / Skills / Verbindungen / Datenspeicher",
          "Knowledge Base is Wissensbasis in German, plural Wissensbasen"
        ]
      ]
    ] as const;
    for (const [, rules] of shipped)
      for (const rule of rules) expect(offer.orientation).toContain(rule);
    const guide =
      platformDocsSkill.resources?.find((page) => page.path === "references/configure/build.md")
        ?.content ?? "";
    expect(guide).toContain(
      "The Build Agent reports only actions confirmed by successful tool results"
    );
    expect(guide).toContain("only with a `data_store.<store>.<verb>` tool");
    expect(guide).toContain("The save's `workspaceId` is the actual owner");
    expect(guide).toContain("A newly created agent is available nowhere");
    expect(guide).toContain("**Wissen**");
    expect(guide).toContain("**Wissensbasis**, plural **Wissensbasen**");
    expect(offer.orientation).not.toContain("Wissensdatenbank");
  });

  it("offers connection drafting to platform agents by default only while Connections is enabled", async () => {
    const offered = await offerFor(PLATFORM_TOOLS, undefined, true);
    expect(offered.toolNames).toContain("platform.connections.draft_tools");
    expect((await offerFor(PLATFORM_TOOLS)).toolNames).not.toContain(
      "platform.connections.draft_tools"
    );
    expect((await offerFor(["read_skill"], undefined, true)).toolNames).not.toContain(
      "platform.connections.draft_tools"
    );
    expect(
      (await offerFor(["read_skill"], { kind: "connection", name: "crm" }, true)).toolNames
    ).toContain("platform.connections.draft_tools");
    // What an agent without the tools says stands in the platform's rules, for every agent.
    expect(offered.orientation).not.toContain("never dump HTTP or YAML");
  });

  // CS-5d: approved tools reach no agent before it is given them. The offer of that give goes
  // with the drafting; the orientation says an agent calls them only once given them.
  it("offers the give of a Connection's tools to an agent with the drafting", async () => {
    const offered = await offerFor(PLATFORM_TOOLS, undefined, true);
    expect(offered.toolNames).toContain("platform.connections.offer_to_agent");
    expect((await offerFor(PLATFORM_TOOLS)).toolNames).not.toContain(
      "platform.connections.offer_to_agent"
    );
    expect(
      (await offerFor(["read_skill"], { kind: "connection", name: "crm" }, true)).toolNames
    ).toContain("platform.connections.offer_to_agent");
  });

  // ACCEPT-2c C-4: German replies said "technischer Primärschlüssel", "App-ID" and
  // "Entwurf-Revision 1". The offered orientation asks for titles and plain words in English and
  // German, and keeps the technical fields in tool calls. A model's replies are not tested here.
  it("asks for titles and plain words in replies, in English and German, and keeps ids in calls", async () => {
    const offer = await offerFor(PLATFORM_TOOLS);
    expect(offer.orientation).toContain(
      "name an asset or App by its title, never by its id or name"
    );
    expect(offer.orientation).toContain(
      'a first save created the asset (German: "angelegt"), a later one saved the change (German: "gespeichert")'
    );
    expect(offer.orientation).toContain("Give a revision number only when the person asks for it.");
    expect(offer.orientation).not.toContain("never a revision number");
    expect(offer.orientation).toContain(
      'the column or columns that tell the rows apart (German: "die Spalte, an der jede Zeile erkannt wird")'
    );
    expect(offer.orientation).toContain(
      'never "technical primary key" or "technischer Primärschlüssel"'
    );
    expect(offer.orientation).toContain(
      "Tool calls keep their ids, names, revisions and key columns."
    );
  });

  // A member cannot change a skill. Only propose_skill_change files a request for one, and a
  // save on the skill page files one only where the instance asks an approval for it.
  it("tells the agent how a person who may not change a skill gets a change made", async () => {
    const offer = await offerFor(PLATFORM_TOOLS);
    expect(offer.orientation).toContain(
      "If propose_skill_change is in your tool list, propose the change with it; that files a request"
    );
    expect(offer.orientation).toContain(
      "someone who may approve skill changes decides it in the Inbox (Eingang), and nothing changes before"
    );
    expect(offer.orientation).toContain(
      "An asset read or open, and read_skill, can return saveApproval."
    );
    // PR-382 M1: a skill's create says what it meets, read from platform.context.
    expect(offer.orientation).toContain(
      "unless the skill kind in platform.context has createApproval: then the create files a request"
    );
    expect(offer.orientation).not.toContain("may instead file a request");
    expect(offer.orientation).toContain(
      "name the people in saveApproval.approverNames as the approvers"
    );
    expect(offer.orientation).toContain(
      "When absent, an authorized save takes effect immediately."
    );
  });

  it("explains workspace skill rights once in the context tool, using a plain apostrophe", async () => {
    const unused = async () => {
      throw new Error("This test only reads tool descriptions");
    };
    const tool = createPlatformDiscoveryTools({
      readContext: unused,
      listAssets: unused,
      listFiles: unused
    }).find((tool) => tool.name === "platform.context");
    const offer = await offerFor(PLATFORM_TOOLS);
    const description = tool?.description ?? "";
    expect(description).toContain("current: true");
    expect(description).toContain("A workspace skill.write allows creating a skill there");
    expect(`${offer.orientation} ${description}`.match(/A workspace skill\.write/gu)).toHaveLength(
      1
    );
    expect(description).not.toContain("conversation’s");
  });

  it("leaves new agents on the default model and requires a reader for their skills", async () => {
    const offer = await offerFor(PLATFORM_TOOLS);
    expect(offer.orientation).toContain("leave all model settings out");
    expect(offer.orientation).toContain("Never copy a model binding");
    expect(offer.orientation).toContain("An agent with skills needs read_skill");
  });

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
    // Personal work must not inherit a company's domain prefix (ACCEPT-1c C12).
    expect(offer.orientation).toContain(
      "Naming: give a new asset a short name for what it does, with no prefix."
    );
    expect(offer.orientation).toContain("A person's own workspace is no name prefix");
    expect(offer.orientation).toContain("only where the person chose that area for the asset");
    expect(offer.orientation).not.toMatch(/\bhr-|Personalwesen/u);
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
  it("teaches the Workflow's own account and the draft's derived ceiling", () => {
    const guide = platformDocsSkill.resources?.find(
      (resource) => resource.path === "references/how-it-works/rights.md"
    )?.content;
    expect(guide).toContain("By default it gets its own when it is first published");
    expect(guide).toContain("rights the draft's steps need, even before the first publish");
    expect(guide).not.toContain("a Superadmin creates that account");
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
