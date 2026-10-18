// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import {
  buildAssetKinds,
  BuildAssetKindsProvider,
  BuildFrame,
  BuildNavigationProvider,
  dataStoreKindOn,
  resolveBuildRights,
  type BuildAsset,
  type BuildSource,
  type DataStoreSource,
  type DataStoreState
} from "@work-shape/catalyst-chat-ui/build-area";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { platformContext } from "./chat-ui-build-fixtures";
import { mountBuildPage, unmountBuildPages } from "./chat-ui-build-page-harness";
import { settingsUser } from "./chat-ui-settings-fixtures";
import { CONDITION_WAIT_MS } from "./support/assertions";
import { TranslationProvider } from "./chat-ui-render-harness";

// ACCEPT-1c C10: a Data Store published in one click, and its page showed a customer admin
// what only the one who runs the database server can close. Publish asks first, as every other
// Build publish does; the steps on the server stand only for a superadmin.

const noop = () => undefined;

const draft: BuildAsset = {
  id: "asset_leads",
  kind: "data_store",
  name: "leads",
  scope: { kind: "workspace", workspaceId: "ws_1" },
  revision: 1,
  draftRevision: 1,
  config: {
    name: "leads",
    title: "Leads",
    migrations: [{ number: 1, name: "init", sha256: "0".repeat(64), sql: "create table l ();" }]
  },
  updatedAt: "2026-10-18T10:00:00.000Z"
};

const published: BuildAsset = { ...draft, revision: 2, draftRevision: 2, publishedRevision: 2 };

const state: DataStoreState = {
  id: "asset_leads",
  name: "leads",
  status: "ready",
  level: 1,
  publishedLevel: 1,
  size: { limitBytes: 500 * 1024 ** 2, nearLimit: false },
  conditions: [{ code: "server_databases_open", message: "Run REVOKE CONNECT as the owner." }],
  lastMigration: { outcome: "applied", migration: { number: 1, name: "init" } }
};

function storeSource(seesServerConditions: boolean): DataStoreSource {
  return {
    seesServerConditions,
    useStoreState: () => ({ status: "ready", data: state }),
    useSchema: () => ({ status: "loading" }),
    useListed: () => ({ status: "loading" }),
    useRowsPage: () => ({ status: "loading" }),
    useValue: () => ({ status: "loading" }),
    useUsedBy: () => ({ status: "loading" }),
    useUsingPage: () => () => undefined
  };
}

const unmounts: (() => void)[] = [];

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) unmount();
  await unmountBuildPages();
  vi.unstubAllGlobals();
});

async function mount(
  asset: BuildAsset,
  input: {
    seesServerConditions?: boolean;
    publish?: () => void;
    locale?: "en" | "de";
    /** Opens the list of stores instead of the store's page. */
    list?: true;
  } = {}
): Promise<HTMLElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const source: BuildSource = {
    kinds: [{ kind: "data_store", canCreate: true, canDelete: true }],
    rights: {
      ...resolveBuildRights({ permissions: ["config_assets.write"] }, platformContext()),
      workspaces: [{ id: "ws_1", name: "Mine", member: true, personal: true }]
    },
    loading: false,
    error: undefined,
    reload: async () => undefined,
    useList: () => ({
      rows: [{ ...asset, title: "Leads" }],
      error: undefined,
      hasMore: false,
      loadingMore: false,
      loadMore: noop,
      retry: noop
    }),
    useAsset: () => ({ status: "ready", asset, loadedAt: 1, reload: async () => "loaded" }),
    exists: async () => true,
    checkName: async () => ({ available: true }),
    writes: {
      put: async () => ({ revision: 1 }),
      readFiles: async () => [],
      delete: async () => undefined,
      publish: async () => {
        input.publish?.();
        return { draftRevision: 1, publishedRevision: 1 };
      },
      revert: async () => ({ revision: 1 }),
      revisions: async () => ({ items: [] })
    }
  };
  const planted = dataStoreKindOn(() => storeSource(input.seesServerConditions ?? false));
  const kinds = buildAssetKinds.map((kind) => (kind.kind === "data_store" ? planted : kind));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(
          TranslationProvider,
          { locale: input.locale ?? "en", children: null },
          createElement(
            BuildAssetKindsProvider,
            { value: kinds },
            createElement(
              BuildNavigationProvider,
              {
                value: {
                  location: input.list
                    ? { kindPath: "data-stores" }
                    : { kindPath: "data-stores", name: asset.name },
                  open: noop,
                  href: (place) => `/build/${place.kindPath ?? ""}/${place.name ?? ""}`
                }
              },
              createElement(BuildFrame, { source })
            )
          )
        )
      )
    );
  });
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

