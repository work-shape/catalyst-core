// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionDetail } from "@work-shape/catalyst-api-client";
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
import { BOOKKEEPING_OPERATIONS, BOOKKEEPING_OPERATION_NAMES } from "./support/bookkeeping-draft";
import { CONDITION_WAIT_MS } from "./support/assertions";

// Drafted, pasted and given tools approved on a REST API's page or in the New connection dialog:
// what the one save holds (ACCEPT-2c E4, ACCEPT-2e), and that the conversation the card stands
// in hears an action that took effect once (CHAT-CONN-1), and nothing else.

const NAME = "crm";
const FROM = { conversationId: "conv_card", agentName: "workshaper" };
const WAIT = { timeout: CONDITION_WAIT_MS };

const roots: Root[] = [];

afterEach(async () => {
  await unmountBuildPages();
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** The page of a REST API with no tools yet, each save it sends and each message it tells. */
async function openPage(put?: () => Promise<{ revision: number }>) {
  const puts: Record<string, unknown>[] = [];
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
      put: async (input) => {
        if ("config" in input) puts.push(input.config);
        return put ? put() : { revision: 2 };
      },
      tellConversation: async (to, text) => {
        told.push({ to, text });
      }
    }
  );
  return { document: page.ownerDocument, puts, told };
}

