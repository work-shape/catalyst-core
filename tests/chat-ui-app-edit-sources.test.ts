// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { TranslationProvider } from "@work-shape/catalyst-chat-ui";
import {
  AppEdit,
  AppsHostProvider,
  resolveAppRights,
  type AppsHost
} from "@work-shape/catalyst-chat-ui/apps";
import { WorkspaceApiClientProvider } from "@work-shape/catalyst-chat-ui/workspace-api-client";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { appsContext } from "./chat-ui-build-fixtures";
import { CONDITION_WAIT_MS } from "./support/assertions";
import { workspaceQueryKeys } from "./support/chat-ui";

// DAILY-WINS 7: the draft of an App says where its data comes from. The instance reads the
// sources of a published App only, so a draft never published asks nothing and shows nothing,
// not even lines cached for the same name.

const API = "https://chat.example.com";
const WORKSPACE = "cw_open";
const SOURCES_PATH = apiOperations["data_stores.app_sources"].path;
const RECORD_PATH = apiOperations["assets.get"].path
  .replace(":kind", "app")
  .replace(":name", "fees");
const SOURCES_KEY = [
  ...workspaceQueryKeys.assets(API, "standalone"),
  "app",
  "data-sources",
  "fees"
];
const LABEL = '[aria-label="Where the data comes from"]';

const sources = {
  stores: [
    {
      name: "kunden",
      title: "Kunden",
      fillers: [{ kind: "workflow", name: "import", title: "Nachtimport", connections: ["CRM"] }]
    }
  ],
  truncated: false
};

function record(publishedRevision: number | undefined) {
  return {
    id: "asset_1",
    kind: "app",
    name: "fees",
    scope: { kind: "workspace", workspaceId: WORKSPACE },
    revision: 3,
    draftRevision: 3,
    ...(publishedRevision === undefined ? {} : { publishedRevision }),
    config: { title: "Fees" },
    allowed: ["read", "write", "publish"],
    updatedAt: "2026-10-17T09:00:00.000Z"
  };
}

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});

/** Mounts the draft of `fees` and counts what it asks of the sources. */
async function mountDraft(publishedRevision: number | undefined, cached = false) {
  const sourceReads: string[] = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === RECORD_PATH) return Response.json(record(publishedRevision));
    if (url.pathname === SOURCES_PATH) {
      sourceReads.push(url.search);
      return publishedRevision === undefined
        ? Response.json({ error: { code: "NOT_FOUND", message: "none" } }, { status: 404 })
        : Response.json(sources);
    }
    return Response.json({ error: { code: "NOT_FOUND", message: "none" } }, { status: 404 });
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // An answer read earlier for the same name, as when an App was published and then removed.
  if (cached) queryClient.setQueryData(SOURCES_KEY, sources);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const host: AppsHost = {
    enabled: true,
    rights: resolveAppRights(
      appsContext({ [WORKSPACE]: ["app.read", "app.write", "app.publish"] }),
      WORKSPACE
    ),
    workspace: { id: WORKSPACE, name: "Office" },
    showRoute: () => undefined,
    startChat: () => undefined
  };
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          WorkspaceApiClientProvider,
          { apiBaseUrl: API, children: null },
          createElement(
            AppsHostProvider,
            { value: host, children: null },
            createElement(
              TranslationProvider,
              { locale: "en", children: null },
              createElement(
                UiRoot,
                { mode: "light", labels: uiLabelsEn },
                createElement(AppEdit, { app: "fees" })
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
  return { container, sourceReads };
}

/** Waits until the draft's head stands, which names whether it is published. */
async function headShown(container: HTMLElement) {
  await vi.waitFor(
    () => expect(container.querySelector('[data-testid="app-draft-line"]')).not.toBeNull(),
    { timeout: CONDITION_WAIT_MS }
  );
}

describe("where the data of an App draft comes from", () => {
  it("asks nothing of a draft never published, and shows no lines cached for its name", async () => {
    const { container, sourceReads } = await mountDraft(undefined, true);
    await headShown(container);
    expect(container.textContent).toContain("Not published yet");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(sourceReads).toEqual([]);
    expect(container.querySelector(LABEL)).toBeNull();
  });

  it("reads the sources of a published App and offers them in the draft's head", async () => {
    const { container, sourceReads } = await mountDraft(2);
    await headShown(container);
    await vi.waitFor(() => expect(container.querySelector(LABEL)).not.toBeNull(), {
      timeout: CONDITION_WAIT_MS
    });
    expect(sourceReads).toEqual(["?app=fees"]);
  });
});
