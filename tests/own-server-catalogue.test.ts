import { describe, expect, it } from "vitest";
import {
  entryToolStart,
  ownServerEntryOf,
  readOwnServerProposal,
  type OwnServerEntry
} from "@work-shape/catalyst-chat-ui/build-area";
import {
  createCatalogue,
  createHttpApiConnectorType,
  createMcpConnectorType,
  parseCatalogueEntry,
  type CatalogueEntry
} from "@work-shape/catalyst-connections";
import {
  OWN_SERVER_REFUSALS,
  asClientInstanceId,
  asToolCallId,
  createConnectorTypeRegistry,
  createPlatformId,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";
import {
  CONNECTION_PROPOSE_TOOL_NAME,
  createConnectionProposeTool
} from "@work-shape/catalyst-tool-execution";

// Catalogue entries a person adds as their own MCP server (PMCP-CAT, connections spec, PMCP
// point 9; catalogue spec section 12). An entry names a known service's address, how the person
// signs in and what it says of the tools. It never carries a credential, never opens a host,
// never grants a right, and never ticks a tool the server calls changing without the person
// seeing it. An agent names an entry by id; the address is the entry's, never the agent's.

const ADDRESS = "https://notes.example.com/mcp";

function entry(ownServer: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    id: "notes",
    version: 1,
    service: "notes",
    title: { en: "Notes", de: "Notizen" },
    description: { en: "Your notes.", de: "Deine Notizen." },
    category: "other",
    examplePrompts: [{ en: "What did I note?", de: "Was habe ich notiert?" }],
    mark: { color: "#3a5f8a" },
    ownServer: { url: ADDRESS, signIn: "oauth", ...ownServer },
    ...overrides
  };
}

