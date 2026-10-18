// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "@work-shape/catalyst-api-client";
import { apiOperations, safeConfigSchema } from "@work-shape/catalyst-api-contract";
import {
  buildAssetKinds,
  BuildAssetKindsProvider,
  BuildFrame,
  BuildNavigationProvider,
  resolveBuildRights,
  type BuildAsset,
  type BuildSource
} from "@work-shape/catalyst-chat-ui/build-area";
import {
  SettingsPageProvider,
  type SettingsPageContextValue
} from "@work-shape/catalyst-chat-ui/settings-page-context";
import { resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import { createSafeConfigView } from "@work-shape/catalyst-config-schema";
import { DocsAddressProvider, UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { platformContext } from "./chat-ui-build-fixtures";
import { TranslationProvider } from "./chat-ui-render-harness";
import { personalWorkspace, settingsUser } from "./chat-ui-settings-fixtures";
import { CONDITION_WAIT_MS } from "./support/assertions";
import { createTestConfig } from "./support/fixtures";

// UI-FIX-1: an asset names Knowledge Bases and Data Stores of its own owner and of the
// instance, as an agent names skills. The choosers of the agent page and of the Knowledge Base
// page ask the instance for both, and for no other workspace; an asset of the instance asks
// for the instance's own alone. The instance still decides each reference when it is saved.

const URL_OF_INSTANCE = "https://chat.example.com";
const OWNER = "cw_owner";

/** What the instance answers: Knowledge Bases on, and an empty list for every kind. */
function contextWithKnowledge() {
  const base = platformContext();
  return {
    ...base,
    kinds: [
      ...base.kinds,
      {
        kind: "knowledge_base",
        plural: "knowledge_bases",
        lifecycle: "active" as const,
        representation: "config" as const,
        owners: ["instance" as const, "workspace" as const],
        actions: {
          read: "knowledge_base.read",
          write: "knowledge_base.write",
          delete: "knowledge_base.delete"
        }
      }
    ]
  };
}

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) {
    await unmount();
  }
});

/**
 * Opens the page of `asset` in Build with the platform's own kinds, against an instance that
 * records each list it is asked for: the kind, and the workspace the list names.
 */
