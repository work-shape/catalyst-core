import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  ConnectionCreateFlow,
  ConnectionDraftCardView,
  openConnectionDraft,
  readConnectionDraft,
  type ConnectionDraft,
  type ConnectionSource
} from "@vivd-catalyst/chat-ui/build-area";
import { connectionDetail } from "./chat-ui-connection-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The card of the agent's draft of REST API tools (CS-5c): what it reads of the tool's answer,
// where its button leads, and that nothing is saved on the way. The person's confirmation in
// the approval list is the save (e2e/connection-editor.spec.ts clicks it).

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
  it("takes the name, address, header names and declarations, and no key or approval", () => {
    const read = draft();
    expect(JSON.stringify(read)).not.toContain(SECRET);
    expect(read.connection).toEqual({
      name: "exampledata",
      title: "Exampledata",
      baseUrl: "https://api.exampledata.com",
      headerNames: ["x-client-instance-id"]
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
    expect(en).toContain("Tools for Exampledata");
    expect(en).toContain("Draft · 2 tools, reading");
    expect(en).toContain("Mandanten auflisten");
    expect(en).toContain("Review and approve");
    expect(en).toContain("Nothing is saved before you approve.");
    expect(en).not.toContain(SECRET);
    const de = render("de", true);
    expect(de).toContain("Tools für Exampledata");
    expect(de).toContain("Entwurf · 2 Tools, lesend");
    expect(de).toContain("Prüfen und freigeben");
    expect(de).toContain("Gespeichert wird erst mit deiner Freigabe.");
  });

  it("has no button for a reader who may write no Connection", () => {
    const en = render("en", false);
    expect(en).not.toContain("data-connection-draft-open");
    expect(en).toContain("Someone who may edit connections approves these tools.");
  });
});

describe("the New connection dialog opened from a card", () => {
  it("starts at the REST API's form with the draft's name, address and header names, and no key", async () => {
    const writes: unknown[] = [];
    await openConnectionDraft(draft(), {
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
      principalHref: () => ""
    };
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "en" },
        createElement(ConnectionCreateFlow, {
          source,
          namespaces: [],
          mayNameFreely: true,
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
    expect(markup).toContain('data-connection-create-form="http_api"');
    expect(markup).toContain('value="Exampledata"');
    expect(markup).toContain('value="https://api.exampledata.com"');
    expect(markup).toContain('value="x-client-instance-id"');
    expect(markup).not.toContain(SECRET);
    // Nothing is written before Verbinden, and the tools wait for the approval after it.
    expect(writes).toEqual([]);
  });
});
