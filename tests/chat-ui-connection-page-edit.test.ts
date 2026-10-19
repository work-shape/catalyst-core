// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionDetail } from "@work-shape/catalyst-api-client";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import {
  buildAssetKinds,
  listedHealth,
  RAW_MAX_CHARS,
  newConnectionConfig,
  emptyConnectionForm,
  withConnectionAbout,
  withOperationEnabled,
  type BuildAsset
} from "@work-shape/catalyst-chat-ui/build-area";
import { platformContext } from "./chat-ui-build-fixtures";
import { mountBuildPage, unmountBuildPages } from "./chat-ui-build-page-harness";
import { connectionAsset, connectionDetail } from "./chat-ui-connection-fixtures";
import { renderToStaticMarkup } from "./chat-ui-render-harness";
import { settingsUser } from "./chat-ui-settings-fixtures";
import { CONDITION_WAIT_MS } from "./support/assertions";

/** Every wait of this file: generous, so a loaded machine does not fail it. */
const WAIT = { timeout: CONDITION_WAIT_MS };

// CONN-PAGE 2, 3, 4 and 6 on the Connection page of an instance whose answers the test gives:
// an operation is switched off and on beside Remove, the name and description are changed in
// place, "Used by" names Apps, Workflows and Knowledge Bases beside agents, and the list says
// how each Connection is. A release Connection stays read-only throughout.

