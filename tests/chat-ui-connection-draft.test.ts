import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createApiClient } from "@work-shape/catalyst-api-client";
import {
  ConnectionApprovalList,
  ConnectionCreateFlow,
  ConnectionDraftCard,
  ConnectionDraftHostProvider,
  ConnectionDraftCardView,
  connectionDraftEntry,
  connectionDraftForm,
  connectionDraftHost,
  connectionReadyMessage,
  discoveredCandidates,
  isConnectionProposal,
  openConnectionDraft,
  pastedCandidates,
  readConnectionDraft,
  readConnectionProposal,
  type ApprovalSurface,
  type CatalogueEntryOffer,
  type ConnectionDraft,
  type ConnectionSource
} from "@work-shape/catalyst-chat-ui/build-area";
import { createTranslationContext } from "./support/chat-ui/shared";
import { connectionAsset, connectionDetail } from "./chat-ui-connection-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The agent's draft of REST API tools (CS-5c) and its proposal of a new Connection (CHAT-CONN-1):
// what the card reads of the tool's answer, who gets its button, the New connection dialog it
// opens, and the approval list. No draft, card, dialog or message carries a key.

const API_SCOPE = { apiBaseUrl: "https://catalyst.example.test", authScope: "reader-a" };

/** A text that stands for a key. No draft, card or form below may repeat it. */
const SECRET = "sk-live-card-7a6b5c4d";
const ADDRESS = "https://brain.example.test/mcp";

/** The answer of the draft tool, with members an answer must never bring to the card. */
const answer = {
  output: {
    connection: {
      name: "exampledata",
      title: "Exampledata",
      baseUrl: "https://api.exampledata.test",
      headerNames: ["x-client-instance-id", 7],
      testPath: "/monitoring/health",
      headers: { "x-client-instance-id": SECRET },
      apiKey: SECRET
    },
    operations: [
      {
        name: "list_clients",
        title: "Mandanten auflisten",
        description: "Lists the clients.",
        method: "GET",
        path: "/clients",
        effect: "reading",
        headers: { Authorization: `Bearer ${SECRET}` },
        secret: SECRET,
        exposure: ["agent", "bridge", "workflow", "outside"],
        enabled: true
      },
      { name: "list_fiscal_years", method: "GET", path: "/clients/{clientId}/fiscal-years" }
    ]
  }
};

function draft(): ConnectionDraft {
  const read = readConnectionDraft(answer);
  if (!read) throw new Error("The answer is a draft");
  return read;
}

function proposal(): ConnectionDraft {
  const read = readConnectionProposal({
    output: {
      connection: {
        connectorType: "mcp",
        name: "brain",
        title: "Brain",
        url: ADDRESS,
        keyHeader: "x-brain-key",
        headerNames: [],
        apiKey: SECRET
      }
    }
  });
  if (!read) throw new Error("The answer is a proposal");
  return read;
}

