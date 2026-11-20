// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import {
  buildAssetKinds,
  BuildAssetKindsProvider,
  isEditableKind,
  BuildFrame,
  BuildNavigationProvider,
  resolveBuildRights,
  type BuildAssetEditorProps,
  type BuildAssetRow,
  type BuildKind,
  type BuildLocation,
  type BuildSource
} from "@work-shape/catalyst-chat-ui/build-area";
import { platformContext } from "./chat-ui-build-fixtures";
import { TranslationProvider } from "./chat-ui-render-harness";

// ACCEPT-1c, cosmetic: an admin's Studio opened on Connections, the kind this browser had last
// shown. Studio's own address shows the overview, whatever was opened before: one row per kind
// the reader sees, with what the kind is for.

const noop = () => undefined;
const [agentKind] = buildAssetKinds;
if (!agentKind || agentKind.kind !== "agent" || !isEditableKind(agentKind)) {
  throw new Error("The platform's first kind is not the agent's.");
}

function agentRow(name: string): BuildAssetRow {
  return {
    id: `asset_${name}`,
    kind: "agent",
    name,
    title: name,
    scope: { kind: "instance" },
    revision: 1,
    updatedAt: "2026-10-08T10:00:00.000Z"
  };
}

/** A source with two kinds: what each list holds and what the reader may do is the test's. */
function source(
  input: {
    permissions?: string[];
    rows?: Record<string, BuildAssetRow[]>;
    hasMore?: boolean;
    buildWithAgent?: BuildSource["buildWithAgent"];
  } = {}
): BuildSource {
  const permissions = input.permissions ?? ["config_assets.write"];
  const mayCreate = permissions.includes("config_assets.write");
  return {
    kinds: [
      { kind: "agent", canCreate: mayCreate, canDelete: true },
      { kind: "connection", canCreate: mayCreate, canDelete: true }
    ],
    rights: resolveBuildRights({ permissions }, platformContext()),
    loading: false,
    error: undefined,
    reload: async () => undefined,
    useList: (kind) => ({
      rows: input.rows?.[kind] ?? [],
      error: undefined,
      hasMore: kind === "agent" && input.hasMore === true,
      loadingMore: false,
      loadMore: noop,
      retry: noop
    }),
    useAsset: () => ({ status: "loading" }),
    exists: async () => true,
    checkName: async () => ({ available: true }),
    writes: {
      put: async () => ({ revision: 1 }),
      readFiles: async () => [],
      delete: async () => undefined,
      publish: async () => ({ draftRevision: 1, publishedRevision: 1 }),
      revert: async () => ({ revision: 1 }),
      revisions: async () => ({ items: [] })
    },
    ...(input.buildWithAgent ? { buildWithAgent: input.buildWithAgent } : {})
  };
}

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/**
 * Shows Studio at an address. Answers the page, every address it moved to, and the way to take
 * it down again.
 */
async function show(
  location: BuildLocation,
  shown: BuildSource = source(),
  kinds: readonly BuildKind[] = buildAssetKinds
): Promise<{ page: HTMLElement; moves: BuildLocation[]; close(): Promise<void> }> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const moves: BuildLocation[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        createElement(
          UiRoot,
          { mode: "light", labels: uiLabelsEn },
          createElement(
            TranslationProvider,
            { locale: "en", children: null },
            createElement(
              BuildAssetKindsProvider,
              { value: kinds },
              createElement(
                BuildNavigationProvider,
                {
                  value: {
                    location,
                    open: (place: BuildLocation) => moves.push(place),
                    href: (place) => `/build/${place.kindPath ?? ""}`
                  }
                },
                createElement(BuildFrame, { source: shown })
              )
            )
          )
        )
      )
    )
  );
  return {
    page: container,
    moves,
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    }
  };
}

/** The overview's row of a kind, by the kind's path. */
function rowOf(page: HTMLElement, path: string): HTMLElement {
  const row = page.querySelector<HTMLElement>(`[data-build-overview-kind="${path}"]`);
  if (!row) throw new Error(`The overview has no row for ${path}.`);
  return row;
}

