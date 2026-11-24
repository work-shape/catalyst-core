// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ConnectionDetail } from "@work-shape/catalyst-api-client";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { connectorTypeOffers } from "@work-shape/catalyst-connections";
import { createConnectorTypeRegistry } from "@work-shape/catalyst-core";
import { createImapConnectorType } from "@work-shape/catalyst-imap-connector";
import {
  ConnectionCreateFlow,
  type BuildAsset,
  type BuildExistingAsset,
  type ConnectionSource
} from "@work-shape/catalyst-chat-ui/build-area";
import { SettingsPageProvider } from "@work-shape/catalyst-chat-ui/settings-page-context";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { platformContext } from "./chat-ui-build-fixtures";
import { buildPageSettings, mountBuildPage, unmountBuildPages } from "./chat-ui-build-page-harness";
import { connectionAsset, connectionDetail } from "./chat-ui-connection-fixtures";
import { TranslationProvider } from "./chat-ui-render-harness";
import { settingsUser } from "./chat-ui-settings-fixtures";
import { CONDITION_WAIT_MS, required } from "./support/assertions";

const WAIT = { timeout: CONDITION_WAIT_MS };

// The Connection page against an instance whose answers the test gives: what a writer changes
// is saved through the page's save, "Used by" links only what it may, and a person who holds a
// right on this one Connection only (RIGHTS-1d) gets the writes exactly as far as that right.