describe("what the card reads", () => {
  it("takes a draft's name, address, header names, test path and declarations, and no key or exposure", () => {
    const read = draft();
    expect(JSON.stringify(read)).not.toContain(SECRET);
    expect(read.connection).toEqual({
      connectorType: "http_api",
      name: "exampledata",
      title: "Exampledata",
      baseUrl: "https://api.exampledata.test",
      headerNames: ["x-client-instance-id"],
      testPath: "/monitoring/health"
    });
    const [first] = read.operations;
    expect(first?.declaration).toEqual({
      title: "Mandanten auflisten",
      description: "Lists the clients.",
      method: "GET",
      path: "/clients"
    });
    // Which surfaces may use a tool is the person's choice in the list, never the agent's.
    expect(first).not.toHaveProperty("exposure");
  });

  it("takes a proposal's type, id, name, address and key header's name, and no key", () => {
    const read = proposal();
    expect(JSON.stringify(read)).not.toContain(SECRET);
    expect(read).toEqual({
      connection: {
        connectorType: "mcp",
        name: "brain",
        title: "Brain",
        baseUrl: ADDRESS,
        keyHeader: "x-brain-key",
        headerNames: []
      },
      operations: []
    });
  });

  it("is nothing for a refusal, a call still running or a draft with no operation", () => {
    const refused = { status: "failed", error: { code: "validation_failed", message: "x" } };
    expect(readConnectionDraft(undefined)).toBeUndefined();
    expect(readConnectionDraft(refused)).toBeUndefined();
    expect(readConnectionDraft({ output: { ...answer.output, operations: [] } })).toBeUndefined();
    expect(readConnectionProposal(undefined)).toBeUndefined();
    expect(readConnectionProposal(refused)).toBeUndefined();
  });

  it("maps an OAuth proposal with personal mode and GET declarations without its client secret", () => {
    const read = readConnectionProposal({
      output: {
        connection: {
          connectorType: "http_api",
          name: "mail",
          title: "Mail",
          url: "https://api.example.test",
          authScheme: "oauth",
          credentialMode: "user",
          headerNames: [],
          oauth: {
            authorizationUrl: "https://login.example.test/authorize",
            tokenUrl: "https://login.example.test/token",
            clientId: "public-client",
            scopes: ["mail.read", "openid"],
            clientSecret: SECRET
          }
        },
        operations: [{ name: "list", method: "GET", path: "/messages", effect: "reading" }]
      }
    });
    if (!read) throw new Error("Expected proposal");
    expect(read.connection.credentialMode).toBe("user");
    expect(isConnectionProposal(read)).toBe(true);
    expect(connectionDraftForm(read)).toMatchObject({
      authScheme: "oauth",
      oauth: { clientId: "public-client", scopes: "mail.read openid" }
    });
    expect(JSON.stringify(read)).not.toContain(SECRET);
  });

  it("opens a catalogue entry's proposal at its part, only where the entry is offered", async () => {
    const read = readConnectionProposal({
      output: {
        entry: { id: "files", part: "source" },
        state: "needs_setup",
        mayWrite: false,
        connection: { connectorType: "http_api", name: "files", title: "Files", headerNames: [] }
      }
    });
    if (!read) throw new Error("Expected entry proposal");
    const part = {
      part: "tools" as const,
      connectorType: "http_api",
      name: "files",
      description: "Files",
      authScheme: "none",
      credentialModes: ["shared" as const],
      defaultCredentialMode: "shared" as const,
      settings: {},
      fields: [],
      prerequisites: [],
      hosts: [],
      operations: [],
      sharedAccountNote: "Shared",
      documentSource: false
    };
    const entry: CatalogueEntryOffer = {
      id: "files",
      version: 1,
      service: "files",
      title: "Files",
      description: "Files",
      category: "files",
      examplePrompts: [],
      mark: {},
      offered: true,
      parts: [part, { ...part, part: "source" }]
    };
    expect(connectionDraftEntry(read, [entry])?.parts[0]?.part).toBe("source");
    expect(connectionDraftEntry(read, [{ ...entry, offered: false }])).toBeUndefined();
    let opened = false;
    expect(
      await openConnectionDraft(read, {
        connectorTypeOf: async () => {
          throw new Error("An entry needs no custom Connection lookup");
        },
        showConnection: () => undefined,
        requestCreateDialog: () => {
          opened = true;
        }
      })
    ).toBe("opened");
    expect(opened).toBe(true);
  });
});