async function openPage(asset: BuildAsset, kindPath: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const lists: { kind: string; workspaceId: string | null }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === apiOperations["platform.context.get"].path)
      return Response.json(contextWithKnowledge());
    const list = new RegExp(
      `^${apiOperations["assets.list"].path.replace(":kind", "([a-z_]+)")}$`,
      "u"
    ).exec(url.pathname);
    if (list && request.method === "GET") {
      lists.push({ kind: list[1] ?? "", workspaceId: url.searchParams.get("workspaceId") });
      return Response.json({ items: [] });
    }
    return Response.json({ error: { code: "NOT_FOUND", message: "none" } }, { status: 404 });
  };
  const config = createTestConfig();
  const settings: SettingsPageContextValue = {
    apiBaseUrl: URL_OF_INSTANCE,
    authScope: "reference-choices",
    client: createApiClient({ baseUrl: URL_OF_INSTANCE, fetchImpl }),
    user: settingsUser(),
    config: safeConfigSchema.parse(
      createSafeConfigView(
        config,
        { version: 0, agents: [], skills: [] },
        resolveInstanceModules(config, []).snapshot
      )
    ),
    locales: ["en", "de"],
    locale: "en",
    selectLocale: () => undefined,
    showContextIndicator: false,
    setShowContextIndicator: () => undefined,
    themePreference: "light",
    selectThemePreference: () => undefined,
    workspace: undefined,
    // The workspace the reader works in is another than the asset's owner.
    activeWorkspace: personalWorkspace(),
    onAccountDeleted: () => undefined,
    onWorkspaceLeft: () => undefined,
    onWorkspaceDeleted: () => undefined
  };
  const source: BuildSource = {
    kinds: [{ kind: asset.kind, canCreate: true, canDelete: true }],
    rights: resolveBuildRights({ permissions: ["config_assets.write"] }, platformContext()),
    loading: false,
    error: undefined,
    reload: async () => undefined,
    useList: () => ({
      rows: [],
      error: undefined,
      hasMore: false,
      loadingMore: false,
      loadMore: () => undefined,
      retry: () => undefined
    }),
    useAsset: () => ({ status: "ready", asset, loadedAt: 1, reload: async () => "loaded" }),
    exists: async () => true,
    checkName: async () => ({ available: true }),
    writes: {
      put: async () => ({ revision: 1 }),
      readFiles: async () => [],
      delete: async () => undefined,
      publish: async () => ({ draftRevision: 1, publishedRevision: 1 }),
      revert: async () => ({ revision: 1 }),
      revisions: async () => ({ items: [] })
    }
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          SettingsPageProvider,
          { value: settings },
          createElement(
            UiRoot,
            { mode: "light", labels: uiLabelsEn },
            createElement(
              TranslationProvider,
              { locale: "en", children: null },
              createElement(
                DocsAddressProvider,
                { address: undefined, children: null },
                createElement(
                  BuildAssetKindsProvider,
                  { value: buildAssetKinds },
                  createElement(
                    BuildNavigationProvider,
                    {
                      value: {
                        location: { kindPath, name: asset.name },
                        open: () => undefined,
                        href: (place) => `/build/${place.kindPath ?? ""}/${place.name ?? ""}`
                      }
                    },
                    createElement(BuildFrame, { source })
                  )
                )
              )
            )
          )
        )
      )
    );
  });
  unmounts.push(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
  });
  /** The owners the lists of one kind were asked for, once the page has asked for them. */
  return async (kind: string, count: number) => {
    await vi.waitFor(
      () => expect(lists.filter((list) => list.kind === kind).length).toBeGreaterThanOrEqual(count),
      { timeout: CONDITION_WAIT_MS }
    );
    return [...new Set(lists.filter((list) => list.kind === kind).map((list) => list.workspaceId))];
  };
}

function agent(owner: string | undefined): BuildAsset {
  return {
    id: "asset_assistant",
    kind: "agent",
    name: "assistant",
    scope: owner === undefined ? { kind: "instance" } : { kind: "workspace", workspaceId: owner },
    revision: 3,
    config: { name: "assistant", displayName: "Assistant", instructions: "Help." },
    allowed: ["write"],
    updatedAt: "2026-10-17T01:00:00.000Z"
  };
}

function knowledgeBase(owner: string | undefined): BuildAsset {
  return {
    id: "asset_findings",
    kind: "knowledge_base",
    name: "findings-kb",
    scope: owner === undefined ? { kind: "instance" } : { kind: "workspace", workspaceId: owner },
    revision: 2,
    draftRevision: 2,
    config: {
      name: "findings-kb",
      title: "Findings",
      methods: ["structured"],
      backend: { dataStore: "findings" },
      tables: []
    },
    allowed: ["write"],
    updatedAt: "2026-10-13T10:00:00.000Z"
  };
}

describe("the Knowledge Bases an agent may name", () => {
  it("are asked for in the agent's workspace and on the instance, and nowhere else", async () => {
    const owners = await openPage(agent(OWNER), "agents");
    expect((await owners("knowledge_base", 2)).sort()).toEqual([OWNER, null].sort());
  });

  it("are asked for on the instance alone for an agent of the instance", async () => {
    const owners = await openPage(agent(undefined), "agents");
    expect(await owners("knowledge_base", 1)).toEqual([null]);
  });
});

describe("the Data Stores a Knowledge Base may read", () => {
  it("are asked for in its workspace and on the instance, and nowhere else", async () => {
    const owners = await openPage(knowledgeBase(OWNER), "knowledge-bases");
    expect((await owners("data_store", 2)).sort()).toEqual([OWNER, null].sort());
  });

  it("are asked for on the instance alone for a Knowledge Base of the instance", async () => {
    const owners = await openPage(knowledgeBase(undefined), "knowledge-bases");
    expect(await owners("data_store", 1)).toEqual([null]);
  });
});
