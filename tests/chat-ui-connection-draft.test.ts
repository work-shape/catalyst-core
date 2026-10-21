import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createApiClient } from "@work-shape/catalyst-api-client";
import {
  ConnectionCreateFlow,
  ConnectionDraftCard,
  ConnectionDraftHostProvider,
  ConnectionDraftCardView,
  connectionDraftHost,
  openConnectionDraft,
  readConnectionDraft,
  type ConnectionDraft,
  type ConnectionSource
} from "@work-shape/catalyst-chat-ui/build-area";
import { connectionAsset, connectionDetail } from "./chat-ui-connection-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The card of the agent's draft of REST API tools (CS-5c): what it reads of the tool's answer,
// where its button leads, and that nothing is saved on the way. The person's confirmation in
// the approval list is the save (e2e/connection-editor.spec.ts clicks it).

const API_SCOPE = { apiBaseUrl: "https://catalyst.example.test", authScope: "reader-a" };

/** A text that stands for a key. No draft, card or form below may repeat it. */
const SECRET = "sk-live-card-7a6b5c4d";

/** The answer of the draft tool, with members an answer must never bring to the card. */
const answer = {
  output: {
    connection: {
      name: "exampledata",
      title: "Exampledata",
      baseUrl: "https://api.exampledata.com",
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

describe("the draft the card reads", () => {
  it("takes the name, address, header names, test path and declarations, and no key or approval", () => {
    const read = draft();
    expect(JSON.stringify(read)).not.toContain(SECRET);
    expect(read.connection).toEqual({
      connectorType: "http_api",
      name: "exampledata",
      title: "Exampledata",
      baseUrl: "https://api.exampledata.com",
      headerNames: ["x-client-instance-id"],
      testPath: "/monitoring/health"
    });
    expect(read.operations.map((operation) => operation.title)).toEqual([
      "Mandanten auflisten",
      "List fiscal years"
    ]);
    const [first] = read.operations;
    expect(first?.request).toEqual({ method: "GET", path: "/clients" });
    expect(first?.declaration).toEqual({
      title: "Mandanten auflisten",
      description: "Lists the clients.",
      method: "GET",
      path: "/clients"
    });
    // Which surfaces may use a tool is the person's choice in the list, never the agent's.
    expect(first).not.toHaveProperty("exposure");
  });

  it("is no draft for a refusal, a call still running or an answer with no operation", () => {
    expect(readConnectionDraft(undefined)).toBeUndefined();
    expect(
      readConnectionDraft({ status: "failed", error: { code: "validation_failed", message: "x" } })
    ).toBeUndefined();
    expect(readConnectionDraft({ output: { ...answer.output, operations: [] } })).toBeUndefined();
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

  it("opens the page of an existing REST API, and for a new id the New connection dialog", async () => {
    const existing = host("http_api");
    expect(await openConnectionDraft(draft(), existing.host)).toBe("opened");
    expect(existing.shown).toEqual(["exampledata"]);
    expect(existing.dialogs()).toBe(0);

    const missing = host(undefined);
    expect(await openConnectionDraft(draft(), missing.host)).toBe("opened");
    expect(missing.shown).toEqual([undefined]);
    expect(missing.dialogs()).toBe(1);
  });

  it("leaves a Connection of another type and a failed read where they are", async () => {
    const mcp = host("mcp");
    expect(await openConnectionDraft(draft(), mcp.host)).toBe("not_rest");
    expect(mcp.shown).toEqual([]);
    const failed = host(new Error("offline"));
    expect(await openConnectionDraft(draft(), failed.host)).toBe("failed");
    expect(failed.shown).toEqual([]);
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

  it("gives the button only to a reader who may write Connections", () => {
    const input = { ...API_SCOPE, client: client({}), showRoute: () => undefined };
    expect(connectionDraftHost({ ...input, mayWriteConnections: false }).open).toBeUndefined();
    expect(connectionDraftHost({ ...input, mayWriteConnections: true }).open).toBeDefined();
  });

  it("names an existing Connection by its own title, and a new id by nothing", async () => {
    const host = connectionDraftHost({
      ...API_SCOPE,
      client: client({ exampledata: { connectorType: "http_api", displayName: "Kanzlei-API" } }),
      mayWriteConnections: true,
      showRoute: () => undefined
    });
    expect(await host?.connectionOf("exampledata")).toEqual({
      connectorType: "http_api",
      title: "Kanzlei-API"
    });
    expect(await host?.connectionOf("crm")).toBeUndefined();
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

  const renderCard = (queryClient: QueryClient, host: ReturnType<typeof connectionDraftHost>) =>
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
            createElement(ConnectionDraftCard, { draft: draft() })
          )
        )
      )
    );

  it("resolves an accessible existing title for the actual reader card without an approval button", async () => {
    const queryClient = new QueryClient();
    const host = connectionDraftHost({
      ...API_SCOPE,
      client: client({ exampledata: { connectorType: "http_api", displayName: "Kanzlei-API" } }),
      mayWriteConnections: false,
      showRoute: () => {
        throw new Error("A reader must not navigate to approval");
      }
    });
    try {
      await queryClient.fetchQuery({
        queryKey: [
          "assets",
          API_SCOPE.apiBaseUrl,
          API_SCOPE.authScope,
          "connection-draft-target",
          "exampledata"
        ],
        queryFn: async () => (await host.connectionOf("exampledata")) ?? null
      });
      const markup = renderCard(queryClient, host);
      expect(markup).toContain("Tools the agent drafted for the Kanzlei-API");
      expect(markup).not.toContain("for the Exampledata API");
      expect(markup).not.toContain("data-connection-draft-open");
    } finally {
      queryClient.clear();
    }
  });

  it.each([403, 404])(
    "uses the agent title when the reader cannot read the target (%s), without an approval button",
    async (status) => {
      const queryClient = new QueryClient();
      const host = connectionDraftHost({
        ...API_SCOPE,
        client: client({}, status),
        mayWriteConnections: false,
        showRoute: () => undefined
      });
      try {
        await queryClient.fetchQuery({
          queryKey: [
            "assets",
            API_SCOPE.apiBaseUrl,
            API_SCOPE.authScope,
            "connection-draft-target",
            "exampledata"
          ],
          queryFn: async () => (await host.connectionOf("exampledata")) ?? null
        });
        const markup = renderCard(queryClient, host);
        expect(markup).toContain("Tools the agent drafted for the Exampledata API");
        expect(markup).not.toContain("data-connection-draft-open");
      } finally {
        queryClient.clear();
      }
    }
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
        {
          pages: [{ items: [{ name: "exampledata", title }] }],
          pageParams: [undefined]
        }
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
      expect(markup).toContain("Tools the agent drafted for the Exampledata API");
      expect(markup).not.toContain("Private title");
      expect(markup).not.toContain("Private target title");
      expect(markup).not.toContain("Other instance");
      cacheList(API_SCOPE.apiBaseUrl, API_SCOPE.authScope, "Cached Kanzlei-API");
      markup = renderCard(queryClient, host);
      expect(markup).toContain("Tools the agent drafted for the Cached Kanzlei-API");
      expect(markup).not.toContain("data-connection-draft-open");
    } finally {
      queryClient.clear();
    }
  });
});

describe("the card", () => {
  const render = (locale: "en" | "de", writer: boolean) =>
    renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale },
        createElement(ConnectionDraftCardView, {
          draft: draft(),
          ...(writer ? { onOpen: async () => "opened" as const } : {})
        })
      )
    );

  it("names the Connection and its tools, and says nothing is saved before the approval", () => {
    const en = render("en", true);
    expect(en).toContain("Tools the agent drafted for the Exampledata API");
    expect(en).toContain("Not connected yet · 2 reading tools");
    expect(en).toContain("Mandanten auflisten");
    expect(en).toContain("Review and approve");
    expect(en).toContain("Nothing is saved before you approve.");
    expect(en).not.toContain(SECRET);
    const de = render("de", true);
    expect(de).toContain("Werkzeuge, die der Agent für die Exampledata-API entworfen hat");
    expect(de).toContain("Noch nicht verbunden · 2 lesende Werkzeuge");
    expect(de).toContain("Prüfen und freigeben");
    expect(de).toContain("Gespeichert wird erst mit deiner Freigabe.");
  });

  it("shows the title it is given: an existing Connection's own, not the agent's", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "de" },
        createElement(ConnectionDraftCardView, { draft: draft(), title: "Kanzlei-API" })
      )
    );
    expect(markup).toContain("Werkzeuge, die der Agent für die Kanzlei-API entworfen hat");
    expect(markup).not.toContain("Exampledata");
  });

  it("has no button for a reader who may write no Connection", () => {
    const en = render("en", false);
    expect(en).not.toContain("data-connection-draft-open");
    expect(en).toContain("Someone who may edit connections approves these tools.");
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
  it("starts at the REST API's form with the draft's name, address and header names, and no key", async () => {
    const { markup, writes } = await renderDraftDialog(draft());
    expect(markup).toContain('data-connection-create-form="http_api"');
    expect(markup).toContain('value="Exampledata"');
    expect(markup).toContain('value="https://api.exampledata.com"');
    expect(markup).toContain('value="x-client-instance-id"');
    // The test reads the drafted path, so a Verbinden that passes proves the key.
    expect(markup).toContain('value="/monitoring/health"');
    expect(markup).not.toContain(SECRET);
    // Nothing is written before Verbinden, and the tools wait for the approval after it.
    expect(writes).toEqual([]);
  });

  it("shows a drafted test path under an open Technical details, also without headers", async () => {
    const opened = draft();
    const { markup } = await renderDraftDialog({
      ...opened,
      connection: { ...opened.connection, headerNames: [] }
    });
    expect(markup).toContain('value="/monitoring/health"');
  });
});