describe("the card's button", () => {
  const host = (connectorType: string | undefined | Error) => {
    const shown: (string | undefined)[] = [];
    let dialogs = 0;
    return {
      shown,
      dialogs: () => dialogs,
      host: {
        connectorTypeOf: async () => {
          if (connectorType instanceof Error) throw connectorType;
          return connectorType;
        },
        showConnection: (name: string | undefined) => shown.push(name),
        requestCreateDialog: () => {
          dialogs += 1;
        }
      }
    };
  };

  it("opens an existing Connection's page, a new id's dialog, and leaves another type or a failed read", async () => {
    const existing = host("http_api");
    expect(await openConnectionDraft(draft(), existing.host)).toBe("opened");
    expect(existing.shown).toEqual(["exampledata"]);
    expect(existing.dialogs()).toBe(0);

    const missing = host(undefined);
    expect(await openConnectionDraft(draft(), missing.host)).toBe("opened");
    expect(missing.shown).toEqual([undefined]);
    expect(missing.dialogs()).toBe(1);

    const mcp = host("mcp");
    expect(await openConnectionDraft(draft(), mcp.host)).toBe("not_rest");
    expect(mcp.shown).toEqual([]);
    const failed = host(new Error("offline"));
    expect(await openConnectionDraft(draft(), failed.host)).toBe("failed");
    expect(failed.shown).toEqual([]);
  });

  it("shows a proposed Connection that exists already, and opens the dialog for a new id", async () => {
    const proposed = host("mcp");
    expect(await openConnectionDraft(proposal(), proposed.host)).toBe("exists");
    expect(proposed.shown).toEqual(["brain"]);
    expect(proposed.dialogs()).toBe(0);
    const fresh = host(undefined);
    expect(await openConnectionDraft(proposal(), fresh.host)).toBe("opened");
    expect(fresh.dialogs()).toBe(1);
  });

  it("is missing for a reader who may write no Connection", () => {
    const render = (shown: ConnectionDraft, writer: boolean) =>
      renderToStaticMarkup(
        createElement(
          TranslationProvider,
          { children: null, locale: "en" },
          createElement(ConnectionDraftCardView, {
            draft: shown,
            ...(writer ? { onOpen: async () => "opened" as const } : {})
          })
        )
      );
    for (const shown of [draft(), proposal()]) {
      expect(render(shown, true)).toContain("data-connection-draft-open");
      expect(render(shown, false)).not.toContain("data-connection-draft-open");
      expect(render(shown, true)).not.toContain(SECRET);
    }
    // AGENT-FRICTION-1: the card says the agent drafted the tools and nothing is connected yet.
    expect(render(draft(), true)).toContain("Not connected yet");
  });
});

