import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  buildAssetKinds,
  BuildAssetKindsProvider,
  BuildFrame,
  BuildNavigationProvider,
  GuardrailPage,
  resolveBuildRights,
  type BuildAsset,
  type BuildListedKind,
  type BuildSource
} from "@vivd-catalyst/chat-ui/build-area";
import { platformContext } from "./chat-ui-build-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// Independent verification of EW-6a (platform PR 67): the Guardrail page now shows
// guardrails written as assets, some owned by one workspace.

const listed = buildAssetKinds.find((kind) => kind.kind === "guardrail");
if (!listed || listed.Editor !== undefined) throw new Error("no listed guardrail kind");
const guardrailKind: BuildListedKind = listed;
const noop = () => undefined;

const workspaceGuardrail: BuildAsset = {
  id: "asset_sales",
  kind: "guardrail",
  name: "sales-iban",
  scope: { kind: "workspace", workspaceId: "cws_sales" },
  revision: 1,
  config: {
    name: "sales-iban",
    displayName: "No IBAN in Sales",
    on: "asset.before_write",
    filter: { kind: "app" },
    check: { kind: "pattern", pattern: "DE\\d{20}" },
    outcome: "block",
    origin: "asset"
  },
  updatedAt: "2026-10-14T10:00:00.000Z"
};

function render(asset: BuildAsset): string {
  const source: BuildSource = {
    kinds: [{ kind: "guardrail", canCreate: false, canDelete: false }],
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
    useAsset: () => ({ status: "ready", asset, loadedAt: 1, reload: async () => "loaded" }),
    exists: async () => true,
    writes: {
      put: async () => ({ revision: 1 }),
      delete: async () => undefined,
      revert: async () => ({ revision: 1 }),
      revisions: async () => ({ items: [] })
    }
  };
  const viewed: BuildListedKind = {
    ...guardrailKind,
    view: {
      missingText: "guardrails.missing",
      Page: (frame) =>
        createElement(GuardrailPage, {
          ...frame,
          source: {
            useHits: () => ({
              status: "ready",
              hits: { items: [], hasMore: false, counts: { last7Days: 0, last30Days: 0 } }
            })
          }
        })
    }
  };
  const kinds = buildAssetKinds.map((kind) => (kind.kind === "guardrail" ? viewed : kind));
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale: "en" },
      createElement(
        BuildAssetKindsProvider,
        { value: kinds },
        createElement(
          BuildNavigationProvider,
          {
            value: {
              location: { kindPath: "guardrails", name: asset.name },
              open: noop,
              href: (place) => `/build/${place.kindPath ?? ""}/${place.name ?? ""}`
            }
          },
          createElement(BuildFrame, { source })
        )
      )
    )
  );
}

describe("EW-6a verify: the Guardrail page of a workspace guardrail", () => {
  // FOLLOW-UP. guardrail-page.tsx:173 labels every guardrail "Instance". Since EW-6a a
  // guardrail may belong to one workspace and applies there alone; the page tells the reader
  // it applies to the whole instance.
  it("does not label a workspace guardrail as the instance's", () => {
    const markup = render(workspaceGuardrail);
    expect(markup).toContain("No IBAN in Sales");
    expect(markup).not.toMatch(/>Instance</u);
  });
});
