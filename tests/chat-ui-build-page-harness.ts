import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vitest";
import { createApiClient, type ApiUser } from "@work-shape/catalyst-api-client";
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
import { createTestConfig } from "./support/fixtures";

// The page of one asset in Build, with the platform's own kinds, against an instance whose
// answers a test gives as `fetch` answers: what the page reads is what the contract names.
// The instance has Knowledge Bases on. A request the test does not answer is refused with 404.

/** One agent field an instance may let people change. */
export type EditableAgentField =
  SettingsPageContextValue["config"]["features"]["configAssets"]["editableAgentFields"][number];

const URL_OF_INSTANCE = "https://chat.example.com";

/** What the instance answers: Knowledge Bases on. */
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

/** The kind an `assets.list` request names, or undefined for any other request. */
export function listedKind(request: Request, url: URL): string | undefined {
  if (request.method !== "GET") return undefined;
  const list = new RegExp(
    `^${apiOperations["assets.list"].path.replace(":kind", "([a-z_]+)")}$`,
    "u"
  ).exec(url.pathname);
  return list?.[1];
}

/** What a Settings or Build page knows of the instance and of its reader, a plain user unless given. */
export function buildPageSettings(
  fetchImpl: typeof fetch,
  user?: ApiUser,
  editableAgentFields: readonly EditableAgentField[] = []
): SettingsPageContextValue {
  const config = createTestConfig();
  const safeConfig = safeConfigSchema.parse(
    createSafeConfigView(
      config,
      { version: 0, agents: [], skills: [] },
      resolveInstanceModules(config, []).snapshot
    )
  );
  return {
    apiBaseUrl: URL_OF_INSTANCE,
    authScope: "build-page",
    client: createApiClient({ baseUrl: URL_OF_INSTANCE, fetchImpl }),
    user: user ?? settingsUser(),
    config: {
      ...safeConfig,
      features: {
        ...safeConfig.features,
        configAssets: {
          ...safeConfig.features.configAssets,
          editableAgentFields: [...editableAgentFields]
        }
      }
    },
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
}

const unmounts: (() => Promise<void>)[] = [];

/** Takes down every page the tests mounted. Called after each test. */
export async function unmountBuildPages(): Promise<void> {
  for (const unmount of unmounts.splice(0)) {
    await unmount();
  }
}

/**
 * Opens the page of `asset` in Build. `answer` answers what the page asks the instance for; a
 * request it leaves undefined is answered with the platform context, or refused.
 */
export async function mountBuildPage(
  asset: BuildAsset,
  kindPath: string,
  answer: (request: Request, url: URL) => Response | undefined,
  /** The agent fields the instance lets people change. */
  editableAgentFields: readonly EditableAgentField[] = [],
  /** The reader, a plain user unless given, and the instance's answer to a save. */
  reader: { user?: ApiUser; put?: BuildSource["writes"]["put"] } = {}
): Promise<HTMLElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const answered = answer(request, url);
    if (answered !== undefined) return answered;
    if (url.pathname === apiOperations["platform.context.get"].path)
      return Response.json(contextWithKnowledge());
    return Response.json({ error: { code: "NOT_FOUND", message: "none" } }, { status: 404 });
  };
  const settings = buildPageSettings(fetchImpl, reader.user, editableAgentFields);
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
      put: reader.put ?? (async () => ({ revision: 1 })),
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
  return container;
}