describe("the card's host", () => {
  /** A client whose instance holds the Connections of `held`, by id. */
  const client = (held: Record<string, Record<string, unknown>>, missingStatus = 404) =>
    createApiClient({
      baseUrl: "https://catalyst.example.test",
      fetchImpl: async (input, init) => {
        const name = decodeURIComponent(
          new URL(new Request(input, init).url).pathname.split("/").at(-1) ?? ""
        );
        const config = held[name];
        return config
          ? Response.json(connectionAsset(name, config))
          : Response.json(
              {
                error: {
                  code: missingStatus === 403 ? "FORBIDDEN" : "NOT_FOUND",
                  message: "Unavailable"
                }
              },
              { status: missingStatus }
            );
      }
    });
  const held = { exampledata: { connectorType: "http_api", displayName: "Kanzlei-API" } };

  it("gives the button only to a reader who may write Connections", () => {
    const input = { ...API_SCOPE, client: client({}), showRoute: () => undefined };
    expect(connectionDraftHost({ ...input, mayWriteConnections: false }).open).toBeUndefined();
    expect(connectionDraftHost({ ...input, mayWriteConnections: true }).open).toBeDefined();
  });

  it("lets a writer of one Connection open its page, and never the New connection dialog", async () => {
    const shown: unknown[] = [];
    const host = connectionDraftHost({
      ...API_SCOPE,
      client: client(held),
      mayWriteConnections: false,
      showRoute: (route) => shown.push(route)
    });
    expect(host.open).toBeUndefined();
    expect(await host.openExisting?.(draft())).toBe("exists");
    expect(shown).toHaveLength(1);
    expect(JSON.stringify(shown[0])).toContain("exampledata");
    // A Connection that does not exist, or that the reader may not read, opens nothing.
    const missing = connectionDraftHost({
      ...API_SCOPE,
      client: client({}, 403),
      mayWriteConnections: false,
      showRoute: (route) => shown.push(route)
    });
    expect(await missing.openExisting?.(draft())).toBe("failed");
    expect(shown).toHaveLength(1);
    expect(
      connectionDraftHost({
        ...API_SCOPE,
        client: client({}),
        mayWriteConnections: true,
        showRoute: () => undefined
      }).openExisting
    ).toBeUndefined();
  });

  it("does not open a new Connection when a writer's read is forbidden", async () => {
    const shown: unknown[] = [];
    const host = connectionDraftHost({
      ...API_SCOPE,
      client: client({}, 403),
      mayWriteConnections: true,
      showRoute: (route) => shown.push(route)
    });
    expect(await host.open?.(draft())).toBe("failed");
    expect(shown).toEqual([]);
  });

  it("names an existing Connection by its own title, and a new id by nothing", async () => {
    const host = connectionDraftHost({
      ...API_SCOPE,
      client: client(held),
      mayWriteConnections: true,
      showRoute: () => undefined
    });
    expect(await host.connectionOf("exampledata")).toEqual({
      connectorType: "http_api",
      title: "Kanzlei-API"
    });
    expect(await host.connectionOf("crm")).toBeUndefined();
  });

  const renderCard = (
    queryClient: QueryClient,
    host: ReturnType<typeof connectionDraftHost>,
    shown: ConnectionDraft = draft()
  ) =>
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          ConnectionDraftHostProvider,
          { value: host, children: null },
          createElement(
            TranslationProvider,
            { locale: "en", children: null },
            createElement(ConnectionDraftCard, { draft: shown })
          )
        )
      )
    );

  it("uses a cached Connection list title only for the current API and identity", () => {
    const queryClient = new QueryClient();
    const host = connectionDraftHost({
      ...API_SCOPE,
      client: client({}),
      mayWriteConnections: false,
      showRoute: () => undefined
    });
    const cacheList = (apiBaseUrl: string, authScope: string, title: string) => {
      queryClient.setQueryData(
        ["assets", apiBaseUrl, authScope, "list", "connection", "", "", "", "en"],
        { pages: [{ items: [{ name: "exampledata", title }] }], pageParams: [undefined] }
      );
    };
    try {
      queryClient.setQueryData(
        ["assets", API_SCOPE.apiBaseUrl, "other-reader", "connection-draft-target", "exampledata"],
        { title: "Private target title", connectorType: "http_api" }
      );
      cacheList(API_SCOPE.apiBaseUrl, "other-reader", "Private title");
      cacheList("https://other.example.test", API_SCOPE.authScope, "Other instance");
      let markup = renderCard(queryClient, host);
      expect(markup).toContain("Exampledata");
      expect(markup).not.toContain("Private title");
      expect(markup).not.toContain("Private target title");
      expect(markup).not.toContain("Other instance");
      cacheList(API_SCOPE.apiBaseUrl, API_SCOPE.authScope, "Cached Kanzlei-API");
      markup = renderCard(queryClient, host);
      expect(markup).toContain("Cached Kanzlei-API");
      expect(markup).not.toContain("data-connection-draft-open");
    } finally {
      queryClient.clear();
    }
  });
});

