// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@work-shape/catalyst-api-client";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { createTranslationContext } from "./support/chat-ui/shared";
import {
  ConnectionCreateFlow,
  openConnectionDraft,
  readBuildRefusal,
  readConnectionDraft,
  refusalsOf,
  type ConnectionSource
} from "@work-shape/catalyst-chat-ui/build-area";
import { SettingsPageProvider } from "@work-shape/catalyst-chat-ui/settings-page-context";
import { egressSettingFor } from "@work-shape/catalyst-core";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { platformContext } from "./chat-ui-build-fixtures";
import { buildPageSettings, mountBuildPage, unmountBuildPages } from "./chat-ui-build-page-harness";
import { connectionAsset, connectionDetail, recordedStates } from "./chat-ui-connection-fixtures";
import { TranslationProvider } from "./chat-ui-render-harness";
import { settingsUser } from "./chat-ui-settings-fixtures";
import { CONDITION_WAIT_MS, required } from "./support/assertions";

// ACCEPT-1c E4: a Connection whose address the instance may not reach was refused with the
// server's sentence, `egress_denied: … release config … 'egress.allowPublicHttps: true'`, in
// English to everybody. The reader is told what happened in their language; only an operator,
// who changes release config, gets the server's sentence under Details. Also the key on the
// Connection page, and a failed connect in the New connection dialog.

const target = { protocol: "https" as const, host: "api.exampledata.test", port: 443 };

/** The refusal of a save as the server sends it (`server/src/asset-kinds/connection.ts`). */
const SERVER_SENTENCE = `egress_denied: the address ${target.host}:${target.port} is not on this instance's egress list. ${egressSettingFor(target)}`;

/** An answer of the instance that refuses a definition for the issues given. */
function refusalOf(issues: { message: string; path: string[]; code?: string }[]): ApiError {
  return new ApiError(400, "The asset set is invalid", {
    error: { code: "VALIDATION_FAILED", message: "The asset set is invalid", details: { issues } }
  });
}

function egressRefusal(): ApiError {
  return refusalOf([{ message: SERVER_SENTENCE, path: ["settings"], code: "egress_denied" }]);
}

/** The address a person typed in screenshot 26, refused by the connector's settings check. */
const INVALID_ADDRESS = refusalOf([
  {
    message: "must be an http or https address without user name, password, query or fragment",
    path: ["settings", "baseUrl"]
  }
]);

const mounted: Root[] = [];

