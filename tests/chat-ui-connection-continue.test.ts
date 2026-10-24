// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  ConnectionGiveCardView,
  openConnectionDraft,
  readConnectionDraft,
  type ConnectionGiveSource,
  type GiveTool
} from "@work-shape/catalyst-chat-ui/build-area";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { mountBuildPage, unmountBuildPages } from "./chat-ui-build-page-harness";
import { connectionAsset, connectionDetail } from "./chat-ui-connection-fixtures";
import { TranslationProvider } from "./chat-ui-render-harness";
import { CONDITION_WAIT_MS } from "./support/assertions";

// After the person approves drafted tools, or gives a Connection's tools to an agent from the
// agent's card, the conversation the card stands in hears it once, as the person's message
// (CHAT-CONN-1), so its agent goes on without the person typing. Only an action that took
// effect is told: a refusal, a conflict, a draft left unpublished or a wait for an approval
// tells nothing, and nor does the same action opened outside that conversation.

const NAME = "crm";
const FROM = { conversationId: "conv_card", agentName: "workshaper" };

const roots: Root[] = [];

afterEach(async () => {
  await unmountBuildPages();
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("approving drafted tools on the Connection's page", () => {
  const operations = [
    { name: "list_clients", method: "GET", path: "/clients", effect: "reading" },
    { name: "get_client", method: "GET", path: "/clients/{id}", effect: "reading" }
  ];

  async function openPage(put: () => Promise<{ revision: number }>) {
    const told: { to: unknown; text: string }[] = [];
    const page = await mountBuildPage(
      connectionAsset(NAME, {
        origin: "runtime",
        displayName: "CRM",
        connectorType: "http_api",
        settings: { baseUrl: "http://127.0.0.1:5829", testPath: "/clients" },
        operations: []
      }),
      "connections",
      (request, url) =>
        request.method === "GET" &&
        url.pathname === apiOperations["connections.get"].path.replace(":name", NAME)
          ? Response.json(connectionDetail(NAME, { operations: [] }))
          : undefined,
      [],
      {
        put,
        tellConversation: async (to, text) => {
          told.push({ to, text });
        }
      }
    );
    return { document: page.ownerDocument, told };
  }

  async function openDraft(from?: typeof FROM) {
    const draft = readConnectionDraft({
      output: {
        connection: { name: NAME, title: "CRM", baseUrl: "http://127.0.0.1:5829" },
        operations
      }
    });
    if (!draft) throw new Error("The answer is a draft");
    await act(async () => {
      await openConnectionDraft(from ? { ...draft, from } : draft, {
        connectorTypeOf: async () => "http_api",
        showConnection: () => undefined,
        requestCreateDialog: () => undefined
      });
    });
  }

  async function approve(document: Document) {
    const button = await vi.waitFor(
      () => {
        const found = document.querySelector<HTMLButtonElement>("[data-connection-approve]");
        if (!found) throw new Error("no approval list yet");
        return found;
      },
      { timeout: CONDITION_WAIT_MS }
    );
    await act(async () => button.click());
  }

  it("tells the conversation of the card once, with the tools it saved", async () => {
    let saves = 0;
    const { document, told } = await openPage(async () => {
      saves += 1;
      return { revision: 2 };
    });
    await openDraft(FROM);
    await approve(document);
    await vi.waitFor(() => expect(told).toHaveLength(1), { timeout: CONDITION_WAIT_MS });
    expect(saves).toBe(1);
    expect(told[0]).toEqual({
      to: FROM,
      text: "CRM is connected (crm), 2 tools approved for agents: list_clients, get_client."
    });
  });

  it("tells nothing where the save is refused", async () => {
    const { document, told } = await openPage(async () => {
      throw new Error("refused");
    });
    await openDraft(FROM);
    await approve(document);
    await vi.waitFor(
      () => expect(document.querySelector("[data-connection-approve-refused]")).not.toBeNull(),
      { timeout: CONDITION_WAIT_MS }
    );
    expect(told).toEqual([]);
  });

  it("tells nothing for a draft that names no conversation", async () => {
    let saves = 0;
    const { document, told } = await openPage(async () => {
      saves += 1;
      return { revision: 2 };
    });
    await openDraft();
    await approve(document);
    await vi.waitFor(() => expect(saves).toBe(1), { timeout: CONDITION_WAIT_MS });
    expect(told).toEqual([]);
  });
});

describe("giving the tools from the agent's card", () => {
  const tools: GiveTool[] = [
    { toolName: "connection.crm.list_clients", title: "List clients" },
    { toolName: "connection.crm.get_client", title: "Get client" }
  ];

  function source(options: { publishWaits?: boolean; publishRefused?: boolean }) {
    const given: ConnectionGiveSource = {
      connection: async () => ({ title: "CRM", tools }),
      agents: async () => [{ name: "workshaper", title: "Workshaper" }],
      readAgent: async () => ({ revision: 4, config: { toolNames: ["read_skill"] } }),
      readDraft: async () => null,
      saveDraft: async () => 5,
      publish: async () => {
        if (options.publishRefused) throw new Error("refused");
        return options.publishWaits ? "waits" : "done";
      },
      discard: async () => undefined
    };
    return given;
  }

  async function giveFromCard(
    options: { publishWaits?: boolean; publishRefused?: boolean; locale?: "en" | "de" },
    tell?: (text: string) => Promise<void>
  ) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(
            UiRoot,
            { mode: "light", labels: uiLabelsEn },
            createElement(
              TranslationProvider,
              { locale: options.locale ?? "en", children: null },
              createElement(ConnectionGiveCardView, {
                offer: { connection: NAME, agent: "workshaper" },
                host: { source: source(options), viewerId: "user-give" },
                ...(tell ? { tell } : {}),
                read: { status: "ready", connection: { title: "CRM", tools } }
              })
            )
          )
        )
      );
    });
    const click = async (selector: string) => {
      const button = await vi.waitFor(
        () => {
          const found = document.querySelector<HTMLButtonElement>(selector);
          if (!found || found.disabled) throw new Error(`no ${selector} yet`);
          return found;
        },
        { timeout: CONDITION_WAIT_MS }
      );
      await act(async () => button.click());
    };
    await click("[data-connection-give]");
    await click("[data-connection-give-next]");
    await click("[data-connection-give-confirm]");
    await vi.waitFor(
      () => {
        if (!document.querySelector("[data-connection-give-outcome], [data-connection-give-done]"))
          throw new Error("not done yet");
      },
      { timeout: CONDITION_WAIT_MS }
    );
  }

  it("tells the conversation once the agent is published with the tools", async () => {
    const told: string[] = [];
    await giveFromCard({}, async (text) => {
      told.push(text);
    });
    expect(told).toEqual([
      "Workshaper (workshaper) now has 2 tools of CRM (crm): connection.crm.list_clients, connection.crm.get_client."
    ]);
  });

  it("tells it in the reader's language", async () => {
    const told: string[] = [];
    await giveFromCard({ locale: "de" }, async (text) => {
      told.push(text);
    });
    expect(told).toEqual([
      "Workshaper (workshaper) hat jetzt 2 Werkzeuge von CRM (crm): connection.crm.list_clients, connection.crm.get_client."
    ]);
  });

  it("tells nothing while the publish waits for an approval", async () => {
    const told: string[] = [];
    await giveFromCard({ publishWaits: true }, async (text) => {
      told.push(text);
    });
    expect(told).toEqual([]);
  });

  it("tells nothing where the publish is refused", async () => {
    const told: string[] = [];
    await giveFromCard({ publishRefused: true }, async (text) => {
      told.push(text);
    });
    expect(told).toEqual([]);
  });
});
