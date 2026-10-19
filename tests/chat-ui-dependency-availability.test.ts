// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient, type AgentDraft } from "@work-shape/catalyst-api-client";
import { apiOperations, safeConfigSchema } from "@work-shape/catalyst-api-contract";
import { DocsAddressProvider, UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import {
  AgentEditor,
  agentConfigToForm,
  BuildNavigationProvider,
  ConnectionEditor,
  useAvailabilityChoice,
  type AgentDraftSource,
  type AvailabilityChoice,
  type BuildAssetEditorProps,
  type ConnectionSource
} from "@work-shape/catalyst-chat-ui/build-area";
import { resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import { createSafeConfigView } from "@work-shape/catalyst-config-schema";
import {
  SettingsPageProvider,
  type SettingsPageContextValue
} from "@work-shape/catalyst-chat-ui/settings-page-context";
import { connectionAsset, connectionDetail } from "./chat-ui-connection-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { personalWorkspace, settingsUser } from "./chat-ui-settings-fixtures";
import { CONDITION_WAIT_MS, required } from "./support/assertions";
import { createTestConfig } from "./support/fixtures";

// AVAIL-1: Knowledge Bases and Connections are made available per workspace as agents are, and
// an agent's publish and its availability say what the agent uses that members in its
// workspaces could not use. Who may make all of it available is offered one unticked choice;
// anybody else reads whom to ask, and no link to the settings of what is missing.

const noop = () => undefined;
/** Where the instance answers one asset, and sets where it is available. */
const assetPath = (kind: string) =>
  apiOperations["assets.get"].path.replace(":kind", kind).replace(":name", "subject");
const availabilityPath = (kind: string) =>
  apiOperations["assets.set_availability"].path.replace(":kind", kind).replace(":name", "subject");
const URL_OF_INSTANCE = "https://chat.example.com";
const config = { name: "assistant", displayName: "Assistant", instructions: "Help the user." };
const workspaces = [{ id: "ws_sales", name: "Sales", createdAt: "2026-06-27T00:00:00.000Z" }];
const contracts = {
  kind: "knowledge_base" as const,
  name: "kb_contracts",
  displayName: "Contracts",
  canMakeAvailable: true
};
const hubspot = {
  kind: "connection" as const,
  name: "hubspot",
  displayName: "HubSpot",
  canMakeAvailable: true
};

function frame(overrides: Partial<BuildAssetEditorProps> = {}): BuildAssetEditorProps {
  return {
    page: { ref: { current: null }, above: null, shown: noop },
    asset: {
      id: "asset_agent",
      kind: "agent",
      name: config.name,
      scope: { kind: "instance" },
      revision: 3,
      config,
      updatedAt: "2026-10-08T10:00:00.000Z"
    },
    start: undefined,
    canWrite: true,
    canPublish: true,
    instanceWrite: true,
    back: null,
    actions: {},
    notice: null,
    onUnsavedChange: noop,
    save: async () => ({ ok: true }),
    ...overrides
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function mount(node: ReactNode, queryClient = new QueryClient()) {
  act(() =>
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(
            TranslationProvider,
            { locale: "en", children: null },
            createElement(DocsAddressProvider, { address: undefined, children: node })
          )
        )
      )
    )
  );
}

/** A button anywhere in the document, a dialog's included, by its text. */
function button(text: string, within: ParentNode = document): HTMLButtonElement {
  const found = [...within.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text
  );
  if (!found) throw new Error(`no button "${text}": ${document.body.innerHTML}`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

const missingBanner = () => document.querySelector("[data-missing-dependencies]");
const makeAvailableBox = () =>
  missingBanner()?.querySelector<HTMLButtonElement>('button[role="checkbox"]') ?? null;

describe("publishing an agent that uses what its workspaces lack", () => {
  /** The agent page with a draft whose read again names what is missing. */
  function mountDraft(dependencyAvailability: AgentDraft["dependencyAvailability"]) {
    const draft: AgentDraft = {
      agent: "assistant",
      revision: 4,
      baseRevision: 3,
      liveRevision: 3,
      stale: false,
      config,
      author: { userId: "user_me", name: "Me", release: false },
      updatedAt: "2026-10-19T09:00:00.000Z"
    };
    const decided: unknown[][] = [];
    const reads = { count: 0 };
    function Page() {
      // The page's own save left a draft the instance told nothing about; Publish reads it again.
      const [latest, setLatest] = useState<AgentDraft | null>(draft);
      const source: AgentDraftSource = {
        latest,
        reread: async () => {
          reads.count += 1;
          setLatest({
            ...draft,
            ...(dependencyAvailability === undefined ? {} : { dependencyAvailability })
          });
        },
        saved: () => draft,
        decide: async (...args) => {
          decided.push(args);
        },
        busy: undefined,
        answerFor: () => undefined
      };
      return createElement(AgentEditor, {
        frame: frame(),
        initialForm: agentConfigToForm(config),
        isDefault: false,
        references: undefined,
        editableAgentFields: ["instructions"],
        canManageAgentModels: false,
        skillChoice: { options: [], onSearch: noop },
        draft: source
      });
    }
    mount(createElement(Page));
    return { decided, reads };
  }

  async function openPublish() {
    const publish = required(document.querySelector<HTMLButtonElement>("[data-agent-publish]"));
    await click(publish);
    const dialog = await vi.waitFor(() => required(document.querySelector("dialog[open]")), {
      timeout: CONDITION_WAIT_MS
    });
    return dialog;
  }

  it("reads the draft again and offers whoever may make all of it available one unticked choice", async () => {
    const reviewed = {
      mode: "selected" as const,
      personalWorkspaces: false,
      collaborationWorkspaceIds: ["ws_sales"]
    };
    const page = mountDraft({
      missing: [contracts, hubspot],
      administrators: ["Ana Admin"],
      availability: reviewed
    });
    const dialog = await openPublish();
    await vi.waitFor(() => expect(missingBanner()).not.toBeNull(), { timeout: CONDITION_WAIT_MS });

    expect(page.reads.count).toBe(1);
    const items = [...required(missingBanner()).querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toEqual(["Contracts (knowledge base)", "HubSpot (connection)"]);
    expect(makeAvailableBox()?.getAttribute("aria-checked")).toBe("false");
    expect(missingBanner()?.textContent).not.toContain("Ana Admin");

    await click(required(makeAvailableBox()));
    await click(button("Publish", dialog));
    // The instance makes it available where the agent was when the list was read, or refuses.
    expect(page.decided).toEqual([
      ["publish", 4, { makeDependenciesAvailable: true, expectedAvailability: reviewed }]
    ]);
  });

  it("publishes without making anything available when the choice stays unticked", async () => {
    const page = mountDraft({ missing: [contracts], administrators: [] });
    const dialog = await openPublish();
    await vi.waitFor(() => expect(makeAvailableBox()).not.toBeNull(), {
      timeout: CONDITION_WAIT_MS
    });

    await click(button("Publish", dialog));
    expect(page.decided).toEqual([
      ["publish", 4, { makeDependenciesAvailable: false, expectedAvailability: null }]
    ]);
  });

  it("names the admins to ask, with no choice and no link, where one of them may not be made available", async () => {
    mountDraft({
      missing: [contracts, { ...hubspot, canMakeAvailable: false }],
      administrators: ["Ana Admin", "Ben Boss"]
    });
    await openPublish();
    await vi.waitFor(() => expect(missingBanner()).not.toBeNull(), { timeout: CONDITION_WAIT_MS });

    const banner = required(missingBanner());
    expect(banner.textContent).toContain("Ask Ana Admin or Ben Boss to make them available.");
    expect(makeAvailableBox()).toBeNull();
    expect(banner.querySelector("a")).toBeNull();
  });

  it("asks for an instance admin where the instance names none", async () => {
    mountDraft({ missing: [{ ...contracts, canMakeAvailable: false }], administrators: [] });
    await openPublish();
    await vi.waitFor(() => expect(missingBanner()).not.toBeNull(), { timeout: CONDITION_WAIT_MS });

    expect(missingBanner()?.textContent).toContain("Ask an instance admin to make them available.");
  });

  it("says nothing where nothing is missing", async () => {
    const page = mountDraft({ missing: [], administrators: ["Ana Admin"] });
    await openPublish();
    await vi.waitFor(() => expect(page.reads.count).toBe(1), { timeout: CONDITION_WAIT_MS });

    expect(missingBanner()).toBeNull();
  });
});

describe("saving where an agent is available", () => {
  function mountAvailability(missing = [contracts]) {
    const previews: unknown[] = [];
    const saves: unknown[][] = [];
    const choice: AvailabilityChoice = {
      saved: { mode: "selected", personalWorkspaces: false, collaborationWorkspaceIds: [] },
      workspaces,
      dependencies: {
        key: ["test-dependencies"],
        read: async (form) => {
          previews.push(form);
          return { missing, administrators: ["Ana Admin"] };
        }
      },
      save: async (...args) => {
        saves.push(args);
        return undefined;
      }
    };
    mount(
      createElement(AgentEditor, {
        frame: frame(),
        initialForm: agentConfigToForm(config),
        isDefault: false,
        references: undefined,
        editableAgentFields: [],
        canManageAgentModels: false,
        skillChoice: { options: [], onSearch: noop },
        availability: choice
      })
    );
    return { previews, saves };
  }

  const radio = (label: string) =>
    required(
      [...host.querySelectorAll<HTMLButtonElement>('button[role="radio"]')].find((candidate) =>
        candidate.closest("label, div")?.textContent?.includes(label)
      )
    );

  it("reads what the change leaves missing, before anything is saved, and saves with the choice", async () => {
    const page = mountAvailability();
    expect(missingBanner()).toBeNull();

    await click(radio("All workspaces"));
    await vi.waitFor(() => expect(makeAvailableBox()).not.toBeNull(), {
      timeout: CONDITION_WAIT_MS
    });
    expect(page.previews).toEqual([
      { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] }
    ]);

    await click(required(makeAvailableBox()));
    await click(button("Save changes"));
    await vi.waitFor(() => expect(page.saves).toHaveLength(1), { timeout: CONDITION_WAIT_MS });
    expect(page.saves[0]).toEqual([
      { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] },
      { makeDependenciesAvailable: true }
    ]);
  });

  it("clears the choice when the availability changes again", async () => {
    mountAvailability();
    await click(radio("All workspaces"));
    await vi.waitFor(() => expect(makeAvailableBox()).not.toBeNull(), {
      timeout: CONDITION_WAIT_MS
    });
    await click(required(makeAvailableBox()));
    expect(makeAvailableBox()?.getAttribute("aria-checked")).toBe("true");

    await click(radio("Selected workspaces"));
    await click(
      required(
        [...host.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')].find((box) =>
          box.closest("label, div")?.textContent?.includes("Sales")
        )
      )
    );
    await vi.waitFor(() => expect(makeAvailableBox()).not.toBeNull(), {
      timeout: CONDITION_WAIT_MS
    });
    expect(makeAvailableBox()?.getAttribute("aria-checked")).toBe("false");
  });
});

describe("where agents can use a Connection", () => {
  const connections: ConnectionSource = {
    mayTest: () => true,
    useDetail: (name) => ({ status: "ready", detail: connectionDetail(name) }),
    useTest: () => ({ run: { status: "idle" }, start: noop }),
    useHolders: () => ({ status: "hidden" }),
    setSecret: async () => undefined,
    discover: async () => undefined,
    readDetail: async (name) => connectionDetail(name),
    test: async () => {
      throw new Error("This test runs no test.");
    },
    principalHref: (id) => `/principals/${id}`,
    oauthStart: async () => {
      throw new Error("This test signs nothing in.");
    }
  };

  function page(useAvailability?: ConnectionSource["useAvailability"]) {
    const asset = connectionAsset();
    return renderToStaticMarkup(
      createElement(TranslationProvider, {
        locale: "de",
        children: createElement(BuildNavigationProvider, {
          value: { location: { kindPath: "connections" }, open: noop, href: () => "/build" },
          children: createElement(ConnectionEditor, {
            frame: frame({ asset }),
            source: { ...connections, ...(useAvailability ? { useAvailability } : {}) }
          })
        })
      })
    );
  }

  it("is a section of the Connection page that says members only use it", () => {
    const markup = page(() => ({
      saved: { mode: "selected", personalWorkspaces: false, collaborationWorkspaceIds: [] },
      workspaces,
      save: async () => undefined
    }));
    const section = /<section[^>]*id="availability">.*?<\/form>/su.exec(markup)?.[0] ?? "";

    expect(section).toContain("Verfügbar in");
    expect(section).toContain("weder Einstellungen noch Schlüssel sehen");
    expect(section).toContain(
      "Ohne Auswahl können Agenten sie in keinem Arbeitsbereich verwenden."
    );
    // Nothing changed yet: no save of its own and no missing list.
    expect(section).not.toContain("Änderungen speichern");
    expect(section).not.toContain("data-missing-dependencies");
  });

  it("is not on the page of a reader who may not change it", () => {
    expect(page(() => undefined)).not.toContain('id="availability"');
    expect(page()).not.toContain('id="availability"');
  });
});

describe("what the page asks of the instance", () => {
  /**
   * The page's availability of one asset. `held` is what the reader holds: the right to change
   * all of the instance's assets, and what the instance's read of the asset says the reader may
   * set, where it says anything.
   */
  async function mountChoice(
    kind: "agent" | "knowledge_base" | "connection",
    held: { instanceWrite: boolean; canSetAvailability?: boolean } = { instanceWrite: true }
  ) {
    const requests: { method: string; url: URL; body: unknown }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        url,
        body: request.method === "GET" ? undefined : await request.json()
      });
      if (url.pathname === availabilityPath(kind)) {
        return Response.json({
          mode: "all",
          personalWorkspaces: false,
          collaborationWorkspaceIds: []
        });
      }
      if (url.pathname === apiOperations["instance.workspaces.list"].path) {
        return Response.json({ items: [] });
      }
      return Response.json({
        id: "asset_1",
        kind,
        name: "subject",
        scope: { kind: "instance" },
        revision: 1,
        config: {},
        dependencyAvailability: { missing: [contracts], administrators: [] },
        updatedAt: "2026-10-19T09:00:00.000Z"
      });
    };
    const testConfig = createTestConfig();
    const settings: SettingsPageContextValue = {
      apiBaseUrl: URL_OF_INSTANCE,
      authScope: "avail-test",
      client: createApiClient({ baseUrl: URL_OF_INSTANCE, fetchImpl }),
      user: settingsUser(),
      config: safeConfigSchema.parse(
        createSafeConfigView(
          testConfig,
          { version: 0, agents: [], skills: [] },
          resolveInstanceModules(testConfig, []).snapshot
        )
      ),
      locales: ["en", "de"],
      locale: "en",
      selectLocale: noop,
      showContextIndicator: false,
      setShowContextIndicator: noop,
      themePreference: "light",
      selectThemePreference: noop,
      workspace: undefined,
      activeWorkspace: personalWorkspace(),
      onAccountDeleted: noop,
      onWorkspaceLeft: noop,
      onWorkspaceDeleted: noop
    };
    const seen: { choice: AvailabilityChoice | undefined } = { choice: undefined };
    function Probe() {
      seen.choice = useAvailabilityChoice(
        {
          asset: {
            id: "asset_1",
            kind,
            name: "subject",
            scope: { kind: "instance" },
            revision: 7,
            config: {},
            availability: {
              mode: "selected",
              personalWorkspaces: false,
              collaborationWorkspaceIds: []
            },
            ...(held.canSetAvailability === undefined
              ? {}
              : { canSetAvailability: held.canSetAvailability }),
            updatedAt: "2026-10-19T09:00:00.000Z"
          },
          instanceWrite: held.instanceWrite
        },
        kind
      );
      return null;
    }
    mount(
      createElement(SettingsPageProvider, { value: settings, children: createElement(Probe) }),
      new QueryClient({ defaultOptions: { queries: { retry: false } } })
    );
    return {
      get choice() {
        return required(seen.choice);
      },
      offered: seen.choice !== undefined,
      requests
    };
  }

  const all = { mode: "all" as const, personalWorkspaces: false, collaborationWorkspaceIds: [] };
  const availabilityWrites = (requests: { method: string; url: URL; body: unknown }[]) =>
    requests.filter((request) => request.method === "PUT");

  // Whoever manages only Connections, or only Knowledge Bases, holds no right on all of the
  // instance's assets; the instance's read of the asset says that reader may set it.
  it.each(["knowledge_base", "connection"] as const)(
    "offers a %s's availability to whom the instance lets set it, and lists the workspaces",
    async (kind) => {
      const page = await mountChoice(kind, { instanceWrite: false, canSetAvailability: true });
      expect(page.offered).toBe(true);
      await vi.waitFor(
        () =>
          expect(
            page.requests.some(
              (request) => request.url.pathname === apiOperations["instance.workspaces.list"].path
            )
          ).toBe(true),
        { timeout: CONDITION_WAIT_MS }
      );
      await act(async () => {
        await page.choice.save(all, { makeDependenciesAvailable: false });
      });
      expect(availabilityWrites(page.requests)[0]?.url.pathname).toBe(availabilityPath(kind));
    }
  );

  it("follows the instance over the right on all assets where it says the reader may not set it", async () => {
    const page = await mountChoice("connection", {
      instanceWrite: true,
      canSetAvailability: false
    });
    expect(page.offered).toBe(false);
    expect(
      page.requests.some(
        (request) => request.url.pathname === apiOperations["instance.workspaces.list"].path
      )
    ).toBe(false);
  });

  it("falls back to the right on all assets where the instance says nothing", async () => {
    expect((await mountChoice("knowledge_base", { instanceWrite: false })).offered).toBe(false);
    expect((await mountChoice("knowledge_base", { instanceWrite: true })).offered).toBe(true);
  });

  it("sets a Knowledge Base's availability under its own kind, never with its dependencies", async () => {
    const { choice, requests } = await mountChoice("knowledge_base");
    expect(choice.dependencies).toBeUndefined();

    await act(async () => {
      expect(await choice.save(all, { makeDependenciesAvailable: true })).toBeUndefined();
    });
    const [write] = availabilityWrites(requests);
    expect(write?.url.pathname).toBe(availabilityPath("knowledge_base"));
    expect(write?.body).not.toHaveProperty("makeDependenciesAvailable");
    expect(write?.body).not.toHaveProperty("expectedRevision");
  });

  it("sets a Connection's availability under its own kind", async () => {
    const { choice, requests } = await mountChoice("connection");
    await act(async () => {
      await choice.save(all, { makeDependenciesAvailable: false });
    });
    expect(availabilityWrites(requests)[0]?.url.pathname).toBe(availabilityPath("connection"));
  });

  it("sends an agent's choice with its availability, and only when it was made", async () => {
    const { choice, requests } = await mountChoice("agent");
    await act(async () => {
      await choice.save(all, { makeDependenciesAvailable: false });
    });
    await act(async () => {
      await choice.save(all, { makeDependenciesAvailable: true });
    });
    const [left, made] = availabilityWrites(requests);
    expect(left?.body).not.toHaveProperty("makeDependenciesAvailable");
    // Both name the live revision read, so a publish beside them that added a dependency
    // makes the instance refuse rather than leave it missing.
    expect(left?.body).toMatchObject({ expectedRevision: 7 });
    expect(made?.body).toMatchObject({
      mode: "all",
      makeDependenciesAvailable: true,
      expectedRevision: 7
    });
  });

  it("asks what an agent's unsaved availability leaves missing through its read", async () => {
    const { choice, requests } = await mountChoice("agent");
    const dependencies = required(choice.dependencies);
    const answer = await dependencies.read(
      { mode: "selected", personalWorkspaces: true, collaborationWorkspaceIds: ["ws_a", "ws_b"] },
      new AbortController().signal
    );

    expect(answer).toEqual({ missing: [contracts], administrators: [] });
    const read = required(requests.find((request) => request.url.pathname === assetPath("agent")));
    expect(Object.fromEntries(read.url.searchParams)).toEqual({
      availabilityMode: "selected",
      availabilityPersonalWorkspaces: "true",
      availabilityWorkspaceIds: "ws_a,ws_b"
    });
  });
});