afterEach(async () => {
  for (const root of mounted.splice(0)) await act(async () => root.unmount());
  await unmountBuildPages();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("A refused Connection address", () => {
  it.each(["en", "de"] as const)("is told in %s without release config", (locale) => {
    const { t } = createTranslationContext(locale);
    const refusal = readBuildRefusal(egressRefusal(), t, locale);
    const [said] = refusalsOf(refusal, undefined);
    // ACCEPT-FIX-7 C9: nobody is told to ask an administrator, and no server sentence shows.
    expect(said).not.toMatch(/administrator/iu);
    expect(said).not.toContain("egress");
    expect(said).not.toContain("release config");
    expect(!refusal.ok && !refusal.conflict && refusal.refusals[0]?.detail).toBeFalsy();
  });
});

/**
 * The instance as a reader of these roles finds it: a superadmin sees how the instance runs
 * (`system.view`), an admin does not (RIGHTS-1e).
 */
function platformAnswer(roles: readonly string[]): Response {
  return Response.json({
    ...platformContext(),
    instanceActions: roles.includes("superadmin") ? ["system.view"] : []
  });
}

function platformFor(roles: readonly string[]): typeof fetch {
  return async (input, init) => {
    const url = new URL(new Request(input, init).url);
    return url.pathname === apiOperations["platform.context.get"].path
      ? platformAnswer(roles)
      : Response.json({ error: { code: "NOT_FOUND", message: "none" } }, { status: 404 });
  };
}

/**
 * Opens the New connection dialog at the agent's draft of `exampledata`, types a key and
 * connects. The instance refuses the save with `error`, or saves at revision 7 and tests as
 * `tested` says. Answers the dialog and what it wrote, removed and closed.
 */
async function connect(input: {
  error?: ApiError;
  roles?: string[];
  tested?: "ready" | "unauthorized" | "unavailable";
  locale?: "en" | "de";
}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const read = readConnectionDraft({
    output: {
      connection: {
        name: "exampledata",
        title: "Exampledata",
        baseUrl: "https://api.exampledata.test"
      },
      operations: [{ name: "list_clients", method: "GET", path: "/clients" }]
    }
  });
  if (!read) throw new Error("The answer is a draft");
  await openConnectionDraft(read, {
    connectorTypeOf: async () => undefined,
    showConnection: () => undefined,
    requestCreateDialog: () => undefined
  });
  const writes: (number | null)[] = [];
  const secrets: string[] = [];
  const removed: { name: string; expectedRevision: number }[] = [];
  const closed: string[] = [];
  const source: ConnectionSource = {
    mayTest: () => true,
    useDetail: () => ({ status: "loading" }),
    readDetail: async () => connectionDetail("exampledata"),
    test: async () => ({
      status: input.tested ?? "ready",
      testedAt: "2026-10-18T10:00:00.000Z"
    }),
    setSecret: async (_name, value) => {
      secrets.push(value);
    },
    discover: async () => undefined,
    useTest: () => ({ run: { status: "idle" }, start: () => undefined }),
    useHolders: () => ({ status: "hidden" }),
    principalHref: () => "",
    oauthStart: async () => {
      throw new Error("This test signs nothing in.");
    }
  };
  const flow = createElement(ConnectionCreateFlow, {
    source,
    checkName: async () => ({ available: true as const }),
    put: async ({ expectedRevision }) => {
      if (input.error) throw input.error;
      writes.push(expectedRevision);
      return { revision: 7 };
    },
    remove: async (removal) => {
      removed.push(removal);
    },
    mayDelete: () => true,
    onClose: () => closed.push("closed"),
    onCreated: (name) => closed.push(`created ${name}`)
  });
  const reader =
    input.roles === undefined
      ? flow
      : createElement(
          QueryClientProvider,
          { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
          createElement(
            SettingsPageProvider,
            {
              value: buildPageSettings(
                platformFor(input.roles),
                settingsUser({ roles: input.roles })
              )
            },
            flow
          )
        );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () =>
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(TranslationProvider, { locale: input.locale ?? "de", children: null }, reader)
      )
    )
  );
  const key = required(container.querySelector<HTMLInputElement>('input[type="password"]'));
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(key, "sk-test");
    key.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    required(container.querySelector<HTMLButtonElement>("[data-connection-connect]")).click()
  );
  return { page: container, writes, secrets, removed, closed };
}

