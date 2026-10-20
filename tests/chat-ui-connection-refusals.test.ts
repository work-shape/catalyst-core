// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@work-shape/catalyst-api-client";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import {
  buildAssetKinds,
  ConnectionCreateFlow,
  openConnectionDraft,
  readBuildRefusal,
  readConnectionDraft,
  refusalsOf,
  type ConnectionGiveHost,
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
import { CONDITION_WAIT_MS } from "./support/assertions";

// ACCEPT-1c E4: a Connection whose address the instance may not reach was refused with the
// server's sentence, `egress_denied: … release config … 'egress.allowPublicHttps: true'`, in
// English to everybody. The reader is told what happened and who changes it in their language;
// only an operator, who changes release config, gets the server's sentence under Details.

const createDefaults = {
  checkName: async () => ({ available: true as const }),
  remove: async () => undefined,
  mayDelete: () => true
};

const target = { protocol: "https" as const, host: "api.exampledata.com", port: 443 };

/** The refusal of a save as the server sends it (`server/src/asset-kinds/connection.ts`). */
const SERVER_SENTENCE = `egress_denied: the address ${target.host}:${target.port} is not on this instance's egress list. ${egressSettingFor(target)}`;

function egressRefusal(): ApiError {
  return refusalOf([{ message: SERVER_SENTENCE, path: ["settings"], code: "egress_denied" }]);
}

afterEach(async () => {
  await unmountBuildPages();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("A refused Connection address", () => {
  it.each(["en", "de"] as const)("is told in %s without release config", (locale) => {
    const { t } = createTranslationContext(locale);
    const refusal = readBuildRefusal(egressRefusal(), t, locale);
    const [said] = refusalsOf(refusal, undefined);
    // ACCEPT-FIX-7 C9: the operator's network rule blocks it, and the person sends the operator
    // the host. Nobody is told to ask an administrator, and nothing English stands under it.
    expect(said).toContain(
      locale === "en" ? "The operator's network rule blocks" : "Netzwerkregel des Betreibers sperrt"
    );
    expect(said).toContain(locale === "en" ? "send the operator the host" : "schick dem Betreiber");
    expect(said).not.toMatch(/administrator/iu);
    expect(said).not.toContain("egress");
    expect(said).not.toContain("release config");
    expect(!refusal.ok && !refusal.conflict && refusal.refusals[0]?.detail).toBeFalsy();
  });
});

/** An answer of the instance that refuses a definition for the issues given. */
function refusalOf(issues: { message: string; path: string[]; code?: string }[]): ApiError {
  return new ApiError(400, "The asset set is invalid", {
    error: { code: "VALIDATION_FAILED", message: "The asset set is invalid", details: { issues } }
  });
}

/** The address a person typed in screenshot 26, refused by the connector's settings check. */
const INVALID_ADDRESS = refusalOf([
  {
    message: "must be an http or https address without user name, password, query or fragment",
    path: ["settings", "baseUrl"]
  }
]);

/**
 * Connects a new Connection in German that the instance refuses with `error`, or, without
 * one, saves and then tests as `tested` says.
 */
async function connectRefused(
  error: ApiError | undefined,
  roles?: string[],
  tested: "ready" | "unauthorized" = "ready"
): Promise<HTMLElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const read = readConnectionDraft({
    output: {
      connection: { name: "exampledata", title: "Exampledata", baseUrl: "https://api.exampledata.com" },
      operations: [{ name: "list_clients", method: "GET", path: "/clients" }]
    }
  });
  if (!read) throw new Error("The answer is a draft");
  await openConnectionDraft(read, {
    connectorTypeOf: async () => undefined,
    showConnection: () => undefined,
    requestCreateDialog: () => undefined
  });
  const source: ConnectionSource = {
    mayTest: () => true,
    useDetail: () => ({ status: "loading" }),
    readDetail: async () => connectionDetail("exampledata"),
    test: async () => ({ status: tested, testedAt: "2026-10-18T10:00:00.000Z" }),
    setSecret: async () => undefined,
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
    ...createDefaults,
    put: async () => {
      if (error) throw error;
      return { revision: 1 };
    },
    onClose: () => undefined,
    onCreated: () => undefined
  });
  const reader =
    roles === undefined
      ? flow
      : createElement(
          SettingsPageProvider,
          { value: buildPageSettings(fetch, settingsUser({ roles })) },
          flow
        );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(TranslationProvider, { locale: "de", children: null }, reader)
      )
    )
  );
  mounted.push(root);
  const key = container.querySelector<HTMLInputElement>('input[type="password"]');
  if (key) {
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      set?.call(key, "sk-test");
      key.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  const connect = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Verbinden"
  );
  await act(async () => connect?.click());
  return container;
}