afterEach(async () => {
  await unmountBuildPages();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** The accepted operations of the fixture's definition, as the revision holds them. */
const OPERATIONS = [
  { name: "revenue_by_month", effect: "reading", exposure: ["agent"], enabled: true },
  { name: "list_customers", effect: "reading", exposure: ["agent", "workflow"], enabled: true }
];

/**
 * The page of a Connection, read by an admin who may change it. Every save of the definition
 * is kept in `puts`.
 */
async function openPage(asset: BuildAsset, detail: Partial<ConnectionDetail> = {}) {
  const puts: Record<string, unknown>[] = [];
  const detailPath = apiOperations["connections.get"].path.replace(":name", asset.name);
  const page = await mountBuildPage(
    asset,
    "connections",
    (request, url) => {
      if (url.pathname === apiOperations["platform.context.get"].path) {
        return Response.json(platformContext([], ["connection.write"]));
      }
      if (request.method === "GET" && url.pathname === detailPath) {
        return Response.json(connectionDetail(asset.name, detail));
      }
      return undefined;
    },
    [],
    {
      user: settingsUser({ roles: ["user", "admin"] }),
      put: async (input) => {
        if ("config" in input) puts.push(input.config);
        return { revision: puts.length + 1 };
      }
    }
  );
  await vi.waitFor(
    () => expect(page.querySelector("[data-connection-operation]")).not.toBeNull(),
    WAIT
  );
  return { page, puts };
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element?.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("The switch of an operation (CONN-PAGE 2)", () => {
  it("switches one operation off and on and keeps every other member of the definition", () => {
    const config = { name: "x", connectorType: "mcp", operations: OPERATIONS, enabled: true };
    const off = withOperationEnabled(config, "revenue_by_month", false);
    expect(off.operations).toEqual([{ ...OPERATIONS[0], enabled: false }, OPERATIONS[1]]);
    expect({ ...off, operations: undefined }).toEqual({ ...config, operations: undefined });
    expect(withOperationEnabled(off, "revenue_by_month", true).operations).toEqual(OPERATIONS);
  });

  it("saves the operation switched off through the page's save, beside Remove", async () => {
    const asset = connectionAsset("sample-business", { origin: "runtime", operations: OPERATIONS });
    const { page, puts } = await openPage(asset);
    const toggle = page.querySelector<HTMLButtonElement>(
      '[data-connection-enabled="revenue_by_month"]'
    );
    expect(toggle?.getAttribute("role")).toBe("switch");
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    expect(toggle?.getAttribute("aria-label")).toBe("Revenue by month can be called");
    // It stands in the same row as Remove.
    expect(
      toggle?.parentElement?.querySelector('[data-connection-remove="revenue_by_month"]')
    ).not.toBeNull();
    await act(async () => toggle?.click());
    await vi.waitFor(() => expect(puts).toHaveLength(1), WAIT);
    expect(puts[0]?.operations).toEqual([{ ...OPERATIONS[0], enabled: false }, OPERATIONS[1]]);
    expect(puts[0]?.displayName).toBe(asset.config.displayName);
  });

  it("offers no switch, no editor and no Remove on a release Connection", async () => {
    const { page } = await openPage(connectionAsset("sample-business", { operations: OPERATIONS }));
    expect(page.querySelector("[data-build-read-only]")).not.toBeNull();
    expect(page.querySelector("[data-connection-enabled]")).toBeNull();
    expect(page.querySelector("[data-connection-remove]")).toBeNull();
    expect(page.querySelector("[data-connection-about]")).toBeNull();
    // What each operation calls is shown to every reader.
    expect(
      page.querySelector('[data-connection-operation-details="revenue_by_month"]')
    ).not.toBeNull();
  });
});

describe("The name and the description (CONN-PAGE 3)", () => {
  it("writes the trimmed name and description, and leaves an empty description out", () => {
    const config = { name: "x", displayName: "Old", description: "Old text", connectorType: "mcp" };
    expect(
      withConnectionAbout(config, { title: "  New  ", description: " Reads orders. " })
    ).toEqual({
      ...config,
      displayName: "New",
      description: "Reads orders."
    });
    expect(withConnectionAbout(config, { title: "New", description: "  " })).toEqual({
      name: "x",
      displayName: "New",
      connectorType: "mcp"
    });
  });

  it("saves a changed name and description from the page through the existing save", async () => {
    const asset = connectionAsset("sample-business", { origin: "runtime", operations: OPERATIONS });
    const { page, puts } = await openPage(asset);
    const about = page.querySelector("[data-connection-about]");
    expect(about?.textContent).toContain("Sample business");
    expect(about?.textContent).toContain("Revenue, customers and orders of the sample business.");
    const edit = page.querySelector<HTMLButtonElement>("[data-connection-about-edit]");
    expect(edit?.textContent).toBe("Edit name and description");
    await act(async () => edit?.click());
    const title = page.querySelector<HTMLInputElement>(
      '[data-connection-about-form] [data-connection-field="title"]'
    );
    const description = page.querySelector<HTMLTextAreaElement>(
      '[data-connection-about-form] [data-connection-field="description"]'
    );
    await act(async () => {
      setValue(title, "  ");
    });
    // Without a name nothing is saved.
    const save = () => page.querySelector<HTMLButtonElement>("[data-connection-about-save]");
    expect(save()?.disabled).toBe(true);
    expect(page.textContent).toContain("Enter a name.");
    await act(async () => {
      setValue(title, "Sales ledger");
      setValue(description, "Invoices and payments of the sales team.");
    });
    expect(save()?.disabled).toBe(false);
    await act(async () =>
      page.querySelector<HTMLFormElement>("[data-connection-about-form]")?.requestSubmit()
    );
    await vi.waitFor(() => expect(puts).toHaveLength(1), WAIT);
    expect(puts[0]).toEqual({
      ...asset.config,
      displayName: "Sales ledger",
      description: "Invoices and payments of the sales team."
    });
    // Saved, the page shows the name and description again, with nothing left to save.
    await vi.waitFor(
      () => expect(page.querySelector("[data-connection-about-form]")).toBeNull(),
      WAIT
    );
  });

  it("asks a new Connection what it is for, and writes what was typed", () => {
    const config = newConnectionConfig(
      { name: "ledger", title: "Ledger", description: "  Reads the ledger.  " },
      emptyConnectionForm("http_api")
    );
    expect(config.description).toBe("Reads the ledger.");
    expect(
      "description" in
        newConnectionConfig(
          { name: "ledger", title: "Ledger", description: " " },
          emptyConnectionForm()
        )
    ).toBe(false);
  });

  it("keeps a copied description only where the person was not asked, and never one they cleared", () => {
    const copyOf = { name: "old", description: "Reads the old ledger." };
    const start = { name: "ledger", title: "Ledger", copyOf };
    expect(newConnectionConfig(start, emptyConnectionForm()).description).toBe(
      "Reads the old ledger."
    );
    expect(
      "description" in newConnectionConfig({ ...start, description: "" }, emptyConnectionForm())
    ).toBe(false);
    expect(
      newConnectionConfig({ ...start, description: " New text " }, emptyConnectionForm())
        .description
    ).toBe("New text");
  });
});

describe("Cancel in the name and description form", () => {
  async function typedForm() {
    const asset = connectionAsset("sample-business", { origin: "runtime", operations: OPERATIONS });
    const { page, puts } = await openPage(asset);
    await act(async () =>
      page.querySelector<HTMLButtonElement>("[data-connection-about-edit]")?.click()
    );
    const cancel = () => page.querySelector<HTMLButtonElement>("[data-connection-about-cancel]");
    const title = () =>
      page.querySelector<HTMLInputElement>(
        '[data-connection-about-form] [data-connection-field="title"]'
      );
    return { page, puts, cancel, title };
  }
  const dialogButton = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("dialog[open] button")].find(
      (button) => button.textContent?.trim() === text
    );

  it("closes at once where nothing was typed", async () => {
    const { page, cancel } = await typedForm();
    await act(async () => cancel()?.click());
    expect(document.querySelector("dialog[open]")).toBeNull();
    expect(page.querySelector("[data-connection-about-form]")).toBeNull();
  });

  it("asks before it drops what was typed, and keeps it on Cancel", async () => {
    const { page, puts, cancel, title } = await typedForm();
    await act(async () => setValue(title(), "Sales ledger"));
    await act(async () => cancel()?.click());
    await vi.waitFor(
      () =>
        expect(document.querySelector("dialog[open]")?.textContent).toContain(
          "Leave without saving?"
        ),
      WAIT
    );
    // Cancel in the question keeps the form and what was typed.
    await act(async () => dialogButton("Cancel")?.click());
    await vi.waitFor(() => expect(document.querySelector("dialog[open]")).toBeNull(), WAIT);
    expect(title()?.value).toBe("Sales ledger");
    // Asked again and confirmed, the form closes and nothing is saved.
    await act(async () => cancel()?.click());
    await vi.waitFor(() => expect(dialogButton("Discard changes")).toBeDefined(), WAIT);
    await act(async () => dialogButton("Discard changes")?.click());
    await vi.waitFor(
      () => expect(page.querySelector("[data-connection-about-form]")).toBeNull(),
      WAIT
    );
    expect(page.querySelector("[data-connection-about]")?.textContent).toContain("Sample business");
    expect(puts).toEqual([]);
  });
});

describe("Used by (CONN-PAGE 4)", () => {
  it("names the Apps, Workflows and Knowledge Bases beside the agents, by title and kind", async () => {
    const asset = connectionAsset("sample-business", { origin: "runtime", operations: OPERATIONS });
    const { page } = await openPage(asset, {
      usedByAssets: [
        { kind: "app", name: "orders_board", title: "Orders board" },
        { kind: "workflow", name: "nightly_sync", title: "Nightly sync" },
        { kind: "knowledge_base", name: "sales_docs", title: "Sales documents" }
      ],
      usedByAssetsTruncated: true
    });
    await vi.waitFor(
      () => expect(page.querySelectorAll("[data-connection-used-by]")).toHaveLength(5),
      WAIT
    );
    const rows = [...page.querySelectorAll("[data-connection-used-by]")].map((row) => [
      row.getAttribute("data-connection-used-by"),
      row.textContent
    ]);
    expect(rows.slice(2)).toEqual([
      ["app", expect.stringContaining("Orders board")],
      ["workflow", expect.stringContaining("Nightly sync")],
      ["knowledge_base", expect.stringContaining("Sales documents")]
    ]);
    expect(rows[2]?.[1]).toContain("App");
    expect(rows[3]?.[1]).toContain("Workflow");
    expect(rows[4]?.[1]).toContain("Knowledge base");
    // No id stands in a row.
    for (const id of ["orders_board", "nightly_sync", "sales_docs", "workflow_assistant"]) {
      expect(
        [...page.querySelectorAll("[data-connection-used-by]")].some((row) =>
          row.textContent?.includes(id)
        ),
        id
      ).toBe(false);
    }
    // A Knowledge Base opens its page in Build.
    expect(
      page.querySelector('[data-connection-used-by="knowledge_base"] a')?.getAttribute("href")
    ).toBe("/build/knowledge-bases/sales_docs");
    expect(page.querySelector("[data-connection-used-by-truncated]")).not.toBeNull();
    // The section counts what it lists.
    expect(page.querySelector("#agents")?.textContent).toContain("5");
  });

  it("says nothing the reader can see uses the Connection, never that nothing uses it", async () => {
    const asset = connectionAsset("sample-business", { origin: "runtime", operations: OPERATIONS });
    const { page } = await openPage(asset, { usedBy: [], usedByAssets: [] });
    await vi.waitFor(
      () => expect(page.textContent).toContain("Nothing you can see uses this connection."),
      WAIT
    );
  });

  it("keeps the incomplete-list note where a bounded scan listed nothing", async () => {
    const asset = connectionAsset("sample-business", { origin: "runtime", operations: OPERATIONS });
    const { page } = await openPage(asset, {
      usedBy: [],
      usedByAssets: [],
      usedByAssetsTruncated: true
    });
    await vi.waitFor(
      () => expect(page.querySelector("[data-connection-used-by-truncated]")).not.toBeNull(),
      WAIT
    );
    expect(page.textContent).toContain(
      "Nothing could be listed, but the search stopped early. Something may still use this connection."
    );
    expect(page.textContent).not.toContain("Nothing you can see uses this connection.");
  });

  it("opens no Build page in the wrong scope for a workspace's assets, and keys each row apart", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const asset = connectionAsset("sample-business", { origin: "runtime", operations: OPERATIONS });
    const { page } = await openPage(asset, {
      usedBy: [],
      usedByAssets: [
        { kind: "knowledge_base", name: "sales_docs", title: "Sales documents" },
        {
          kind: "knowledge_base",
          workspaceId: "ws_north",
          name: "sales_docs",
          title: "North sales documents"
        },
        { kind: "knowledge_base", workspaceId: "ws_south", name: "sales_docs", title: "South docs" }
      ]
    });
    await vi.waitFor(
      () => expect(page.querySelectorAll("[data-connection-used-by]")).toHaveLength(3),
      WAIT
    );
    const rows = [...page.querySelectorAll('[data-connection-used-by="knowledge_base"]')];
    expect(rows.map((row) => row.querySelector("a")?.getAttribute("href") ?? null)).toEqual([
      "/build/knowledge-bases/sales_docs",
      null,
      null
    ]);
    expect(rows[1]?.textContent).toContain("North sales documents");
    expect(
      errors.mock.calls.some((call) => String(call[0]).includes("same key")),
      "React saw two rows with one key"
    ).toBe(false);
    errors.mockRestore();
  });
});

describe("The health in the list (CONN-PAGE 6)", () => {
  const kind = buildAssetKinds.find((entry) => entry.kind === "connection");
  const row = (attributes: Record<string, string | boolean>) =>
    renderToStaticMarkup(
      kind?.badges?.(
        {
          id: "asset_sales",
          kind: "connection",
          name: "sales",
          title: "Sales",
          scope: { kind: "instance" },
          revision: 1,
          updatedAt: "2026-10-18T10:00:00.000Z",
          attributes
        },
        createTranslationContext("en").t
      )
    );

  it("maps every health the instance names to the words of the page", () => {
    expect(listedHealth("ok")).toBe("ready");
    expect(listedHealth("failed")).toBe("failed");
    expect(listedHealth("needs_configuration")).toBe("not_configured");
    expect(listedHealth("secret_unreadable")).toBe("secret_unreadable");
    expect(listedHealth("unknown")).toBe("never_tested");
    expect(listedHealth("constructor")).toBeUndefined();
    expect(listedHealth(undefined)).toBeUndefined();
  });

  it("shows the health of an enabled Connection, and Disabled for one that is off", () => {
    expect(row({ connectorType: "mcp", enabled: true, health: "failed" })).toContain(">Failed<");
    expect(row({ connectorType: "mcp", enabled: true, health: "unknown" })).toContain(
      'data-connection-list-health="never_tested"'
    );
    expect(row({ connectorType: "mcp", enabled: false, health: "ok" })).toContain(">Disabled<");
    // An instance that names no health shows that the Connection is on, as before.
    expect(row({ connectorType: "mcp", enabled: true })).toContain(">Enabled<");
    const german = renderToStaticMarkup(
      kind?.badges?.(
        {
          id: "asset_sales",
          kind: "connection",
          name: "sales",
          title: "Sales",
          scope: { kind: "instance" },
          revision: 1,
          updatedAt: "2026-10-18T10:00:00.000Z",
          attributes: { enabled: true, health: "ok" }
        },
        createTranslationContext("de").t
      )
    );
    expect(german).toContain(">Bereit<");
  });
});

describe("A declaration over the bound of Technical details", () => {
  it("says it was cut, and shows a declaration within the bound whole", async () => {
    const asset = connectionAsset("sample-business", { origin: "runtime", operations: OPERATIONS });
    const huge = {
      type: "object",
      properties: { note: { type: "string", description: "x".repeat(RAW_MAX_CHARS + 10) } }
    };
    const whole = {
      type: "object",
      properties: { note: { type: "string", description: "y".repeat(20_000) } }
    };
    const base = connectionDetail(asset.name);
    const [first, second] = base.operations;
    if (!first || !second) throw new Error("The fixture has two operations");
    const { page } = await openPage(asset, {
      operations: [
        { ...first, inputSchema: huge },
        { ...second, inputSchema: whole }
      ]
    });
    const open = async (name: string) => {
      const declaration = page.querySelector(`[data-connection-declaration="${name}"]`);
      await act(async () => declaration?.querySelector<HTMLButtonElement>("button")?.click());
      return declaration;
    };
    const cut = await open("revenue_by_month");
    await vi.waitFor(
      () => expect(cut?.querySelector("[data-connection-declaration-cut]")).not.toBeNull(),
      WAIT
    );
    expect(cut?.textContent).toContain("this is not the whole declaration");
    const shown = await open("list_customers");
    await vi.waitFor(() => expect(shown?.textContent).toContain("y".repeat(100)), WAIT);
    expect(shown?.querySelector("[data-connection-declaration-cut]")).toBeNull();
  });
});