/** What the address field of the dialog is described with: its error. */
function addressError(container: HTMLElement): string {
  const address = container.querySelector<HTMLInputElement>(
    'input[value="https://api.exampledata.test"]'
  );
  return (address?.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

describe("A refused new Connection", () => {
  it("tells an admin a refused address at the address field once, with no server sentence", async () => {
    const { page } = await connect({ error: egressRefusal(), roles: ["user", "admin"] });
    await vi.waitFor(() => expect(addressError(page)).toContain("Netzwerkregel"));
    // ACCEPT-FIX-7 C9: told once, in German, with no English sentence under Technical details.
    expect(page.textContent).not.toContain("egress");
    expect(page.querySelector("[data-refusal-detail]")).toBeNull();
    expect(page.textContent?.split("Netzwerkregel").length).toBe(2);
    // Nothing was saved, so nothing is said to be in the list.
    expect(page.querySelector("[data-connection-create-saved]")).toBeNull();
  });

  it("gives a superadmin the instance's sentence under Technical details only", async () => {
    const { page } = await connect({
      error: INVALID_ADDRESS,
      roles: ["user", "admin", "superadmin"]
    });
    await vi.waitFor(() => expect(page.querySelector("[data-refusal-detail]")).not.toBeNull());
    const detail = required(page.querySelector("[data-refusal-detail]"));
    const outside = page.cloneNode(true);
    if (!(outside instanceof HTMLElement)) throw new Error("The page is an element");
    outside.querySelectorAll("[data-refusal-detail]").forEach((found) => found.remove());
    expect(outside.textContent).not.toContain("must be an http or https address");
    await act(async () => detail.querySelector("button")?.click());
    expect(detail.textContent).toContain("must be an http or https address");
  });

  it("says what it does not know never in the instance's words", async () => {
    const { page } = await connect({
      error: refusalOf([
        { message: "settings.retries: expected a number", path: ["settings", "retries"] }
      ])
    });
    await vi.waitFor(() =>
      expect(page.querySelector("[data-connection-create-error]")).not.toBeNull()
    );
    expect(page.textContent).not.toContain("expected a number");
  });

  // ACCEPT-FIX-10 C11, found in the browser: the instance answers a refused key with a
  // successful `connections.test` whose status is `unauthorized`.
  it("stays open at a refused key, says the Connection is saved, and forgets the key", async () => {
    const { page, secrets } = await connect({ tested: "unauthorized" });
    await vi.waitFor(() =>
      expect(page.querySelector("[data-connection-create-saved]")?.textContent).toContain(
        "Exampledata"
      )
    );
    expect(secrets).toEqual(["sk-test"]);
    expect(page.querySelector("[data-connection-create-form]")).not.toBeNull();
    expect(page.querySelector("[data-connection-connected]")).toBeNull();
    expect(page.querySelector<HTMLInputElement>('[data-connection-field="secret"]')?.value).toBe(
      ""
    );
  });

  // Replaces e2e/connection-editor.spec.ts "cancel after a failed connect asks, then deletes the
  // Connection": nothing half-made, key and all, is left behind.
  it("asks on cancel after a failed connect, then deletes the Connection once, at its revision", async () => {
    const { writes, secrets, removed, closed } = await connect({
      tested: "unavailable",
      locale: "en"
    });
    await vi.waitFor(() => expect(secrets).toEqual(["sk-test"]), { timeout: CONDITION_WAIT_MS });
    expect(writes).toEqual([null]);
    const button = (text: string, within: ParentNode = document) =>
      required(
        [...within.querySelectorAll<HTMLButtonElement>("button")].find(
          (candidate) => candidate.textContent?.trim() === text
        )
      );
    await act(async () => button("Cancel").click());
    // Cancel asks first: the dialog has not closed and nothing is deleted yet.
    const ask = await vi.waitFor(
      () =>
        required(
          [...document.querySelectorAll<HTMLElement>('[role="alertdialog"], dialog[open]')].find(
            (dialog) => dialog.textContent?.includes("Discard")
          )
        ),
      { timeout: CONDITION_WAIT_MS }
    );
    expect(closed).toEqual([]);
    expect(removed).toEqual([]);
    await act(async () => button("Discard", ask).click());
    await vi.waitFor(() => expect(closed).toEqual(["closed"]), { timeout: CONDITION_WAIT_MS });
    expect(removed).toEqual([{ name: "exampledata", expectedRevision: 7 }]);
  });
});

describe("A refused save on the Connection page", () => {
  async function refusedSave(
    roles: string[],
    refusal: ApiError = egressRefusal(),
    said = "A network rule blocks"
  ): Promise<HTMLElement> {
    const asset = connectionAsset("sample-business", { origin: "runtime" });
    const detailPath = apiOperations["connections.get"].path.replace(":name", asset.name);
    const page = await mountBuildPage(
      asset,
      "connections",
      (request, url) =>
        request.method === "GET" && url.pathname === detailPath
          ? Response.json(connectionDetail(asset.name))
          : url.pathname === apiOperations["platform.context.get"].path
            ? platformAnswer(roles)
            : undefined,
      [],
      {
        user: settingsUser({ roles }),
        put: async () => {
          throw refusal;
        }
      }
    );
    const button = (name: string) =>
      [...page.querySelectorAll("button")].find((found) => found.textContent?.trim() === name);
    await vi.waitFor(() => expect(button("Edit")).toBeDefined(), { timeout: 5000 });
    await act(async () => button("Edit")?.click());
    const address = page.querySelector<HTMLInputElement>("[data-connection-settings-form] input");
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      set?.call(address, "https://api.exampledata.test");
      address?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = page.querySelector<HTMLFormElement>("[data-connection-settings-form]");
    await act(async () => form?.requestSubmit());
    await vi.waitFor(() => expect(page.textContent).toContain(said), {
      timeout: 5000
    });
    return page;
  }

  it("keeps the server's sentence from an admin, who does not see how the instance runs", async () => {
    const page = await refusedSave(["user", "admin"], INVALID_ADDRESS, "starts with https://");
    expect(page.querySelector("[data-refusal-detail]")).toBeNull();
    expect(page.textContent).not.toContain("must be an http or https address");
  });

  it("keeps the server's sentence under Technical details for a superadmin, but none for a refused egress", async () => {
    const page = await refusedSave(["user", "superadmin"], INVALID_ADDRESS, "starts with https://");
    await vi.waitFor(() => expect(page.querySelector("[data-refusal-detail]")).not.toBeNull());
    const detail = page.querySelector("[data-refusal-detail]");
    await act(async () => detail?.querySelector("button")?.click());
    expect(detail?.textContent).toContain("must be an http or https address");
    await unmountBuildPages();
    // ACCEPT-FIX-7 C9: the network rule is said whole, in the reader's language.
    const egress = await refusedSave(["user", "superadmin"]);
    expect(egress.querySelector("[data-refusal-detail]")).toBeNull();
    expect(egress.textContent).not.toContain("egress.allowPublicHttps");
  });
});

describe("The key on the Connection page (ACCEPT-FIX-7 C5, C6)", () => {
  /** A Connection made on the instance, whose instance records each call the page makes. */
  async function keyPage() {
    const asset = connectionAsset("sample-business", { origin: "runtime" });
    const path = (operation: "connections.get" | "connections.test" | "connections.set_secret") =>
      apiOperations[operation].path.replace(":name", asset.name);
    const calls: string[] = [];
    const puts: Record<string, unknown>[] = [];
    let tested = false;
    const page = await mountBuildPage(
      asset,
      "connections",
      (request, url) => {
        if (url.pathname === apiOperations["platform.context.get"].path) {
          return Response.json(platformContext([], ["connection.write"]));
        }
        if (request.method === "PUT" && url.pathname === path("connections.set_secret")) {
          calls.push("set_secret");
          return Response.json({ state: "set", version: 3 });
        }
        if (request.method === "POST" && url.pathname === path("connections.test")) {
          calls.push("test");
          tested = true;
          return Response.json({ status: "ready", testedAt: "2026-10-18T10:00:00.000Z" });
        }
        if (request.method === "GET" && url.pathname === path("connections.get")) {
          return Response.json(
            connectionDetail(asset.name, {
              ...(tested ? { health: "ok" } : recordedStates.unauthorized),
              usedByAssets: [{ kind: "workflow", name: "monthly_sync", title: "Monthly sync" }]
            })
          );
        }
        return undefined;
      },
      [],
      {
        user: settingsUser({ roles: ["user", "admin"] }),
        put: async (input) => {
          if ("config" in input) puts.push(input.config);
          return { revision: 2 };
        }
      }
    );
    const button = (text: string) =>
      [...page.querySelectorAll("button")].find((found) => found.textContent?.trim() === text);
    await vi.waitFor(() => expect(button("Enter a new key")).toBeDefined(), { timeout: 5000 });
    return { page, calls, puts, button };
  }

  it("tests a new key as soon as it is saved, and the status shows the answer", async () => {
    const { page, calls, button } = await keyPage();
    expect(
      page.querySelector("[data-connection-health]")?.getAttribute("data-connection-health")
    ).toBe("unauthorized");
    await act(async () => button("Enter a new key")?.click());
    const field = page.querySelector<HTMLInputElement>(
      '[data-connection-secret-form] input[type="password"]'
    );
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      set?.call(field, "sk-new-key");
      field?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      page.querySelector<HTMLFormElement>("[data-connection-secret-form]")?.requestSubmit()
    );
    await vi.waitFor(() => expect(calls).toEqual(["set_secret", "test"]), { timeout: 5000 });
    await vi.waitFor(() =>
      expect(
        page.querySelector("[data-connection-health]")?.getAttribute("data-connection-health")
      ).toBe("ready")
    );
    await vi.waitFor(() =>
      expect(
        page
          .querySelector("[data-connection-head-health]")
          ?.getAttribute("data-connection-head-health")
      ).toBe("ready")
    );
  });

  it("removes the key after a warning that names what uses it, through the save of the definition", async () => {
    const { page, puts, button } = await keyPage();
    await act(async () =>
      page.querySelector<HTMLButtonElement>("[data-connection-secret-remove]")?.click()
    );
    const warning = page.querySelector("[data-connection-secret-remove-warning]");
    // It names every listed user of the Connection.
    expect(warning?.textContent).toContain("Workflow Assistant, Steuer-Agent, and Monthly sync");
    expect(puts).toEqual([]);
    const confirm = [...page.querySelectorAll("dialog button, [role=dialog] button")].find(
      (found) => found.textContent?.trim() === "Remove key"
    );
    await act(async () => (confirm instanceof HTMLButtonElement ? confirm.click() : undefined));
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    // The instance deletes a key the definition no longer sends (spec CS :373), and the page
    // says that the Connection sends none.
    expect(puts[0]).toMatchObject({ authScheme: "none" });
    await vi.waitFor(() =>
      expect(
        page
          .querySelector("[data-connection-credential]")
          ?.getAttribute("data-connection-credential")
      ).toBe("none_needed")
    );
    expect(button("Remove key")).toBeUndefined();
  });

  it("warns at the settings, too, when choosing no key deletes the stored one", async () => {
    const { page, button } = await keyPage();
    await act(async () => button("Edit")?.click());
    expect(page.querySelector("[data-connection-key-clears]")).toBeNull();
    const none = page.querySelector<HTMLButtonElement>(
      '[data-connection-settings-form] button[role="radio"][value="none"]'
    );
    expect(none).not.toBeNull();
    await act(async () => none?.click());
    await vi.waitFor(() =>
      expect(page.querySelector("[data-connection-key-clears]")?.textContent).toContain(
        "Monthly sync"
      )
    );
  });
});

describe("A discovered tool on the Connection page (ACCEPT-FIX-7 C10)", () => {
  it("is accepted with the effect the person chose, in the page's save of the definition", async () => {
    const asset = connectionAsset("deepwiki", { origin: "runtime" });
    const puts: Record<string, unknown>[] = [];
    const page = await mountBuildPage(
      asset,
      "connections",
      (request, url) =>
        request.method === "GET" &&
        url.pathname === apiOperations["connections.get"].path.replace(":name", asset.name)
          ? Response.json(
              connectionDetail(asset.name, {
                discoveredAt: "2026-10-18T10:00:00.000Z",
                discovered: [
                  { name: "read_wiki", proposedEffect: "changing", fingerprint: "a".repeat(64) }
                ]
              })
            )
          : undefined,
      [],
      {
        put: async (input) => {
          if ("config" in input) puts.push(input.config);
          return { revision: 2 };
        }
      }
    );
    const select = await vi.waitFor(
      () => {
        const found = page.querySelector<HTMLSelectElement>('[data-approval-effect="read_wiki"]');
        if (!found) throw new Error("no effect choice yet");
        return found;
      },
      { timeout: 5000 }
    );
    // Without a hint the tool changes and is not ticked.
    expect(select.value).toBe("changing");
    await act(async () => {
      select.value = "reading";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () =>
      page
        .querySelector<HTMLButtonElement>(
          '[data-approval-tool="read_wiki"] button[role="checkbox"]'
        )
        ?.click()
    );
    await act(async () =>
      page.querySelector<HTMLButtonElement>("[data-connection-approve]")?.click()
    );
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]?.operations).toEqual([
      expect.objectContaining({ name: "read_wiki", effect: "reading", enabled: true })
    ]);
  });
});