/** The New connection dialog the card opens for `opened`, as markup, and the writes it made. */
async function renderDraftDialog(opened: ConnectionDraft) {
  const writes: unknown[] = [];
  await openConnectionDraft(opened, {
    connectorTypeOf: async () => undefined,
    showConnection: () => undefined,
    requestCreateDialog: () => undefined
  });
  const source: ConnectionSource = {
    mayTest: () => true,
    useDetail: () => ({ status: "loading" }),
    readDetail: async () => connectionDetail(),
    test: async () => ({ status: "ready", testedAt: "2026-10-14T10:00:00.000Z" }),
    setSecret: async () => undefined,
    discover: async () => undefined,
    useTest: () => ({ run: { status: "idle" }, start: () => undefined }),
    useHolders: () => ({ status: "hidden" }),
    principalHref: () => "",
    oauthStart: async () => {
      throw new Error("This test signs nothing in.");
    }
  };
  const markup = renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale: "en" },
      createElement(ConnectionCreateFlow, {
        source,
        checkName: async () => ({ available: true as const }),
        put: async (input) => {
          writes.push(input);
          return { revision: 1 };
        },
        remove: async () => undefined,
        mayDelete: () => true,
        onClose: () => undefined,
        onCreated: () => undefined
      })
    )
  );
  return { markup, writes };
}

describe("the New connection dialog opened from a card", () => {
  it("starts at the REST API's form with the draft's name, address, header names and test path, and no key", async () => {
    const { markup, writes } = await renderDraftDialog(draft());
    expect(markup).toContain('data-connection-create-form="http_api"');
    expect(markup).toContain('value="Exampledata"');
    expect(markup).toContain('value="https://api.exampledata.test"');
    expect(markup).toContain('value="x-client-instance-id"');
    expect(markup).toContain('value="/monitoring/health"');
    expect(markup).not.toContain(SECRET);
    // Nothing is written before Verbinden, and the tools wait for the approval after it.
    expect(writes).toEqual([]);
    // A drafted test path shows without headers, too.
    const opened = draft();
    const bare = await renderDraftDialog({
      ...opened,
      connection: { ...opened.connection, headerNames: [] }
    });
    expect(bare.markup).toContain('value="/monitoring/health"');
  });

  it("starts at the MCP server's form for a proposal, with the key header and no key", async () => {
    const { markup, writes } = await renderDraftDialog(proposal());
    expect(markup).toContain('data-connection-create-form="mcp"');
    expect(markup).toContain(`value="${ADDRESS}"`);
    expect(markup).toContain('value="x-brain-key"');
    expect(markup).not.toContain(SECRET);
    expect(writes).toEqual([]);
  });
});

describe("the message the person's tab sends once the Connection is ready", () => {
  const connection = { name: "brain", title: "Brain" };
  const en = createTranslationContext("en").t;

  it("says which tools are approved for what, names at most twenty and never the address", () => {
    expect(
      connectionReadyMessage(
        connection,
        { kind: "approved", tools: ["search"], surfaces: ["agent"] },
        en
      )
    ).toBe("Brain is connected (brain), 1 tool approved for agents: search.");
    const tools = Array.from({ length: 25 }, (_, index) => `tool_${index}`);
    const message = connectionReadyMessage(
      { name: "brain", title: "Brain" },
      { kind: "approved", tools, surfaces: ["agent", "bridge", "workflow"] },
      en
    );
    expect(message).toContain("tool_19, …");
    expect(message).not.toContain("tool_20");
    expect(message).not.toContain("example.test");
  });
});