/** The agent's draft of `operations`, opened from its card onto the page. */
async function openDraft(operations: readonly Record<string, unknown>[], from?: typeof FROM) {
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

/** The approval list's rows once it shows `count` of them, and its one button. */
async function approvalList(document: Document, count: number) {
  return vi.waitFor(() => {
    const rows = [...document.querySelectorAll("[data-approval-tool]")].map((row) =>
      row.getAttribute("data-approval-tool")
    );
    const approve = document.querySelector<HTMLButtonElement>("[data-connection-approve]");
    if (!approve || rows.length !== count) throw new Error("no approval list yet");
    return { rows, approve };
  }, WAIT);
}

describe("the agent's draft of five read tools, approved on the Connection's page (ACCEPT-2c E4)", () => {
  it("saves all five in the one save, list_buchungen among them", async () => {
    const { document, puts } = await openPage();
    await openDraft(BOOKKEEPING_OPERATIONS);
    const { rows, approve } = await approvalList(document, 5);
    expect(rows).toEqual(BOOKKEEPING_OPERATION_NAMES);
    await act(async () => approve.click());
    await vi.waitFor(() => expect(puts).toHaveLength(1), WAIT);
    const saved = puts[0]?.operations;
    if (!Array.isArray(saved)) throw new Error("The save holds no operations");
    expect(saved.map((operation) => operation.name)).toEqual(BOOKKEEPING_OPERATION_NAMES);
    expect(saved).toContainEqual(
      expect.objectContaining({
        name: "list_buchungen",
        path: BOOKKEEPING_OPERATIONS[3].path,
        query: { monat: { required: true, schema: { type: "string", examples: ["2026-09"] } } },
        effect: "reading",
        exposure: ["agent"],
        enabled: true
      })
    );
  });

  // A list still open with the agent's earlier draft of four kept its rows when the newer
  // draft of five was opened, and its approval saved the four without list_buchungen.
  it("shows a newer draft opened while an earlier one is still in the list, and saves it", async () => {
    const { document, puts } = await openPage();
    await openDraft(BOOKKEEPING_OPERATIONS.filter(({ name }) => name !== "list_buchungen"));
    await approvalList(document, 4);
    await openDraft(BOOKKEEPING_OPERATIONS);
    const { approve } = await approvalList(document, 5);
    await act(async () => approve.click());
    await vi.waitFor(() => expect(puts).toHaveLength(1), WAIT);
    const saved = puts[0]?.operations;
    expect(Array.isArray(saved) && saved.map((operation) => operation.name)).toEqual(
      BOOKKEEPING_OPERATION_NAMES
    );
  });
});

describe("the conversation of the card, after approving drafted tools", () => {
  const operations = [
    { name: "list_clients", method: "GET", path: "/clients", effect: "reading" },
    { name: "get_client", method: "GET", path: "/clients/{id}", effect: "reading" }
  ];

  it("hears it once, with the tools saved", async () => {
    const { document, puts, told } = await openPage();
    await openDraft(operations, FROM);
    await act(async () => (await approvalList(document, 2)).approve.click());
    await vi.waitFor(() => expect(told).toHaveLength(1), WAIT);
    expect(puts).toHaveLength(1);
    expect(told[0]).toEqual({
      to: FROM,
      text: "CRM is connected (crm), 2 tools approved for agents: list_clients, get_client."
    });
  });

  it("hears nothing where the save is refused", async () => {
    const { document, told } = await openPage(async () => {
      throw new Error("refused");
    });
    await openDraft(operations, FROM);
    await act(async () => (await approvalList(document, 2)).approve.click());
    await vi.waitFor(
      () => expect(document.querySelector("[data-connection-approve-refused]")).not.toBeNull(),
      WAIT
    );
    expect(told).toEqual([]);
  });

  it("is not told for a draft that names no conversation", async () => {
    const { document, puts, told } = await openPage();
    await openDraft(operations);
    await act(async () => (await approvalList(document, 2)).approve.click());
    await vi.waitFor(() => expect(puts).toHaveLength(1), WAIT);
    expect(told).toEqual([]);
  });
});

describe("the conversation of the card, after giving tools from the agent's card", () => {
  const tools: GiveTool[] = [
    { toolName: "connection.crm.list_clients", title: "List clients" },
    { toolName: "connection.crm.get_client", title: "Get client" }
  ];

  async function giveFromCard(give: () => Promise<"done" | "waits">) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const told: string[] = [];
    const source: ConnectionGiveSource = {
      connection: async () => ({ title: "CRM", tools }),
      agents: async () => [{ name: "workshaper", title: "Workshaper" }],
      readAgent: async () => ({
        id: "agent-workshaper",
        revision: 4,
        config: { toolNames: ["read_skill"] }
      }),
      give
    };
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
              { locale: "en", children: null },
              createElement(ConnectionGiveCardView, {
                offer: { connection: NAME, agent: "workshaper" },
                host: { source, viewerId: "user-give" },
                tell: async (text: string) => {
                  told.push(text);
                },
                read: { status: "ready", connection: { title: "CRM", tools } }
              })
            )
          )
        )
      );
    });
    for (const selector of [
      "[data-connection-give]",
      "[data-connection-give-next]",
      "[data-connection-give-confirm]"
    ]) {
      const button = await vi.waitFor(() => {
        const found = document.querySelector<HTMLButtonElement>(selector);
        if (!found || found.disabled) throw new Error(`no ${selector} yet`);
        return found;
      }, WAIT);
      await act(async () => button.click());
    }
    await vi.waitFor(() => {
      if (!document.querySelector("[data-connection-give-outcome], [data-connection-give-done]"))
        throw new Error("not done yet");
    }, WAIT);
    return told;
  }

  it("hears it once the agent is published with the tools", async () => {
    expect(await giveFromCard(async () => "done")).toEqual([
      "Workshaper (workshaper) now has 2 tools of CRM (crm): connection.crm.list_clients, connection.crm.get_client."
    ]);
  });

  it("hears nothing while the publish waits for an approval, or where it is refused", async () => {
    expect(await giveFromCard(async () => "waits")).toEqual([]);
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    document.body.replaceChildren();
    expect(
      await giveFromCard(async () => {
        throw new Error("refused");
      })
    ).toEqual([]);
  });
});

const PASTED = [
  "- name: list_clients",
  "  method: GET",
  "  path: /clients",
  "- name: list_months",
  "  method: GET",
  "  path: /months"
].join("\n");

