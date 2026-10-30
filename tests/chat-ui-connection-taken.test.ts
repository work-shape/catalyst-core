// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@work-shape/catalyst-api-client";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  buildAssetKinds,
  ConnectionCreateFlow,
  isEditableKind,
  type BuildAssetRow,
  type BuildExistingAsset,
  type ConnectionSource
} from "@work-shape/catalyst-chat-ui/build-area";
import { SettingsPageProvider } from "@work-shape/catalyst-chat-ui/settings-page-context";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { platformContext } from "./chat-ui-build-fixtures";
import { buildPageSettings } from "./chat-ui-build-page-harness";
import { connectionDetail } from "./chat-ui-connection-fixtures";
import { TranslationProvider } from "./chat-ui-render-harness";
import { settingsUser } from "./chat-ui-settings-fixtures";
import { createTranslationContext } from "./support/chat-ui/shared";
import { CONDITION_WAIT_MS, required } from "./support/assertions";

// T35: a failed connect left a Connection behind that holds its id, and the New connection
// dialog said only that "this address" was taken, with Connect greyed out. It now names the
// id and the Connection that holds it, and offers to open it, connect it again or replace it,
// as far as the reader may. The list marks such a Connection as incomplete and offers its
// delete in place. A refused connect says why in German where the page knows the reason, and
// otherwise who reads the instance's sentence and where.

const WAIT = { timeout: CONDITION_WAIT_MS };

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
    order: [] as string[]
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
      existing: async () => found,
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

describe("A new Connection whose id an earlier one holds", () => {
  it("names the id and the Connection, not an address, and keeps Connect off", async () => {
    await openTaken(holder());
    await vi.waitFor(
      () => expect(document.querySelector("[data-connection-id-taken]")).not.toBeNull(),
      WAIT
    );
    expect(idError()).toContain("Die Id workmail gehört schon der Verbindung „Work Mail“.");
    expect(document.body.textContent).not.toContain("Adresse ist vergeben");
    const notice = required(document.querySelector<HTMLElement>("[data-connection-id-taken]"));
    expect(notice.textContent).toContain("„Work Mail“ hat diese Id schon");
    expect(notice.textContent).toContain("unvollständig: gespeichert, aber noch ohne Tools");
    expect(connectButton().disabled).toBe(true);
  });

  it("opens the Connection that holds it", async () => {
    const record = await openTaken(holder());
    await vi.waitFor(() => button("Öffnen"), WAIT);
    await act(async () => button("Öffnen").click());
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
    await vi.waitFor(() => button("Erneut verbinden"), WAIT);
    await act(async () => button("Erneut verbinden").click());
    await vi.waitFor(() => expect(tested).toEqual(["workmail"]), WAIT);
    // The stored definition is written as it is, over the revision the reader saw.
    expect(record.puts).toEqual([{ name: "workmail", config: HALF_SAVED, expectedRevision: 4 }]);
    expect(record.removed).toEqual([]);
    // The dialog now holds it as its own saved Connection, and says where to find it.
    await vi.waitFor(
      () => expect(document.querySelector("[data-connection-create-saved]")).not.toBeNull(),
      WAIT
    );
    expect(document.querySelector("[data-connection-id-taken]")).toBeNull();
    expect(document.querySelector("[data-connection-create-saved-open]")).not.toBeNull();
  });

  it("replaces it after asking: deletes it at its revision, then connects this one", async () => {
    const record = await openTaken(holder());
    const replace = await vi.waitFor(
      () => required(document.querySelector<HTMLButtonElement>("[data-connection-taken-replace]")),
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

  it("asks for another id where the reader may not read the Connection that holds it", async () => {
    await openTaken(undefined);
    await vi.waitFor(
      () => expect(idError()).toContain("Die Id workmail ist vergeben. Wähle eine andere Id."),
      WAIT
    );
    expect(document.querySelector("[data-connection-id-taken]")).toBeNull();
    expect(connectButton().disabled).toBe(true);
  });

  it("takes an id only a deleted Connection held: the connect writes over that delete", async () => {
    await openTaken(undefined, { deletedRevision: async () => 6 });
    await vi.waitFor(() => expect(connectButton().disabled).toBe(false), WAIT);
    expect(document.body.textContent).not.toContain("vergeben");
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
  it("says a reason the page knows in German, to everyone", async () => {
    await connectRefused(
      refusedTest(
        "personal_connection_context",
        "personal_connection_context: A personal connection cannot run here"
      ),
      false
    );
    const error = required(document.querySelector("[data-connection-create-error]"));
    expect(error.textContent).toContain("Eine persönliche Verbindung lässt sich hier nicht testen");
    expect(document.body.textContent).not.toContain("cannot run here");
    expect(document.querySelector("[data-refusal-reason-who]")).toBeNull();
  });

  it("tells a reader who may not see the instance's sentence who sees it, and where", async () => {
    await connectRefused(refusedTest("unknown_reason", "something the page cannot say"), false);
    await vi.waitFor(
      () => expect(document.querySelector("[data-refusal-reason-who]")).not.toBeNull(),
      WAIT
    );
    const who = required(document.querySelector("[data-refusal-reason-who]"));
    expect(who.textContent).toContain("Systemseiten ansehen");
    expect(who.textContent).toContain("„Technische Details“");
    expect(document.body.textContent).not.toContain("something the page cannot say");
    expect(document.querySelector("[data-refusal-detail]")).toBeNull();
  });

  it("shows the reason, open, to a reader who may see it", async () => {
    await connectRefused(refusedTest("unknown_reason", "something the page cannot say"), true);
    await vi.waitFor(
      () => expect(document.querySelector("[data-refusal-detail]")).not.toBeNull(),
      WAIT
    );
    await vi.waitFor(
      () => expect(document.body.textContent).toContain("something the page cannot say"),
      WAIT
    );
    expect(document.querySelector("[data-refusal-reason-who]")).toBeNull();
  });
});

describe("An incomplete Connection in the list", () => {
  const kind = required(buildAssetKinds.find((entry) => entry.kind === "connection"));
  const { t } = createTranslationContext("de");
  const row = (attributes: Record<string, string | boolean>): BuildAssetRow => ({
    id: "asset_workmail",
    kind: "connection",
    name: "workmail",
    title: "Work Mail",
    attributes: { connectorType: "mcp", enabled: true, health: "unknown", ...attributes },
    scope: { kind: "instance" },
    revision: 4,
    allowed: ["read", "write", "delete"],
    updatedAt: "2026-10-30T10:00:00.000Z"
  });

  it("is marked and says what it lacks, and offers its delete in place", async () => {
    if (!isEditableKind(kind)) throw new Error("Connections are edited in Build");
    const incomplete = row({ withoutTools: true });
    expect(kind.row?.(incomplete, t).description).toBe("Gespeichert, aber noch ohne Tools.");
    expect(kind.rowRemovable?.(incomplete)).toBe(true);
    await mount(createElement("div", null, kind.badges?.(incomplete, t)));
    expect(document.querySelector("[data-connection-incomplete]")?.textContent).toBe(
      "Unvollständig"
    );
  });

  it("is a complete one once it accepts a tool", () => {
    if (!isEditableKind(kind)) throw new Error("Connections are edited in Build");
    const complete = row({});
    expect(kind.row?.(complete, t).description).toBeUndefined();
    expect(kind.rowRemovable?.(complete)).toBe(false);
  });
});
