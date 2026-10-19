// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { TranslationProvider } from "./chat-ui-render-harness";
import { useSubjectTitle, WorkspaceApiClientProvider } from "./support/chat-ui";
import { CONDITION_WAIT_MS } from "./support/assertions";

// STORE-PAGES: "Edit with the agent" on a Data Store or a Knowledge Base opened the dock with
// "Working on: store-pages-265be106", the store's address. The dock's head names the store by
// the title of its saved definition, as it names an agent, and by its address until that
// arrives or where the reader may not read it.

const API = "https://api.example.test";
const WORKSPACE = "ws_1";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function asset(kind: string, name: string, title: string, workspace: boolean) {
  return {
    id: `asset_${name}`,
    kind,
    name,
    title,
    scope: workspace ? { kind: "workspace", workspaceId: WORKSPACE } : { kind: "instance" },
    revision: 1,
    draftRevision: 1,
    publishedRevision: 1,
    config: { name, title },
    updatedAt: "2026-10-19T09:00:00.000Z"
  };
}

/**
 * The instance holds `held`, in the workspace where `workspace` says so; a read of any other
 * asset is refused. Every read asked is recorded by its path and workspace.
 */
function instance(held: ReturnType<typeof asset> | undefined, reads: string[]) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const workspaceId = url.searchParams.get("workspaceId");
    reads.push(`${url.pathname}${workspaceId ? `?${workspaceId}` : ""}`);
    const listPath = held && apiOperations["assets.list"].path.replace(":kind", held.kind);
    if (held && url.pathname === listPath) {
      // A list shows no definitions.
      const { config: _config, ...item } = held;
      return Response.json({ items: held.scope.kind === "workspace" ? [item] : [] });
    }
    const getPath =
      held &&
      apiOperations["assets.get"].path.replace(":kind", held.kind).replace(":name", held.name);
    const asked = held?.scope.kind === "workspace" ? workspaceId === WORKSPACE : true;
    if (held && url.pathname === getPath && asked) {
      return Response.json(held);
    }
    return Response.json(
      { error: { code: "FORBIDDEN", message: "Not yours to read" } },
      { status: 403 }
    );
  };
}

function Title({ kind, name }: { kind: string; name: string }) {
  const title = useSubjectTitle({ kind, name }, WORKSPACE);
  return createElement("span", { "data-title": "" }, title);
}

async function mount(kind: string, name: string, fetchImpl: typeof fetch): Promise<HTMLElement> {
  vi.stubGlobal("fetch", fetchImpl);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          TranslationProvider,
          { locale: "en", children: null },
          createElement(
            WorkspaceApiClientProvider,
            { apiBaseUrl: API, children: null },
            createElement(Title, { kind, name })
          )
        )
      )
    );
  });
  const shown = host.querySelector<HTMLElement>("[data-title]");
  if (shown === null) throw new Error("No title");
  return shown;
}

describe("the title of the asset a conversation is about", () => {
  it("names a workspace's Data Store by its title, read in that workspace", async () => {
    const reads: string[] = [];
    const store = asset("data_store", "store-pages-265be106", "Store page leads", true);
    const shown = await mount("data_store", store.name, instance(store, reads));
    await vi.waitFor(() => expect(shown.textContent).toBe("Store page leads"), {
      timeout: CONDITION_WAIT_MS
    });
    expect(reads).toContain(`/api/v1/assets/data_store/${store.name}?${WORKSPACE}`);
  });

  it("names an instance's Knowledge Base by its title", async () => {
    const reads: string[] = [];
    const base = asset("knowledge_base", "handbook-kb", "Handbuch", false);
    const shown = await mount("knowledge_base", base.name, instance(base, reads));
    await vi.waitFor(() => expect(shown.textContent).toBe("Handbuch"), {
      timeout: CONDITION_WAIT_MS
    });
    expect(reads).toContain("/api/v1/assets/knowledge_base/handbook-kb");
  });

  it("keeps the address of a store the reader may not read, and while it loads", async () => {
    let answer: () => void = () => undefined;
    const held = new Promise<void>((done) => {
      answer = done;
    });
    const slow: typeof fetch = async (input, init) => {
      await held;
      return instance(undefined, [])(input, init);
    };
    const shown = await mount("knowledge_base", "secret-kb", slow);
    expect(shown.textContent).toBe("secret-kb");
    await act(async () => answer());
    await act(async () => new Promise((done) => setTimeout(done, 0)));
    expect(shown.textContent).toBe("secret-kb");
  });
});