describe("parameter enums in the approval list", () => {
  const INJECTION = '<img src=x onerror="alert(1)"> [click](javascript:alert(2))';
  // Each branch holds a separate set: following just one combinator branch would hide values.
  const operation = {
    name: "reports",
    path: "/reports/{region}",
    pathParams: { region: { schema: { enum: ["north", "south"] } } },
    query: {
      category: { schema: { enum: ["overview", INJECTION] } },
      nested: {
        schema: {
          anyOf: [
            { enum: ["any-first"] },
            { oneOf: [{ enum: ["one-first"] }, { allOf: [{ items: { enum: ["item-first"] } }] }] }
          ],
          properties: { status: { enum: ["property-first"] } },
          additionalProperties: { enum: ["additional-first"] },
          $defs: { kind: { enum: ["definition-first"] } }
        }
      }
    }
  };

  it.each(["pasted", "drafted"] as const)(
    "shows every allowed value of a %s operation as plain text",
    (source) => {
      const candidates = (() => {
        if (source === "pasted") {
          const read = pastedCandidates(`operations:\n  - ${JSON.stringify(operation)}`);
          if (!read.ok) throw new Error("Expected pasted declarations");
          return read.candidates;
        }
        const read = readConnectionDraft({
          output: {
            connection: { name: "reports", title: "Reports", baseUrl: "https://example.test" },
            operations: [operation]
          }
        });
        if (!read) throw new Error("Expected an agent draft");
        return read.operations;
      })();
      const markup = renderList({ candidates, declared: true });
      for (const value of [
        "north",
        "overview",
        "any-first",
        "one-first",
        "item-first",
        "property-first",
        "additional-first",
        "definition-first"
      ]) {
        expect(markup).toContain(value);
      }
      expect(markup).toContain("&lt;img src=x onerror=");
      expect(markup).not.toContain("<img");
      expect(markup).not.toContain("<a ");
    }
  );
});

function renderList(
  props: Partial<Parameters<typeof ConnectionApprovalList>[0]> &
    Pick<Parameters<typeof ConnectionApprovalList>[0], "candidates">
): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { locale: "en", children: null },
      createElement(ConnectionApprovalList, {
        choice: {
          selected: new Set(props.candidates.map((candidate) => candidate.name)),
          surfaces: new Set<ApprovalSurface>(["agent"])
        },
        onSelectedChange: () => undefined,
        onSurfacesChange: () => undefined,
        ...props
      })
    )
  );
}

/** The opening tag of a list row's own check box, by the row's tool. */
function rowCheckbox(markup: string, name: string): string {
  const row = markup.split(`data-approval-tool="${name}"`)[1] ?? "";
  return /<button[^>]*role="checkbox"[^>]*>/u.exec(row)?.[0] ?? "";
}

describe("the approval list's choices (ACCEPT-FIX-7 C8, C10)", () => {
  it("cannot tick a pasted operation outside the reading cut", () => {
    const read = pastedCandidates(
      "- name: list_clients\n  path: /clients\n- name: create_client\n  method: POST\n  path: /clients"
    );
    if (!read.ok) throw new Error("Expected pasted declarations");
    const markup = renderList({ candidates: read.candidates, declared: true });
    expect(rowCheckbox(markup, "create_client")).toMatch(/ disabled=""/u);
    expect(rowCheckbox(markup, "create_client")).toContain('aria-checked="false"');
    expect(rowCheckbox(markup, "list_clients")).not.toMatch(/ disabled=""/u);
  });

  it("offers reads or changes per discovered tool, starting with the hint, and none for declarations", () => {
    const candidates = discoveredCandidates([
      { name: "read_wiki", proposedEffect: "changing", fingerprint: "a".repeat(64) }
    ]);
    const select = (markup: string) =>
      /<select[^>]*data-approval-effect="read_wiki"[^>]*>.*?<\/select>/su.exec(markup)?.[0];
    expect(select(renderList({ candidates, onEffectsChange: () => undefined }))).toMatch(
      /<option value="changing" selected="">/u
    );
    const chosen = renderList({
      candidates,
      onEffectsChange: () => undefined,
      choice: {
        selected: new Set(["read_wiki"]),
        surfaces: new Set<ApprovalSurface>(["agent"]),
        effects: new Map([["read_wiki", "reading" as const]])
      }
    });
    expect(select(chosen)).toMatch(/<option value="reading" selected="">/u);

    const read = pastedCandidates("- name: list_clients\n  path: /clients");
    if (!read.ok) throw new Error("Expected pasted declarations");
    expect(
      renderList({ candidates: read.candidates, declared: true, onEffectsChange: () => undefined })
    ).not.toContain("data-approval-effect");
  });
});