function refusalOf(value: unknown): string {
  try {
    parseCatalogueEntry(JSON.stringify(value), "notes/entry.yaml");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

const TOKEN = {
  help: { en: "Make one under Settings.", de: "Erstell einen unter Einstellungen." }
};

const registry = () =>
  createConnectorTypeRegistry([createHttpApiConnectorType(), createMcpConnectorType()]);

describe("what an own-server entry may hold", () => {
  it("takes a public https address on 443, a sign-in, a token's help and tool effects", () => {
    expect(refusalOf(entry())).toBe("");
    expect(refusalOf(entry({ url: "https://notes.example.com:443/mcp" }))).toBe("");
    expect(
      refusalOf(
        entry({
          signIn: "token",
          token: { ...TOKEN, link: "https://notes.example.com/help", header: "X-Api-Key" },
          tools: [
            { name: "list_notes", effect: "reading" },
            { name: "delete_note", effect: "changing" }
          ]
        })
      )
    ).toBe("");
  });

  it("refuses another address, a credential, a mismatched sign-in and a repeated tool", () => {
    for (const [field, ownServer] of [
      ["url", { url: "http://notes.example.com/mcp" }],
      ["url", { url: "https://notes.example.com:8443/mcp" }],
      ["url", { url: "https://me:secret@notes.example.com/mcp" }],
      ["url", { url: "https://notes.example.com/mcp?key=sk-live-1" }],
      ["url", { url: "https://notes.example.com/mcp#token" }],
      ["token", { signIn: "token" }],
      ["token", { signIn: "oauth", token: TOKEN }],
      ["header", { signIn: "token", token: { ...TOKEN, header: "Authorization" } }],
      ["header", { signIn: "token", token: { ...TOKEN, header: "mcp-session-id" } }],
      ["header", { signIn: "token", token: { ...TOKEN, header: "x api key" } }],
      ["link", { signIn: "token", token: { ...TOKEN, link: "http://notes.example.com/help" } }],
      ["value", { signIn: "token", token: { ...TOKEN, value: "sk-live-1" } }],
      ["secret", { secret: "sk-live-1" }],
      ["alwaysAllow", { alwaysAllow: true }],
      [
        "tools",
        {
          tools: [
            { name: "list_notes", effect: "reading" },
            { name: "list_notes", effect: "changing" }
          ]
        }
      ],
      ["effect", { tools: [{ name: "list_notes", effect: "always" }] }]
    ] as const) {
      expect(refusalOf(entry(ownServer)), JSON.stringify(ownServer)).not.toBe("");
      expect(refusalOf(entry(ownServer)), JSON.stringify(ownServer)).toContain(field);
    }
  });
});

describe("the catalogue's own-server entries", () => {
  const shipped = (): CatalogueEntry[] => [
    parseCatalogueEntry(JSON.stringify(entry()), "notes/entry.yaml"),
    parseCatalogueEntry(
      JSON.stringify(
        entry(
          { signIn: "token", token: TOKEN, url: "https://other.example.com/mcp" },
          { id: "other" }
        )
      ),
      "other/entry.yaml"
    )
  ];

  it("offers only the entries the instance names, outside the services list and its egress", () => {
    const none = createCatalogue({ entries: shipped(), named: [], connectorTypes: registry() });
    expect(none.ownServers).toEqual([]);
    const named = createCatalogue({
      entries: shipped(),
      named: ["notes"],
      connectorTypes: registry()
    });
    expect(named.ownServers.map((view) => view.id)).toEqual(["notes"]);
    expect(named.ownServers[0]).toMatchObject({
      service: "notes",
      title: { en: "Notes", de: "Notizen" },
      mark: { color: "#3a5f8a" },
      url: ADDRESS,
      signIn: "oauth",
      tools: []
    });
    // Not a service of Dienste, and no host for the operator's list: PMCP-3 judges each request.
    expect(named.entries).toEqual([]);
    expect(JSON.stringify(named.egress)).not.toContain("notes.example.com");
    const both = createCatalogue({
      entries: shipped(),
      named: ["notes", "other"],
      connectorTypes: registry()
    });
    expect(both.ownServers.find((view) => view.id === "other")?.token).toEqual(TOKEN);
  });
});

/** The proposal tool as an instance builds it, offered or not in this chat. */
function proposeTool(offered: boolean, privateChat = true) {
  return createConnectionProposeTool({
    connectorTypes: registry(),
    ownServerEntries: [{ id: "notes", title: "Notes", url: ADDRESS }],
    access: { of: () => Promise.resolve({ ownServer: offered, otherModes: false, privateChat }) }
  });
}

/** A call in a chat; the access above decides whether own servers are offered there. */
const context: ToolExecutionContext = {
  clientInstanceId: asClientInstanceId("demo-local"),
  correlationId: "corr_own_server_catalogue",
  user: {
    id: "user_kai",
    externalUserId: "user_kai",
    displayLabel: "Kai",
    roles: ["user"],
    permissionRefs: [],
    clientInstanceId: asClientInstanceId("demo-local"),
    authSource: "test"
  },
  toolRequest: {
    toolName: CONNECTION_PROPOSE_TOOL_NAME,
    toolCallId: asToolCallId("call_own_server_catalogue"),
    agentRunId: createPlatformId<"AgentRunId">("run"),
    conversationId: createPlatformId<"ConversationId">("conv"),
    agentName: "helper",
    input: {}
  }
};

const byEntry = (id: string, extra: Record<string, unknown> = {}) => ({
  mode: "own_server",
  connectorType: "mcp",
  ownServerEntry: id,
  ...extra
});

describe("an agent's proposal by entry", () => {
  it("lists the offered entries in its description, and says so where there are none", () => {
    expect(proposeTool(true).description).toContain("'notes' (Notes)");
    expect(proposeTool(true).description).toContain("ownServerEntry");
    expect(proposeTool(true).description).not.toContain(ADDRESS);
    const bare = createConnectionProposeTool({ connectorTypes: registry() });
    expect(bare.description).toContain("offers no own-server entries");
  });

  it("answers with the entry's name and address, and audits the mode and the entry alone", async () => {
    const tool = proposeTool(true);
    const answer = await tool.execute(tool.inputSchema.parse(byEntry("notes")), context);
    expect(answer).toEqual({
      status: "success",
      output: {
        mode: "own_server",
        ownServer: { title: "Notes", url: ADDRESS, entry: "notes" },
        privateChat: true
      },
      auditSummary: {
        action: CONNECTION_PROPOSE_TOOL_NAME,
        metadata: { mode: "own_server", entry: "notes" }
      }
    });
    // In a chat others read the answer says so, and tells the agent where the tools work.
    const shared = proposeTool(true, false);
    const elsewhere = await shared.execute(shared.inputSchema.parse(byEntry("notes")), context);
    const output = elsewhere.status === "success" ? elsewhere.output : undefined;
    expect(output).toMatchObject({ privateChat: false, ownServer: { entry: "notes" } });
    expect(JSON.stringify(output)).toContain("private chats");
    expect(JSON.stringify(answer.auditSummary)).not.toContain("notes.example.com");
  });

  it("takes no address, name or key beside the entry", () => {
    const tool = proposeTool(true);
    for (const extra of [
      { url: "https://elsewhere.example.com/mcp" },
      { title: "Notes" },
      { authScheme: "bearer" },
      { keyHeader: "x-api-key" }
    ]) {
      expect(
        tool.inputSchema.safeParse(byEntry("notes", extra)).success,
        JSON.stringify(extra)
      ).toBe(false);
    }
  });

  it("refuses an id the instance does not offer, and any entry where own servers are not offered", async () => {
    const tool = proposeTool(true);
    const unknown = await tool.execute(tool.inputSchema.parse(byEntry("elsewhere")), context);
    expect(unknown.status).toBe("failed");
    if (unknown.status === "failed") {
      expect(unknown.error.code).toBe("validation_failed");
      expect(unknown.error.details).toEqual({ reason: OWN_SERVER_REFUSALS.entryUnknown });
      expect(unknown.auditSummary).toEqual({
        action: CONNECTION_PROPOSE_TOOL_NAME,
        metadata: { mode: "own_server" }
      });
    }
    const closed = proposeTool(false);
    const refused = await closed.execute(closed.inputSchema.parse(byEntry("notes")), context);
    expect(refused.status).toBe("failed");
    if (refused.status === "failed") expect(refused.error.code).toBe("not_allowed");
  });
});

describe("what the person's screen makes of an entry", () => {
  const view: OwnServerEntry = {
    id: "notes",
    version: 1,
    service: "notes",
    title: { en: "Notes", de: "Notizen" },
    description: { en: "Your notes.", de: "Deine Notizen." },
    mark: { color: "#3a5f8a" },
    url: ADDRESS,
    signIn: "oauth",
    tools: []
  };

  it("reads the entry of a proposal", () => {
    expect(
      readOwnServerProposal({
        output: { mode: "own_server", ownServer: { title: "Notes", url: ADDRESS, entry: "notes" } }
      })
    ).toEqual({ title: "Notes", url: ADDRESS, entry: "notes" });
  });

  it("shows an entry's mark on a card only while its service and host are the entry's", () => {
    const row = (service: string | undefined, host: string) => ({
      ...(service === undefined ? {} : { service }),
      ownServer: { host }
    });
    expect(ownServerEntryOf(row("notes", "notes.example.com"), [view])).toBe(view);
    expect(ownServerEntryOf(row("notes", "elsewhere.example.com"), [view])).toBeUndefined();
    expect(ownServerEntryOf(row(undefined, "notes.example.com"), [view])).toBeUndefined();
    expect(ownServerEntryOf(row("other", "notes.example.com"), [view])).toBeUndefined();
  });

  it("starts the tools list tighter where the entry says a tool changes, never looser", () => {
    const candidates = [
      { name: "list_notes", title: "List notes", effect: "reading" as const },
      { name: "get_note", title: "Get note", effect: "reading" as const },
      { name: "delete_note", title: "Delete note", effect: "changing" as const },
      { name: "share_note", title: "Share note", effect: "changing" as const }
    ];
    const start = entryToolStart(candidates, [
      { name: "get_note", effect: "changing" },
      { name: "share_note", effect: "reading" },
      { name: "unlisted", effect: "reading" }
    ]);
    expect([...start.selected].sort()).toEqual(["list_notes"]);
    expect([...start.effects]).toEqual([["get_note", "changing"]]);
    // The entry calls share_note reading: it stays changing and unticked; the person may choose.
    expect([...start.entryReads]).toEqual(["share_note"]);
    expect(start.effects.has("share_note")).toBe(false);
    expect(start.selected.has("share_note")).toBe(false);
  });
});
