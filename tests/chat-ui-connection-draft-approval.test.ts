// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { openConnectionDraft, readConnectionDraft } from "@work-shape/catalyst-chat-ui/build-area";
import { mountBuildPage, unmountBuildPages } from "./chat-ui-build-page-harness";
import { connectionAsset, connectionDetail } from "./chat-ui-connection-fixtures";
import { BOOKKEEPING_OPERATIONS, BOOKKEEPING_OPERATION_NAMES } from "./support/bookkeeping-draft";
import { CONDITION_WAIT_MS } from "./support/assertions";

// ACCEPT-2c E4: the agent drafted five read tools for an existing REST API, and the first
// "Approve 5 tools" on its page saved four, without `list_buchungen`. The draft is opened from
// its card onto the page, approved as it stands, and the one save carries all five.

const NAME = "buchhaltung-kanzlei";

afterEach(async () => {
  await unmountBuildPages();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** The page of the REST API with no tools yet, and each save it sends. */
async function openPage() {
  const asset = connectionAsset(NAME, {
    origin: "runtime",
    displayName: "Buchhaltung Kanzlei",
    connectorType: "http_api",
    settings: { baseUrl: "http://127.0.0.1:5829", testPath: BOOKKEEPING_OPERATIONS[0].path },
    operations: []
  });
  const puts: Record<string, unknown>[] = [];
  const page = await mountBuildPage(
    asset,
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
        return { revision: 2 };
      }
    }
  );
  return { document: page.ownerDocument, puts };
}

/** The agent's draft of `operations`, opened from its card onto the page. */
async function openDraft(operations: readonly Record<string, unknown>[]) {
  const draft = readConnectionDraft({
    output: {
      connection: { name: NAME, title: "Buchhaltung Kanzlei", baseUrl: "http://127.0.0.1:5829" },
      operations
    }
  });
  if (!draft) throw new Error("The answer is a draft");
  await act(async () => {
    await openConnectionDraft(draft, {
      connectorTypeOf: async () => "http_api",
      showConnection: () => undefined,
      requestCreateDialog: () => undefined
    });
  });
}

/** The approval list's rows once it shows `count` of them, and its one button. */
async function approvalList(document: Document, count: number) {
  return vi.waitFor(
    () => {
      const rows = [...document.querySelectorAll("[data-approval-tool]")].map((row) =>
        row.getAttribute("data-approval-tool")
      );
      const approve = document.querySelector<HTMLButtonElement>("[data-connection-approve]");
      if (!approve || rows.length !== count) throw new Error("no approval list yet");
      return { rows, approve };
    },
    { timeout: CONDITION_WAIT_MS }
  );
}

/** Approves the list as it stands; answers the names of the one save's operations. */
async function approveAll(document: Document, puts: Record<string, unknown>[]) {
  const { approve } = await approvalList(document, BOOKKEEPING_OPERATIONS.length);
  expect(approve.textContent).toBe("Approve 5 tools");
  await act(async () => approve.click());
  await vi.waitFor(() => expect(puts).toHaveLength(1), { timeout: CONDITION_WAIT_MS });
  const saved = puts[0]?.operations;
  if (!Array.isArray(saved)) throw new Error("The save holds no operations");
  return saved;
}

describe("The agent's draft of five read tools, approved on the Connection's page", () => {
  it("saves all five in the one save, list_buchungen among them", async () => {
    const { document, puts } = await openPage();
    await openDraft(BOOKKEEPING_OPERATIONS);
    expect((await approvalList(document, 5)).rows).toEqual(BOOKKEEPING_OPERATION_NAMES);
    const saved = await approveAll(document, puts);
    expect(saved.map((operation) => operation.name)).toEqual(BOOKKEEPING_OPERATION_NAMES);
    expect(saved).toContainEqual(
      expect.objectContaining({
        name: "list_buchungen",
        method: "GET",
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
    expect((await approvalList(document, 5)).rows).toEqual(BOOKKEEPING_OPERATION_NAMES);
    const saved = await approveAll(document, puts);
    expect(saved.map((operation) => operation.name)).toEqual(BOOKKEEPING_OPERATION_NAMES);
  });
});