function typeInto(field: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  if (!field) throw new Error("no field to type into");
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Opens the paste field, pastes PASTED and checks it. */
async function paste() {
  await act(async () =>
    document.querySelector<HTMLButtonElement>("[data-connection-paste] button")?.click()
  );
  const field = document.querySelector<HTMLTextAreaElement>(
    "[data-connection-paste-field] textarea, textarea[data-connection-paste-field]"
  );
  await act(async () => typeInto(field, PASTED));
  await act(async () =>
    document.querySelector<HTMLButtonElement>("[data-connection-paste-check]")?.click()
  );
}

const exampledata = () =>
  connectionAsset("exampledata", {
    origin: "runtime",
    connectorType: "http_api",
    settings: { baseUrl: "https://gateway.example.test/datevconnect" }
  });

describe("pasted tools of a REST API (ACCEPT-2e)", () => {
  it("count on the page as soon as the save is in, without waiting for a later read", async () => {
    const asset = exampledata();
    const detailPath = apiOperations["connections.get"].path.replace(":name", asset.name);
    let operations: ConnectionDetail["operations"] = [];
    const page = await mountBuildPage(
      asset,
      "connections",
      (request, url) =>
        request.method === "GET" && url.pathname === detailPath
          ? Response.json(connectionDetail(asset.name, { operations }))
          : undefined,
      [],
      {
        put: async (input) => {
          const written = "config" in input ? input.config.operations : undefined;
          operations = (Array.isArray(written) ? written : []).map((operation: unknown) => {
            const name =
              typeof operation === "object" && operation !== null && "name" in operation
                ? String(operation.name)
                : "";
            return {
              name,
              toolName: `connection.${asset.name}.${name}`,
              effect: "reading",
              exposure: ["agent"],
              enabled: true,
              status: "ready"
            };
          });
          return { revision: 2 };
        }
      }
    );
    await vi.waitFor(
      () => expect(page.querySelector("[data-connection-paste]")).not.toBeNull(),
      WAIT
    );
    await paste();
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-connection-approve]")?.click()
    );
    expect(operations.map((operation) => operation.name)).toEqual(["list_clients", "list_months"]);
    // The page reads its Connection again every 2 s while it waits: the count is there before.
    await vi.waitFor(
      () =>
        expect(page.querySelector("section#operations, #operations")?.textContent ?? "").toMatch(
          /2.*List months/u
        ),
      { timeout: 1000, interval: 50 }
    );
  });

  it("are saved by the first click on approve in the list page's dialog, which then opens the Connection", async () => {
    const asset = exampledata();
    const testPath = apiOperations["connections.test"].path.replace(":name", asset.name);
    const detailPath = apiOperations["connections.get"].path.replace(":name", asset.name);
    const puts: Record<string, unknown>[] = [];
    const opened: { kindPath?: string; name?: string }[] = [];
    const page = await mountBuildPage(
      asset,
      "connections",
      (request, url) =>
        url.pathname === testPath
          ? Response.json({ status: "ready", testedAt: "2026-10-19T09:00:00.000Z" })
          : request.method === "GET" && url.pathname === detailPath
            ? Response.json(connectionDetail(asset.name, { operations: [] }))
            : undefined,
      [],
      {
        put: async (input) => {
          if ("config" in input) puts.push(input.config);
          return { revision: puts.length };
        },
        list: { opened }
      }
    );
    const newConnection = () =>
      [...page.querySelectorAll("button")].find(
        (found) => found.textContent?.trim() === "New connection"
      );
    // "New connection" stands on the tab that manages the instance's Connections.
    const manage = () => page.querySelector<HTMLElement>('[data-connections-tab="manage"]');
    await vi.waitFor(() => expect(manage()).not.toBeNull(), WAIT);
    await act(async () => {
      manage()?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      manage()?.click();
    });
    await vi.waitFor(() => expect(newConnection()).toBeDefined(), WAIT);
    await act(async () => newConnection()?.click());
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-connection-type="http_api"] button')?.click()
    );
    const input = (selector: string) =>
      document.querySelector<HTMLInputElement>(`input${selector}, ${selector} input`);
    await act(async () => typeInto(input('[data-name-with-address-field="name"]'), "Exampledata"));
    await act(async () =>
      typeInto(input('[data-connection-field="url"]'), "https://gateway.example.test/datevconnect")
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-connection-connect]")?.click()
    );
    await vi.waitFor(
      () => expect(document.querySelector("[data-connection-paste] button")).not.toBeNull(),
      WAIT
    );
    await paste();
    expect(puts).toHaveLength(1);
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-connection-approve]")?.click()
    );
    await vi.waitFor(() => expect(puts).toHaveLength(2), { timeout: 1000 });
    // Approved for agents, the done state offers the give to an agent (CS-5d); Done opens it.
    await vi.waitFor(
      () => expect(document.querySelector("[data-connection-give]")).not.toBeNull(),
      { timeout: 1000 }
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-connection-approved-done]")?.click()
    );
    expect(opened.at(-1)).toEqual({ kindPath: "connections", name: "exampledata" });
  });
});