function buttonNamed(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === name
  );
  if (!found) throw new Error(`No button named ${name}`);
  return found;
}

describe("Publishing a Data Store", () => {
  it("asks first, with what the publish applies, and publishes only on the confirm", async () => {
    const publish = vi.fn();
    const page = await mount(draft, { publish });

    const offered = page.querySelector<HTMLButtonElement>("[data-data-store-publish]");
    await act(async () => offered?.click());
    expect(publish).not.toHaveBeenCalled();
    const question = document.querySelector("[data-data-store-publish-confirm]");
    expect(question?.textContent).toContain("creates the store's database");
    expect(question?.textContent).toContain("cannot be taken back");

    await act(async () => buttonNamed("Cancel").click());
    expect(publish).not.toHaveBeenCalled();

    await act(async () => offered?.click());
    const dialog = document.querySelector("dialog");
    const confirm = [...(dialog?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Publish"
    );
    await act(async () => confirm?.click());
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("asks in German for a German reader", async () => {
    const page = await mount(draft, { locale: "de" });
    await act(async () =>
      page.querySelector<HTMLButtonElement>("[data-data-store-publish]")?.click()
    );
    expect(document.querySelector("[data-data-store-publish-confirm]")?.textContent).toContain(
      "lässt sich nicht zurücknehmen"
    );
  });
});

describe("What the database server leaves open around a store", () => {
  it("is shown as a step to take only to the one who runs the server", async () => {
    const admin = await mount(published);
    expect(admin.querySelector("[data-data-store-condition]")).toBeNull();
    expect(admin.textContent).not.toContain("To do on the server");
    unmounts.splice(0).forEach((unmount) => unmount());

    const operator = await mount(published, { seesServerConditions: true });
    const step = operator.querySelector('[data-data-store-condition="server_databases_open"]');
    expect(step?.textContent).toContain("Close the server's other databases to this store");
    expect(step?.textContent).toContain("To do");
  });

  it("is counted on the list of stores only for the one who runs the server", async () => {
    expect((await mount(published, { list: true })).textContent).not.toContain("on the server");
    const operator = await mount(published, { list: true, seesServerConditions: true });
    expect(operator.textContent).toContain("1 to do on the server");
  });
});

describe("Who the instance shows what the server leaves open", () => {
  /** The store's page as the reader's roles open it, against the instance's own answers. */
  async function pageAs(roles: string[]): Promise<HTMLElement> {
    const statePath = apiOperations["data_stores.get"].path.replace(":store", published.name);
    const page = await mountBuildPage(
      published,
      "data-stores",
      (request, url) =>
        request.method === "GET" && url.pathname === statePath ? Response.json(state) : undefined,
      [],
      { user: settingsUser({ roles }) }
    );
    await vi.waitFor(() => expect(page.textContent).toContain("Leads"), {
      timeout: CONDITION_WAIT_MS
    });
    return page;
  }

  it("shows a superadmin the steps, and an admin of the instance none", async () => {
    const operator = await pageAs(["user", "admin", "superadmin"]);
    await vi.waitFor(
      () =>
        expect(
          operator.querySelector('[data-data-store-condition="server_databases_open"]')
        ).not.toBeNull(),
      { timeout: CONDITION_WAIT_MS }
    );
    await unmountBuildPages();

    const admin = await pageAs(["user", "admin"]);
    await vi.waitFor(() => expect(admin.textContent).toContain("Ready"), {
      timeout: CONDITION_WAIT_MS
    });
    expect(admin.querySelector("[data-data-store-condition]")).toBeNull();
  });
});