afterEach(async () => {
  await unmountBuildPages();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const OPERATIONS = [
  { name: "revenue_by_month", effect: "reading", exposure: ["agent"], enabled: true },
  { name: "list_customers", effect: "reading", exposure: ["agent", "workflow"], enabled: true }
];

const runtime = (name = "sample-business", config: Record<string, unknown> = {}) =>
  connectionAsset(name, { origin: "runtime", operations: OPERATIONS, ...config });

const rest = () =>
  runtime("exampledata", {
    connectorType: "http_api",
    settings: { baseUrl: "https://gateway.example.test/api" }
  });

/**
 * The page of a Connection. By default read by an admin who holds connection.write on the
 * kind; `plain` reads it as a user who holds nothing on the kind. Keeps every save and counts
 * the requests for the connector types.
 */
async function openPage(asset: BuildAsset, detail: Partial<ConnectionDetail> = {}, plain = false) {
  const puts: Record<string, unknown>[] = [];
  const asked = { connectorTypes: 0 };
  const detailPath = apiOperations["connections.get"].path.replace(":name", asset.name);
  const page = await mountBuildPage(
    asset,
    "connections",
    (request, url) => {
      if (url.pathname === apiOperations["platform.context.get"].path) {
        return Response.json(plain ? platformContext() : platformContext([], ["connection.write"]));
      }
      if (url.pathname === apiOperations["connections.connector_types"].path) {
        asked.connectorTypes += 1;
        return Response.json({ items: [] });
      }
      if (request.method === "GET" && url.pathname === detailPath) {
        return Response.json(connectionDetail(asset.name, detail));
      }
      return undefined;
    },
    [],
    {
      ...(plain ? {} : { user: settingsUser({ roles: ["user", "admin"] }) }),
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
  return { page, puts, asked };
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element?.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("A writer on the Connection page", () => {
  it("saves an operation switched off and keeps the rest of the definition", async () => {
    const asset = runtime();
    const { page, puts } = await openPage(asset);
    await act(async () =>
      page.querySelector<HTMLButtonElement>('[data-connection-enabled="revenue_by_month"]')?.click()
    );
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
  });

  it("saves a changed name and description, and never without a name", async () => {
    const asset = runtime();
    const { page, puts } = await openPage(asset);
    await act(async () =>
      page.querySelector<HTMLButtonElement>("[data-connection-about-edit]")?.click()
    );
    const field = (name: string) =>
      page.querySelector<HTMLInputElement>(
        `[data-connection-about-form] [data-connection-field="${name}"]`
      );
    const save = () => page.querySelector<HTMLButtonElement>("[data-connection-about-save]");
    await act(async () => setValue(field("title"), "  "));
    expect(save()?.disabled).toBe(true);
    await act(async () => {
      setValue(field("title"), "Sales ledger");
      setValue(field("description"), "Invoices and payments of the sales team.");
    });
    await act(async () =>
      page.querySelector<HTMLFormElement>("[data-connection-about-form]")?.requestSubmit()
    );
    await vi.waitFor(() => expect(puts).toHaveLength(1), WAIT);
    expect(puts[0]).toEqual({
      ...asset.config,
      displayName: "Sales ledger",
      description: "Invoices and payments of the sales team."
    });
    await vi.waitFor(
      () => expect(page.querySelector("[data-connection-about-form]")).toBeNull(),
      WAIT
    );
  });

  it("asks before Cancel drops what was typed, keeps it on Cancel, and saves nothing on Discard", async () => {
    const { page, puts } = await openPage(runtime());
    await act(async () =>
      page.querySelector<HTMLButtonElement>("[data-connection-about-edit]")?.click()
    );
    const cancel = () => page.querySelector<HTMLButtonElement>("[data-connection-about-cancel]");
    const title = () =>
      page.querySelector<HTMLInputElement>(
        '[data-connection-about-form] [data-connection-field="title"]'
      );
    const dialogButton = (text: string) =>
      [...document.querySelectorAll<HTMLButtonElement>("dialog[open] button")].find(
        (button) => button.textContent?.trim() === text
      );
    await act(async () => setValue(title(), "Sales ledger"));
    await act(async () => cancel()?.click());
    await vi.waitFor(() => expect(dialogButton("Cancel")).toBeDefined(), WAIT);
    await act(async () => dialogButton("Cancel")?.click());
    await vi.waitFor(() => expect(document.querySelector("dialog[open]")).toBeNull(), WAIT);
    expect(title()?.value).toBe("Sales ledger");
    await act(async () => cancel()?.click());
    await vi.waitFor(() => expect(dialogButton("Discard changes")).toBeDefined(), WAIT);
    await act(async () => dialogButton("Discard changes")?.click());
    await vi.waitFor(
      () => expect(page.querySelector("[data-connection-about-form]")).toBeNull(),
      WAIT
    );
    expect(puts).toEqual([]);
  });
});

describe("Used by (CONN-PAGE 4)", () => {
  it("lists Apps, Workflows and Knowledge Bases beside the agents, and says when the list stopped early", async () => {
    const { page } = await openPage(runtime(), {
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
    expect(
      [...page.querySelectorAll("[data-connection-used-by]")]
        .slice(2)
        .map((row) => row.getAttribute("data-connection-used-by"))
    ).toEqual(["app", "workflow", "knowledge_base"]);
    expect(
      page.querySelector('[data-connection-used-by="knowledge_base"] a')?.getAttribute("href")
    ).toBe("/build/knowledge-bases/sales_docs");
    expect(page.querySelector("[data-connection-used-by-truncated]")).not.toBeNull();
  });

  it("never says nothing uses it where a bounded scan listed nothing", async () => {
    const { page } = await openPage(runtime(), {
      usedBy: [],
      usedByAssets: [],
      usedByAssetsTruncated: true
    });
    await vi.waitFor(
      () => expect(page.querySelector("[data-connection-used-by-truncated]")).not.toBeNull(),
      WAIT
    );
    expect(page.textContent).not.toContain("Nothing you can see uses this connection.");
  });

  it("opens no Build page in the wrong scope for a workspace's assets, and keys each row apart", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { page } = await openPage(runtime(), {
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
    expect(
      [...page.querySelectorAll('[data-connection-used-by="knowledge_base"]')].map(
        (row) => row.querySelector("a")?.getAttribute("href") ?? null
      )
    ).toEqual(["/build/knowledge-bases/sales_docs", null, null]);
    expect(
      errors.mock.calls.some((call) => String(call[0]).includes("same key")),
      "React saw two rows with one key"
    ).toBe(false);
    errors.mockRestore();
  });
});

// RIGHTS-1d: write on one Connection and nothing on the kind; the page asks the asset's `allowed`.
describe("A person with a right on this Connection only", () => {
  it("who may write it gets the switches and boxes, and the connector types are read", async () => {
    const { page, puts, asked } = await openPage(
      { ...runtime(), allowed: ["read", "write"] },
      {},
      true
    );
    expect(page.querySelector("[data-build-read-only]")).toBeNull();
    expect(page.querySelector('[data-connection-exposure="bridge:list_customers"]')).not.toBeNull();
    expect(page.querySelector('[data-connection-outside="list_customers"]')).not.toBeNull();
    await vi.waitFor(() => expect(asked.connectorTypes).toBeGreaterThan(0), WAIT);
    await act(async () =>
      page.querySelector<HTMLButtonElement>('[data-connection-enabled="revenue_by_month"]')?.click()
    );
    await vi.waitFor(() => expect(puts).toHaveLength(1), WAIT);
  });

  it("who may write a REST API approves pasted tools through the approval list", async () => {
    const { page, puts } = await openPage({ ...rest(), allowed: ["read", "write"] }, {}, true);
    await vi.waitFor(
      () => expect(page.querySelector("[data-connection-paste]")).not.toBeNull(),
      WAIT
    );
    // A REST API's writer has the switches the reader below lacks.
    expect(page.querySelector('[data-connection-enabled="revenue_by_month"]')).not.toBeNull();
    await act(async () =>
      page.querySelector<HTMLButtonElement>("[data-connection-paste] button")?.click()
    );
    const field = document.querySelector<HTMLTextAreaElement>(
      "[data-connection-paste-field] textarea, textarea[data-connection-paste-field]"
    );
    if (!field) throw new Error("The paste field is open");
    await act(async () =>
      setValue(field, ["- name: list_clients", "  method: GET", "  path: /clients"].join("\n"))
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-connection-paste-check]")?.click()
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-connection-approve]")?.click()
    );
    await vi.waitFor(() => expect(puts).toHaveLength(1), WAIT);
  });

  it("who may only read it gets no switch, box, paste or approval, and no connector types are read", async () => {
    const { page, asked } = await openPage({ ...rest(), allowed: ["read"] }, {}, true);
    for (const control of [
      "[data-connection-enabled]",
      "[data-connection-remove]",
      "[data-connection-exposure]",
      "[data-connection-outside]",
      "[data-connection-paste]",
      "[data-connection-approval]"
    ]) {
      expect(page.querySelector(control), control).toBeNull();
    }
    // Give the page a moment: a request it would send has been sent by now.
    await act(async () => new Promise((done) => setTimeout(done, 50)));
    expect(asked.connectorTypes).toBe(0);
  });
});

describe("The New connection dialog", () => {
  // The New connection dialog clicked through. T35: a failed connect left a Connection behind
  // that holds its id; the dialog names it and offers to open it, connect it again or replace
  // it, as far as the reader may. A refused connect shows the instance's sentence only to a
  // reader who may see it. MBX-1b: the IMAP card keeps the password out of every definition and
  // approves its reading tools for agents alone.

  let root: Root | undefined;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = undefined;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  /** The half-saved MCP server of an earlier attempt: no tool accepted, a sign-in it never got. */
  const HALF_SAVED: Record<string, unknown> = {
    name: "workmail",
    displayName: "Work Mail",
    connectorType: "mcp",
    origin: "runtime",
    authScheme: "bearer",
    settings: { url: "https://mail.example.test/mcp" },
    operations: [],
    enabled: true
  };

  function holder(overrides: Partial<BuildExistingAsset> = {}): BuildExistingAsset {
    return {
      name: "workmail",
      config: HALF_SAVED,
      revision: 4,
      mayWrite: true,
      mayDelete: true,
      ...overrides
    };
  }

  function source(overrides: Partial<ConnectionSource> = {}): ConnectionSource {
    return {
      mayTest: () => true,
      useDetail: () => ({ status: "loading" }),
      readDetail: async () => connectionDetail("workmail", { discoveredAt: undefined }),
      test: async () => ({ status: "ready", testedAt: "2026-10-30T10:00:00.000Z" }),
      setSecret: async () => undefined,
      discover: async () => undefined,
      useTest: () => ({ run: { status: "idle" }, start: () => undefined }),
      useHolders: () => ({ status: "hidden" }),
      principalHref: () => "",
      oauthStart: async () => {
        throw new Error("This test signs nothing in.");
      },
      ...overrides
    };
  }

  /** Types into a field as React hears it. */
  async function type(field: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function button(text: string, within: ParentNode = document): HTMLButtonElement {
    return required(
      [...within.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === text
      )
    );
  }

  async function mount(element: ReactElement) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        createElement(
          UiRoot,
          { mode: "light", labels: uiLabelsEn },
          createElement(TranslationProvider, { locale: "de", children: null }, element)
        )
      )
    );
  }

  /** Opens "MCP-Server verbinden" and types the name and address of the new Connection. */
  async function fillMcpServer(name = "Workmail") {
    await act(async () =>
      required(document.querySelector<HTMLElement>('[data-connection-type="mcp"] button')).click()
    );
    await type(
      required(document.querySelector<HTMLInputElement>('[data-name-with-address-field="name"]')),
      name
    );
    await type(
      required(document.querySelector<HTMLInputElement>('[data-connection-field="url"]')),
      "https://mail.example.test/mcp"
    );
  }

  /** The sentence at the id field. */
  function idError(): string {
    const id = required(
      document.querySelector<HTMLInputElement>('[data-name-with-address-field="address"]')
    );
    return (id.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((ref) => document.getElementById(ref)?.textContent ?? "")
      .join(" ");
  }

  function connectButton(): HTMLButtonElement {
    return required(document.querySelector<HTMLButtonElement>("[data-connection-connect]"));
  }

  /** The dialog over a taken id, recording what it writes, deletes and opens. */
  async function openTaken(
    found: BuildExistingAsset | undefined,
    flow: Partial<ConnectionSource> = {}
  ) {
    const record = {
      puts: [] as {
        name: string;
        config: Record<string, unknown>;
        expectedRevision: number | null;
      }[],
      removed: [] as { name: string; expectedRevision: number }[],
      opened: [] as string[],
      order: [] as string[],
      read: [] as string[]
    };
    let freed = false;
    await mount(
      createElement(ConnectionCreateFlow, {
        source: source(flow),
        checkName: async () =>
          freed
            ? { available: true as const }
            : {
                available: false as const,
                reason: "name_taken" as const,
                message: "The connection id 'workmail' is taken on this instance"
              },
        existing: async (name) => {
          record.read.push(name);
          return found;
        },
        put: async (input) => {
          record.puts.push(input);
          record.order.push("put");
          return { revision: (input.expectedRevision ?? 0) + 1 };
        },
        remove: async (input) => {
          freed = true;
          record.removed.push(input);
          record.order.push("remove");
        },
        mayDelete: () => true,
        onClose: () => undefined,
        onCreated: (name) => record.opened.push(name)
      })
    );
    await fillMcpServer();
    return record;
  }

  describe("A new Connection whose id an earlier one holds (T35)", () => {
    it("names the Connection that holds it and keeps Connect off", async () => {
      await openTaken(holder());
      await vi.waitFor(
        () => expect(document.querySelector("[data-connection-id-taken]")).not.toBeNull(),
        WAIT
      );
      expect(idError()).toContain("Work Mail");
      expect(connectButton().disabled).toBe(true);
    });

    it("opens the Connection that holds it", async () => {
      const record = await openTaken(holder());
      const open = await vi.waitFor(
        () => required(document.querySelector<HTMLButtonElement>("[data-connection-taken-open]")),
        WAIT
      );
      await act(async () => open.click());
      expect(record.opened).toEqual(["workmail"]);
      expect(record.puts).toEqual([]);
    });

    it("connects it again as it is stored, over its revision", async () => {
      const tested: string[] = [];
      const record = await openTaken(holder(), {
        test: async (name) => {
          tested.push(name);
          return { status: "unavailable", testedAt: "2026-10-30T10:00:00.000Z" };
        }
      });
      const reconnect = await vi.waitFor(
        () =>
          required(document.querySelector<HTMLButtonElement>("[data-connection-taken-reconnect]")),
        WAIT
      );
      await act(async () => reconnect.click());
      await vi.waitFor(() => expect(tested).toEqual(["workmail"]), WAIT);
      expect(record.puts).toEqual([{ name: "workmail", config: HALF_SAVED, expectedRevision: 4 }]);
      expect(record.removed).toEqual([]);
      await vi.waitFor(
        () => expect(document.querySelector("[data-connection-create-saved]")).not.toBeNull(),
        WAIT
      );
    });

    it("replaces it after asking: deletes it at its revision, then connects this one", async () => {
      const record = await openTaken(holder());
      const replace = await vi.waitFor(
        () =>
          required(document.querySelector<HTMLButtonElement>("[data-connection-taken-replace]")),
        WAIT
      );
      await act(async () => replace.click());
      const ask = await vi.waitFor(
        () =>
          required(
            [...document.querySelectorAll<HTMLElement>('[role="alertdialog"], dialog[open]')].find(
              (dialog) => dialog.textContent?.includes("„Work Mail“ ersetzen?")
            )
          ),
        WAIT
      );
      expect(record.removed).toEqual([]);
      await act(async () => button("Ersetzen", ask).click());
      await vi.waitFor(() => expect(record.order).toEqual(["remove", "put"]), WAIT);
      expect(record.removed).toEqual([{ name: "workmail", expectedRevision: 4 }]);
      expect(record.puts[0]?.expectedRevision).toBeNull();
      expect(record.puts[0]?.config.displayName).toBe("Workmail");
    });

    it("offers only what the reader may do with it", async () => {
      await openTaken(holder({ mayWrite: false, mayDelete: false }));
      await vi.waitFor(
        () => expect(document.querySelector("[data-connection-id-taken]")).not.toBeNull(),
        WAIT
      );
      expect(document.querySelector("[data-connection-taken-open]")).not.toBeNull();
      expect(document.querySelector("[data-connection-taken-reconnect]")).toBeNull();
      expect(document.querySelector("[data-connection-taken-replace]")).toBeNull();
    });

    it("names no holder the reader may not read, and keeps Connect off", async () => {
      await openTaken(undefined);
      await vi.waitFor(() => expect(idError()).toContain("workmail"), WAIT);
      expect(document.querySelector("[data-connection-id-taken]")).toBeNull();
      expect(connectButton().disabled).toBe(true);
    });

    it("takes an id only a deleted Connection held, without reading it", async () => {
      const history: string[] = [];
      const record = await openTaken(undefined, {
        deletedRevision: async (name) => {
          history.push(name);
          return 6;
        }
      });
      await vi.waitFor(() => expect(history).toContain("workmail"), WAIT);
      await vi.waitFor(() => expect(connectButton().disabled).toBe(false), WAIT);
      // The deleted Connection is not read: the instance would answer 404 for it.
      expect(record.read).toEqual([]);
    });
  });

  /** An answer of the instance that refuses the connect's test with `reason` and its sentence. */
  function refusedTest(reason: string, message: string): ApiError {
    return new ApiError(403, message, {
      error: { code: "FORBIDDEN", message, details: { reason } }
    });
  }

  function platformFor(systemView: boolean): typeof fetch {
    return async (input, init) => {
      const url = new URL(new Request(input, init).url);
      return url.pathname === apiOperations["platform.context.get"].path
        ? Response.json({
            ...platformContext(),
            instanceActions: systemView ? ["system.view"] : []
          })
        : Response.json({ error: { code: "NOT_FOUND", message: "none" } }, { status: 404 });
    };
  }

  /** Connects a new MCP server whose test the instance refuses with `error`. */
  async function connectRefused(error: ApiError, systemView: boolean) {
    const flow = createElement(ConnectionCreateFlow, {
      source: source({
        test: async () => {
          throw error;
        }
      }),
      checkName: async () => ({ available: true as const }),
      put: async () => ({ revision: 1 }),
      remove: async () => undefined,
      mayDelete: () => true,
      onClose: () => undefined,
      onCreated: () => undefined
    });
    await mount(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        createElement(
          SettingsPageProvider,
          { value: buildPageSettings(platformFor(systemView), settingsUser()) },
          flow
        )
      )
    );
    await fillMcpServer();
    await vi.waitFor(() => expect(connectButton().disabled).toBe(false), WAIT);
    await act(async () => connectButton().click());
    await vi.waitFor(
      () => expect(document.querySelector("[data-connection-create-error]")).not.toBeNull(),
      WAIT
    );
  }

  describe("A refused connect", () => {
    it("says a reason the page knows, never the instance's sentence", async () => {
      await connectRefused(
        refusedTest(
          "personal_connection_context",
          "personal_connection_context: A personal connection cannot run here"
        ),
        false
      );
      expect(document.body.textContent).not.toContain("cannot run here");
      expect(document.querySelector("[data-refusal-reason-who]")).toBeNull();
    });

    it("shows an unknown reason only to a reader who may see it, and the others who does", async () => {
      await connectRefused(refusedTest("unknown_reason", "something the page cannot say"), false);
      await vi.waitFor(
        () => expect(document.querySelector("[data-refusal-reason-who]")).not.toBeNull(),
        WAIT
      );
      expect(document.body.textContent).not.toContain("something the page cannot say");
      expect(document.querySelector("[data-refusal-detail]")).toBeNull();
    });

    it("shows the reason to a reader who may see it", async () => {
      await connectRefused(refusedTest("unknown_reason", "something the page cannot say"), true);
      await vi.waitFor(
        () => expect(document.body.textContent).toContain("something the page cannot say"),
        WAIT
      );
      expect(document.querySelector("[data-refusal-reason-who]")).toBeNull();
    });
  });

  describe("The card Postfach (IMAP) (MBX-1b)", () => {
    const PASSWORD = "mailbox-app-password-never-shown-5";

    it("connects, tests and approves the reading tools for agents only, the password never in a definition", async () => {
      const imap = required(
        connectorTypeOffers(createConnectorTypeRegistry([createImapConnectorType()])).types[0]
      );
      const log: string[] = [];
      const puts: Record<string, unknown>[] = [];
      const created = vi.fn();
      await mount(
        createElement(ConnectionCreateFlow, {
          source: source({
            readDetail: async () => connectionDetail("feedback-mailbox"),
            test: async () => {
              log.push("connections.test");
              return { status: "ready", testedAt: "2026-11-10T10:00:00.000Z" };
            },
            setSecret: async (_name, value) => {
              log.push(`connections.set_secret(${value === PASSWORD ? "password" : "?"})`);
            },
            discover: async () => {
              log.push("connections.discover");
            },
            useConnectorTypes: () => [imap]
          }),
          checkName: async () => ({ available: true as const }),
          put: async (input) => {
            log.push(`assets.put(${input.expectedRevision ?? "null"})`);
            puts.push(input.config);
            return { revision: puts.length };
          },
          remove: async () => undefined,
          mayDelete: () => true,
          onClose: () => undefined,
          onCreated: created
        })
      );
      const field = (selector: string) =>
        required(document.querySelector<HTMLInputElement>(selector));
      const click = async (selector: string) => {
        await act(async () => required(document.querySelector<HTMLElement>(selector)).click());
        await vi.waitFor(() => undefined, WAIT);
      };
      await click('[data-connection-type="imap"] button');
      await click("[data-name-with-address-fold]");
      expect(field('[data-connection-field="secret"]').getAttribute("type")).toBe("password");
      await type(field('[data-name-with-address-field="name"]'), "Feedback mailbox");
      await type(field('[data-connection-field="host"]'), "imap.example.test");
      await type(field('[data-connection-field="username"]'), "feedback@example.test");
      await type(field('[data-connection-field="secret"]'), PASSWORD);
      await type(field('[data-connection-field="folders"]'), "INBOX, Feedback");
      await click("[data-connection-connect]");

      // Saved, the password set apart, tested; nothing is discovered.
      await vi.waitFor(
        () =>
          expect(log).toEqual([
            "assets.put(null)",
            "connections.set_secret(password)",
            "connections.test"
          ]),
        WAIT
      );
      expect(puts[0]).toMatchObject({
        name: "feedback-mailbox",
        connectorType: "imap",
        settings: { folders: ["INBOX", "Feedback"], port: 993 }
      });
      await vi.waitFor(
        () => expect(document.querySelector("[data-connection-approve]")).not.toBeNull(),
        WAIT
      );
      expect(
        [...document.querySelectorAll("[data-approval-surface]")].map((node) =>
          node.getAttribute("data-approval-surface")
        )
      ).toEqual(["agent"]);
      await click("[data-connection-approve]");
      await vi.waitFor(() => expect(log.at(-1)).toBe("assets.put(1)"), WAIT);
      expect(required(puts[1]).operations).toEqual([
        expect.objectContaining({ name: "list_folders", effect: "reading", exposure: ["agent"] }),
        expect.objectContaining({
          name: "search_messages",
          effect: "reading",
          exposure: ["agent"]
        }),
        expect.objectContaining({ name: "get_message", effect: "reading", exposure: ["agent"] })
      ]);
      expect(JSON.stringify(puts)).not.toContain(PASSWORD);
      await click("[data-connection-who-uses-open]");
      expect(created).toHaveBeenCalledWith("feedback-mailbox", expect.any(Function));
    });
  });
});
