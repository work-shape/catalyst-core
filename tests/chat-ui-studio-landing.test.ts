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
  resolveBuildRights,
  type BuildLocation,
  type BuildSource
} from "@work-shape/catalyst-chat-ui/build-area";
import { platformContext } from "./chat-ui-build-fixtures";
import { TranslationProvider } from "./chat-ui-render-harness";

// ACCEPT-1c, cosmetic: an admin's Studio opened on Connections, the kind this browser had last
// shown. Studio's own address lands on Agents, whatever was opened before.

const noop = () => undefined;

const source: BuildSource = {
  kinds: [
    { kind: "agent", canCreate: true, canDelete: true },
    { kind: "connection", canCreate: true, canDelete: true }
  ],
  rights: resolveBuildRights({ permissions: ["config_assets.write"] }, platformContext()),
  loading: false,
  error: undefined,
  reload: async () => undefined,
  useList: () => ({
    rows: [],
    error: undefined,
    hasMore: false,
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
  }
};

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

/** Shows Studio at an address and takes it down again, with every address it moved to. */
async function visit(location: BuildLocation): Promise<BuildLocation[]> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const moves: BuildLocation[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(
          TranslationProvider,
          { locale: "en", children: null },
          createElement(
            BuildAssetKindsProvider,
            { value: buildAssetKinds },
            createElement(
              BuildNavigationProvider,
              {
                value: {
                  location,
                  open: (place: BuildLocation) => moves.push(place),
                  href: (place) => `/build/${place.kindPath ?? ""}`
                }
              },
              createElement(BuildFrame, { source })
            )
          )
        )
      )
    )
  );
  await act(async () => root.unmount());
  container.remove();
  return moves;
}

describe("Studio's own address", () => {
  it("lands on Agents after Connections was open", async () => {
    expect(await visit({ kindPath: "connections" })).toEqual([]);
    expect(await visit({})).toEqual([{ kindPath: "agents" }]);
  });
});