/** What the address field of the dialog is described with: its error. */
function addressError(container: HTMLElement): string {
  const address = container.querySelector<HTMLInputElement>(
    'input[value="https://api.exampledata.com"]'
  );
  return (address?.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

/** The text of the page outside the administrator's Technical details. */
function told(container: HTMLElement): string {
  const copy = container.cloneNode(true);
  if (!(copy instanceof HTMLElement)) return "";
  copy.querySelectorAll("[data-refusal-detail]").forEach((detail) => detail.remove());
  return copy.textContent ?? "";
}

const mounted: Root[] = [];

describe("A refused new Connection", () => {
  afterEach(async () => {
    for (const root of mounted.splice(0)) await act(async () => root.unmount());
  });

  it.each([[["user"]], [["user", "admin"]]])(
    "tells a refused address at the address field once, with the host to send the operator (%j)",
    async (roles) => {
      const page = await connectRefused(egressRefusal(), roles);
      await vi.waitFor(() => expect(addressError(page)).toContain("Netzwerkregel des Betreibers"));
      expect(addressError(page)).toBe(
        "Eine Netzwerkregel des Betreibers sperrt dieses Ziel. Damit es erlaubt wird, schick dem Betreiber den Host api.exampledata.com."
      );
      // ACCEPT-FIX-7 C9: told once, in German, with no English sentence under Technical details.
      expect(page.textContent).not.toContain("egress");
      expect(page.querySelector("[data-refusal-detail]")).toBeNull();
      expect(page.textContent?.split("Netzwerkregel des Betreibers").length).toBe(2);
      // Nothing was saved, so nothing is said to be in the list.
      expect(page.querySelector("[data-connection-create-saved]")).toBeNull();
    }
  );

  it("says that a Connection saved before its key was refused is in the list already (ACCEPT-FIX-10 C11)", async () => {
    const page = await connectRefused(undefined, undefined, "unauthorized");
    await vi.waitFor(() =>
      expect(page.textContent).toContain("Der Server hat den Schlüssel abgelehnt.")
    );
    expect(page.querySelector("[data-connection-create-saved]")?.textContent).toBe(
      "Exampledata ist schon gespeichert und steht in der Liste, noch ohne Tools. Korrigiere das Feld und verbinde erneut, oder brich ab, um sie zu verwerfen."
    );
  });

  it("says in German how an address is written, with the instance's sentence for an admin", async () => {
    const page = await connectRefused(INVALID_ADDRESS, ["user", "admin"]);
    await vi.waitFor(() => expect(addressError(page)).toContain("https://"));
    expect(addressError(page)).toContain("Gib die Adresse als Webadresse an");
    expect(told(page)).not.toContain("must be an http or https address");
    const detail = page.querySelector("[data-refusal-detail]");
    expect(detail?.textContent).toContain("Technische Details");
    await act(async () => detail?.querySelector("button")?.click());
    expect(detail?.textContent).toContain("must be an http or https address");
  });

  it("says what it does not know in German, never in the instance's words", async () => {
    const page = await connectRefused(
      refusalOf([{ message: "settings.retries: expected a number", path: ["settings", "retries"] }])
    );
    await vi.waitFor(() =>
      expect(page.querySelector("[data-connection-create-error]")?.textContent).toContain(
        "Die Instanz hat diese Verbindung nicht angenommen"
      )
    );
    expect(page.textContent).not.toContain("expected a number");
  });
});

describe("A refused save on the Connection page", () => {
  async function refusedSave(
    roles: string[],
    refusal: ApiError = egressRefusal(),
    said = "The operator's network rule blocks"
  ): Promise<HTMLElement> {
    const asset = connectionAsset("sample-business", { origin: "runtime" });
    const detailPath = apiOperations["connections.get"].path.replace(":name", asset.name);
    const page = await mountBuildPage(
      asset,
      "connections",
      (request, url) =>
        request.method === "GET" && url.pathname === detailPath
          ? Response.json(connectionDetail(asset.name))
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
      set?.call(address, "https://api.exampledata.com");
      address?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = page.querySelector<HTMLFormElement>("[data-connection-settings-form]");
    await act(async () => form?.requestSubmit());
    await vi.waitFor(() => expect(page.textContent).toContain(said), {
      timeout: 5000
    });
    return page;
  }

  it("says what happened to a builder, without the server's sentence", async () => {
    const page = await refusedSave(["user"]);
    expect(page.querySelector("[data-refusal-detail]")).toBeNull();
    expect(page.textContent).not.toContain("release config");
  });

  it.each([["admin"], ["superadmin"]])(
    "keeps the server's sentence under Technical details for an %s, but none for a refused egress",
    async (role) => {
      const page = await refusedSave(["user", role], INVALID_ADDRESS, "starts with https://");
      const detail = page.querySelector("[data-refusal-detail]");
      expect(detail?.textContent).toContain("Technical details");
      await act(async () => detail?.querySelector("button")?.click());
      expect(detail?.textContent).toContain("must be an http or https address");
      await unmountBuildPages();
      // ACCEPT-FIX-7 C9: the network rule is said whole, in the reader's language.
      const egress = await refusedSave(["user", role]);
      expect(egress.querySelector("[data-refusal-detail]")).toBeNull();
      expect(egress.textContent).not.toContain("egress.allowPublicHttps");
    }
  );

  it("says how an address is written where the instance refused it in its own words", async () => {
    const page = await refusedSave(["user"], INVALID_ADDRESS, "starts with https://");
    expect(page.textContent).toContain("The instance did not accept these settings.");
    expect(page.textContent).not.toContain("must be an http or https address");
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
    expect(warning?.textContent).toBe(
      "The key is deleted and the connection sends no key from now on. Calls of Workflow Assistant, Steuer-Agent, and Monthly sync (Workflow) are refused by a server that asks for a key."
    );
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
        "Calls of Workflow Assistant, Steuer-Agent, and Monthly sync (Workflow)"
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

// ACCEPT-FIX-10 C11, found in the browser: the instance answers a refused key with a
// successful `connections.test` whose status is `unauthorized`. The dialog of the Build area,
// on the instance's real answers, keeps its form open, says the key was refused and that the
// Connection is saved, and never says it connected.
describe("A new REST API whose key the server refuses, on the instance's answers", () => {
  it.each(["en", "de"] as const)("stays open at the key in %s", async (locale) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === apiOperations["platform.context.get"].path)
        return Response.json(platformContext([], ["connection.write"]));
      const call = /^\/api\/v1\/connections\/([^/]+)(?:\/(secret|test))?$/u.exec(url.pathname);
      if (call?.[2] === "secret" && request.method === "PUT") {
        calls.push("set_secret");
        return Response.json({ state: "set", version: 1 });
      }
      if (call?.[2] === "test" && request.method === "POST") {
        calls.push("test");
        return Response.json({ status: "unauthorized", testedAt: "2026-10-19T10:00:00.000Z" });
      }
      if (call && call[2] === undefined && request.method === "GET")
        return Response.json(connectionDetail(decodeURIComponent(call[1] ?? "")));
      return Response.json({ error: { code: "NOT_FOUND", message: "none" } }, { status: 404 });
    };
    const connectionKind = buildAssetKinds.find((kind) => kind.kind === "connection");
    if (!connectionKind || !("CreateDialog" in connectionKind) || !connectionKind.CreateDialog)
      throw new Error("Connections have a create dialog");
    const CreateDialog = connectionKind.CreateDialog;
    const puts: unknown[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(root);
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
          createElement(
            SettingsPageProvider,
            { value: buildPageSettings(fetchImpl, settingsUser({ roles: ["user", "admin"] })) },
            createElement(
              UiRoot,
              { mode: "light", labels: uiLabelsEn },
              createElement(
                TranslationProvider,
                { locale, children: null },
                createElement(CreateDialog, {
                  ...createDefaults,
                  put: async (input) => {
                    puts.push(input);
                    return { revision: puts.length };
                  },
                  onClose: () => calls.push("closed"),
                  onCreated: () => calls.push("created")
                })
              )
            )
          )
        )
      )
    );
    const dialog = () => document.body;
    await act(async () =>
      dialog().querySelector<HTMLElement>('[data-connection-type="http_api"] button')?.click()
    );
    const type = async (input: HTMLInputElement | null | undefined, value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          input,
          value
        );
        input?.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const form = dialog().querySelector("[data-connection-create-form]");
    await type(
      form?.querySelector<HTMLInputElement>('input[type="text"], input:not([type])'),
      "Prüfung falscher Schlüssel"
    );
    await type(
      form?.querySelector<HTMLInputElement>('[data-connection-field="url"]'),
      "http://127.0.0.1:5830"
    );
    await type(
      form?.querySelector<HTMLInputElement>('[data-connection-field="secret"]'),
      "sk-wrong"
    );
    await vi.waitFor(() =>
      expect(dialog().querySelector<HTMLButtonElement>("[data-connection-connect]")?.disabled).toBe(
        false
      )
    );
    await act(async () =>
      dialog().querySelector<HTMLButtonElement>("[data-connection-connect]")?.click()
    );
    await vi.waitFor(() =>
      expect(dialog().querySelector("[data-connection-create-saved]")).not.toBeNull()
    );
    expect(calls).toEqual(["set_secret", "test"]);
    expect(dialog().querySelector("[data-connection-create-form]")).not.toBeNull();
    expect(dialog().querySelector("[data-connection-connected]")).toBeNull();
    const { t } = createTranslationContext(locale);
    expect(dialog().textContent).toContain(t("connectionCreate.errorKey"));
    expect(dialog().querySelector("[data-connection-create-saved]")?.textContent).toBe(
      t("connectionCreate.savedDiscardable", { name: "Prüfung falscher Schlüssel" })
    );
    // The refused key is not kept in the field.
    expect(
      dialog().querySelector<HTMLInputElement>('[data-connection-field="secret"]')?.value
    ).toBe("");
  });
});

// CONN-PAGE 5: approved, the New connection dialog stays open at its done step, which gives
// the approved tools for agents to the agent the reader chooses (CS-5d); Done leaves.
describe("The done step of a new REST API", () => {
  it("is reached after the approval, and gives the approved tools to the chosen agent", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const read = readConnectionDraft({
      output: {
        connection: { name: "ledger", title: "Ledger", baseUrl: "https://api.ledger.example" },
        operations: [{ name: "list_invoices", method: "GET", path: "/invoices" }]
      }
    });
    if (!read) throw new Error("The answer is a draft");
    await openConnectionDraft(read, {
      connectorTypeOf: async () => undefined,
      showConnection: () => undefined,
      requestCreateDialog: () => undefined
    });
    // The reader may publish two agents; the instance holds the publish for an approval.
    const writes: string[] = [];
    const give: ConnectionGiveHost = {
      viewerId: "user-reader",
      source: {
        connection: async () => ({
          title: "Ledger",
          tools: [{ toolName: "connection.ledger.list_invoices", title: "List invoices" }]
        }),
        agents: async () => [
          { name: "assistant", title: "Assistant" },
          { name: "reporter", title: "Reporter" }
        ],
        readAgent: async () => ({ revision: 3, config: { toolNames: ["show_view"] } }),
        readDraft: async () => null,
        saveDraft: async (name, config) => {
          writes.push(`save ${name} ${JSON.stringify(config.toolNames)}`);
          return 4;
        },
        publish: async (name, revision) => {
          writes.push(`publish ${name} ${revision}`);
          return "waits";
        },
        discard: async () => undefined
      }
    };
    const source: ConnectionSource = {
      mayTest: () => true,
      useDetail: () => ({ status: "loading" }),
      readDetail: async () => connectionDetail("ledger"),
      test: async () => ({ status: "ready", testedAt: "2026-10-18T10:00:00.000Z" }),
      setSecret: async () => undefined,
      discover: async () => undefined,
      useTest: () => ({ run: { status: "idle" }, start: () => undefined }),
      useHolders: () => ({ status: "hidden" }),
      principalHref: () => "",
      oauthStart: async () => {
        throw new Error("This test signs nothing in.");
      },
      give
    };
    const created: string[] = [];
    const puts: { config: Record<string, unknown>; expectedRevision: number | null }[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(root);
    await act(async () =>
      root.render(
        createElement(
          UiRoot,
          { mode: "light", labels: uiLabelsEn },
          createElement(
            TranslationProvider,
            { locale: "en", children: null },
            createElement(ConnectionCreateFlow, {
              source,
              ...createDefaults,
              put: async (input) => {
                puts.push(input);
                return { revision: puts.length };
              },
              onClose: () => undefined,
              onCreated: (name) => created.push(name)
            })
          )
        )
      )
    );
    const body = document.body;
    const key = body.querySelector<HTMLInputElement>('input[type="password"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        key,
        "sk-test"
      );
      key?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      body.querySelector<HTMLButtonElement>("[data-connection-connect]")?.click()
    );
    await vi.waitFor(() => expect(body.querySelector("[data-connection-approve]")).not.toBeNull(), {
      timeout: CONDITION_WAIT_MS
    });
    await act(async () =>
      body.querySelector<HTMLButtonElement>("[data-connection-approve]")?.click()
    );
    await vi.waitFor(
      () => expect(body.querySelector("[data-connection-approved]")).not.toBeNull(),
      { timeout: CONDITION_WAIT_MS }
    );
    // The approval saved the tools and did not leave for the page yet.
    expect(created).toEqual([]);
    expect(body.textContent).toContain("1 tool approved.");
    await act(async () => body.querySelector<HTMLButtonElement>("[data-connection-give]")?.click());
    // Choose Assistant, then confirm the question that names it and the tool.
    await vi.waitFor(
      () => expect(body.querySelector('[data-connection-give-agent="assistant"]')).not.toBeNull(),
      { timeout: CONDITION_WAIT_MS }
    );
    await act(async () =>
      body.querySelector<HTMLButtonElement>("[data-connection-give-next]")?.click()
    );
    await vi.waitFor(
      () =>
        expect(body.querySelector('[data-connection-give-ask="assistant"]')?.textContent).toContain(
          "Give Assistant 1 tool of Ledger?"
        ),
      { timeout: CONDITION_WAIT_MS }
    );
    expect(writes).toEqual([]);
    await act(async () =>
      body.querySelector<HTMLButtonElement>("[data-connection-give-confirm]")?.click()
    );
    await vi.waitFor(
      () => expect(body.querySelector('[data-connection-give-outcome="waits"]')).not.toBeNull(),
      { timeout: CONDITION_WAIT_MS }
    );
    expect(writes).toEqual([
      'save assistant ["show_view","connection.ledger.list_invoices"]',
      "publish assistant 4"
    ]);
    expect(body.textContent).toContain(
      "The change to Assistant waits for an approval in the Inbox."
    );
    await act(async () =>
      body.querySelector<HTMLButtonElement>("[data-connection-give-done]")?.click()
    );
    expect(created).toEqual(["ledger"]);
  });
});
