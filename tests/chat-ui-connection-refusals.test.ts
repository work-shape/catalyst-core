// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@work-shape/catalyst-api-client";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
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
import { buildPageSettings, mountBuildPage, unmountBuildPages } from "./chat-ui-build-page-harness";
import { connectionAsset, connectionDetail } from "./chat-ui-connection-fixtures";
import { TranslationProvider } from "./chat-ui-render-harness";
import { settingsUser } from "./chat-ui-settings-fixtures";

// ACCEPT-1c E4: a Connection whose address the instance may not reach was refused with the
// server's sentence, `egress_denied: … release config … 'egress.allowPublicHttps: true'`, in
// English to everybody. The reader is told what happened and who changes it in their language;
// only an operator, who changes release config, gets the server's sentence under Details.

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
    const [said] = refusalsOf(readBuildRefusal(egressRefusal(), t, locale), undefined);
    expect(said).toContain(locale === "en" ? "may not reach" : "darf die Adresse");
    expect(said).toContain(locale === "en" ? "operator" : "Betreiber");
    expect(said).not.toContain("egress");
    expect(said).not.toContain("release config");
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

/** Connects a new Connection in German that the instance refuses with `error`. */
async function connectRefused(error: ApiError, roles?: string[]): Promise<HTMLElement> {
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
    test: async () => ({ status: "ready", testedAt: "2026-10-18T10:00:00.000Z" }),
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
    namespaces: [],
    mayNameFreely: true,
    checkName: async () => ({ available: true as const }),
    put: async () => {
      throw error;
    },
    remove: async () => undefined,
    mayDelete: () => true,
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

  it("tells a refused address at the address field, and nobody but an admin the reason", async () => {
    const page = await connectRefused(egressRefusal());
    await vi.waitFor(() => expect(addressError(page)).toContain("darf die Adresse"));
    expect(addressError(page)).toContain("darf die Adresse der Verbindung nicht erreichen");
    expect(page.textContent).not.toContain("egress");
    expect(page.querySelector("[data-refusal-detail]")).toBeNull();
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
    said = "may not reach"
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
    "keeps the server's sentence under Technical details for an %s",
    async (role) => {
      const page = await refusedSave(["user", role]);
      expect(told(page)).not.toContain("egress.allowPublicHttps");
      const detail = page.querySelector("[data-refusal-detail]");
      expect(detail?.textContent).toContain("Technical details");
      await act(async () => detail?.querySelector("button")?.click());
      expect(detail?.textContent).toContain("egress.allowPublicHttps");
    }
  );

  it("says how an address is written where the instance refused it in its own words", async () => {
    const page = await refusedSave(["user"], INVALID_ADDRESS, "starts with https://");
    expect(page.textContent).toContain("The instance did not accept these settings.");
    expect(page.textContent).not.toContain("must be an http or https address");
  });
});
