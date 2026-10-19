import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RELEASED_KIT_VERSIONS } from "@work-shape/catalyst-app-build";
import {
  createPlatformTools,
  platformDocsSkill,
  platformModules
} from "@work-shape/catalyst-client-assembly";
import { createModuleRegistry } from "@work-shape/catalyst-core";
import {
  createPlatformDiscoveryTools,
  createWorkspaceOpenTool,
  showViewTool,
  WorkspaceCommandService
} from "@work-shape/catalyst-tool-execution";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { workflowAuthoringSkill } from "@work-shape/catalyst-workflows";
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
  it.each([
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
  ])("ships %s in the offered orientation and guide", async (_name, rules) => {
    const offer = await offerFor(PLATFORM_TOOLS);
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

  it("keeps truncated row reads and draft rows honest in the offered guidance", async () => {
    const offer = await offerFor(PLATFORM_TOOLS);
    expect(offer.orientation).toContain(
      "a migration that creates its table with a primary key and no rows"
    );
    expect(offer.orientation).toContain(
      "If query says truncated, say so and page with an ordered query"
    );
    expect(offer.orientation).toContain("a truncated answer cannot prove absence");
    expect(offer.orientation).toContain("it is not a row editor");
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
    expect(offered.orientation).toContain("never dump HTTP or YAML");
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
      "that save files a request an admin decides in the Inbox, and the skill stays as it was until then"
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
  it("tells an agent asked for a Google font to carry fonts and libraries locally or use the kit", () => {
    const guide = platformDocsSkill.resources?.find(
      (resource) => resource.path === "references/apps/build.md"
    );
    expect(guide?.content).toContain(
      "Put fonts and libraries in the App's folder or use the kit's; an outside address (Google Fonts, Adobe Fonts or a CDN) will not load."
    );
    expect(guide?.content).toContain(
      `/app-runtime/kit/${RELEASED_KIT_VERSIONS.at(-1)}/fonts/fonts.css`
    );
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

// Platform Access acceptance check 59 (PG-2a): one page of platform-docs holds the decision
// table with the ruled sentence word for word and the Buchhaltungscheck as its worked row;
// show_view, workspace.open, app.save, platform.assets.put and the workflow-authoring skill
// each name that page in one sentence and copy none of it. Fails without the change: the docs
// had no such page and nothing pointed to one.
describe("the decision table between a View, an App and a Workflow", () => {
  const PAGE = "references/apps/app-or-workflow.md";
  const SENTENCE =
    "An App shows data and lets the person using it do one thing at a time. Anything that is a process (several steps, a schedule, history, notifications, rules business users change) is a Workflow the App starts with a button. A live read through a Connection respects the viewer's rights. Stored data read through an App is shared with its audience.";

  it("is one page of platform-docs with the sentence, the table and the Buchhaltungscheck row", () => {
    const pages = (platformDocsSkill.resources ?? []).filter((resource) =>
      resource.content.includes(SENTENCE)
    );
    expect(pages.map((page) => page.path)).toEqual([PAGE]);
    const content = pages[0]?.content ?? "";
    const table = content
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .map((line) =>
        line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim())
      );
    expect(table[0]).toEqual([
      "What",
      "Use when",
      "Not when",
      "Runs as",
      "Who sees the result",
      "The sign to switch"
    ]);
    expect(table.slice(2).map((row) => row[0])).toEqual([
      "View (`show_view`)",
      "App (`workspace.open`, then `app.save`)",
      "App action (`sql`, `connection`, `decision`, `workflow`)",
      "`code` action",
      "Workflow",
      "Worked row: the Buchhaltungscheck"
    ]);
    expect(content).toContain(
      "A published `sql` action on a Data Store uses the store's app role, with the store right checked against the publisher"
    );
    expect(content).toContain("A `code` action that needs a dependent call becomes a Workflow");
    expect(content).toContain("`http_api` Connection");
    expect(content).toContain("`externalHosts`");
    expect(content).toContain("the App last, and the agent says what it creates before it does");
  });

  it("is named in one sentence by each tool that builds and by workflow-authoring, which copy none of it", async () => {
    const harness = await createWorkspaceHarness();
    const workspaceOpen = createWorkspaceOpenTool({
      workspace: new WorkspaceCommandService({
        store: harness.store,
        objectStore: harness.objectStore,
        fileStore: harness.objectStore
      }).dependencies,
      builds: {
        build: async () => {
          throw new Error("Description only");
        }
      }
    });
    const modules = createModuleRegistry(platformModules).snapshot({
      apps: { enabled: true },
      workflows: { enabled: true },
      assetManagement: { enabled: true }
    });
    const platform = createPlatformTools({ stores: harness.store, modules });
    const byName = new Map(
      [showViewTool, workspaceOpen, ...platform.tools].map((tool) => [tool.name, tool.description])
    );
    const texts = [
      ...["show_view", "workspace.open", "app.save", "platform.assets.put"].map(
        (name) => byName.get(name) ?? `missing ${name}`
      ),
      workflowAuthoringSkill.content
    ];
    for (const text of texts) {
      expect(text.split(PAGE.replace("references/", "")).length - 1, text.slice(0, 60)).toBe(1);
      expect(text).not.toContain("one thing at a time");
      expect(text).not.toContain("Buchhaltungscheck");
    }
  });
});