describe("Studio's own address", () => {
  it("shows the overview after Connections was open, and moves nowhere", async () => {
    const list = await show({ kindPath: "connections" });
    expect(list.moves).toEqual([]);
    expect(list.page.querySelector("[data-build-overview]")).toBeNull();
    await list.close();

    const studio = await show({});
    expect(studio.moves).toEqual([]);
    expect(studio.page.querySelector("h1")?.textContent).toBe("Overview");
    expect(studio.page.querySelectorAll("[data-build-overview-kind]")).toHaveLength(2);
    await studio.close();
  });

  it("corrects the address of a kind the reader has no item for to Studio's own", async () => {
    const stray = await show({ kindPath: "skills" });
    expect(stray.moves).toEqual([{}]);
    expect(stray.page.querySelector("[data-build-overview]")).not.toBeNull();
    await stray.close();
  });
});

describe("Studio overview", () => {
  it("says what each kind is for and links to its list, with a count only above zero", async () => {
    const { page, close } = await show(
      {},
      source({ rows: { agent: [agentRow("one"), agentRow("two")] } })
    );
    const agents = rowOf(page, "agents");
    const connections = rowOf(page, "connections");

    expect(agents.textContent).toContain("Agents");
    expect(agents.textContent).toContain(
      "Agents answer questions and get tasks done for your team."
    );
    expect(agents.querySelector("a")?.getAttribute("href")).toBe("/build/agents");
    expect(agents.querySelector("[data-build-overview-count]")?.textContent).toBe("2");
    expect(connections.textContent).toContain("Connections give agents access");
    expect(connections.querySelector("a")?.getAttribute("href")).toBe("/build/connections");
    expect(connections.querySelector("[data-build-overview-count]")).toBeNull();
    // Something is built: no row offers a first step.
    expect(page.querySelector("[data-build-overview-first]")).toBeNull();
    expect(page.textContent).toContain("Here you build what your team works with in chat.");
    await close();
  });

  it("says that a list holds more than its first read counted", async () => {
    const { page, close } = await show(
      {},
      source({ rows: { agent: [agentRow("one"), agentRow("two")] }, hasMore: true })
    );
    expect(rowOf(page, "agents").querySelector("[data-build-overview-count]")?.textContent).toBe(
      "2+"
    );
    await close();
  });

  it("keeps the overview first in the rail", async () => {
    const { page, close } = await show({});
    const options = [...page.querySelectorAll("option")].map((option) => option.textContent);
    expect(options.slice(0, 2)).toEqual(["Overview", "Agents"]);
    await close();
  });

  it("offers New to a reader who may create, and nothing to start to one who may not", async () => {
    const writer = await show({}, source({ rows: { agent: [agentRow("one")] } }));
    expect(writer.page.querySelector("[data-build-overview-new]")?.textContent).toBe("New");
    await writer.close();

    const reader = await show({}, source({ permissions: ["config_assets.read"] }));
    expect(reader.page.querySelectorAll("[data-build-overview-kind]")).toHaveLength(2);
    expect(reader.page.querySelector("[data-build-overview-new]")).toBeNull();
    // Nothing is built, and this reader may build nothing: no first step is offered.
    expect(reader.page.querySelector("[data-build-overview-first]")).toBeNull();
    expect(reader.page.textContent).not.toContain("Nothing is built yet.");
    await reader.close();
  });

  it("offers the first step in the first row while nothing is built, and starts it there", async () => {
    const { page, moves, close } = await show({});
    expect(page.textContent).toContain("Nothing is built yet. Most people start with an agent.");
    const first = page.querySelector<HTMLElement>("[data-build-overview-first]");
    expect(first?.textContent).toBe("New agent");
    expect(first?.closest("[data-build-overview-kind]")).toBe(rowOf(page, "agents"));

    await act(async () => first?.click());
    // The kind's list starts the agent, as its own New button does.
    expect(moves).toEqual([{ kindPath: "agents" }]);
    await close();

    // The agent's form reads the instance's configuration from Settings: a plain body stands in.
    const list = await show({ kindPath: "agents" }, source(), [
      {
        ...agentKind,
        Editor: ({ start }: BuildAssetEditorProps) =>
          createElement("p", { "data-new-agent": "" }, `new agent ${start?.name ?? ""}`)
      }
    ]);
    expect(list.page.querySelector("[data-new-agent]")).not.toBeNull();
    await list.close();

    // The request was taken: the list opens as a list again.
    const again = await show({ kindPath: "agents" }, source(), [agentKind]);
    expect(again.page.querySelector("h1")?.textContent).toBe("Agents");
    await again.close();
  });
});
