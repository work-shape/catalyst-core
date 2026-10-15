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
  type BuildAssetRow,
  type BuildListedKind,
  type BuildSource
} from "@work-shape/catalyst-chat-ui/build-area";
import { platformContext } from "./chat-ui-build-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// Guardrails written as assets on the Guardrails page and in its list (EW-6a): a workspace
// guardrail reads as its workspace's, and every row and page says in one line when the
// guardrail runs (Felix, 2026-10-14).

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

function render(asset: BuildAsset, list?: { rows: BuildAssetRow[]; locale?: "en" | "de" }): string {
  const source: BuildSource = {
    kinds: [{ kind: "guardrail", canCreate: false, canDelete: false }],
    rights: resolveBuildRights({ permissions: ["config_assets.write"] }, platformContext()),
    loading: false,
    error: undefined,
    reload: async () => undefined,
    useList: () => ({
      rows: list?.rows ?? [],
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
      publish: async () => ({ draftRevision: 1, publishedRevision: 1 }),
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
              status: "ready" as const,
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
      { children: null, locale: list?.locale ?? "en" },
      createElement(
        BuildAssetKindsProvider,
        { value: kinds },
        createElement(
          BuildNavigationProvider,
          {
            value: {
              location: list
                ? { kindPath: "guardrails" }
                : { kindPath: "guardrails", name: asset.name },
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

describe("a workspace guardrail on the Guardrails page", () => {
  // Fails without the fix: the page labelled every guardrail "Instance", though a guardrail
  // may belong to one workspace and applies there alone.
  it("does not label a workspace guardrail as the instance's", () => {
    const markup = render(workspaceGuardrail);
    expect(markup).toContain("No IBAN in Sales");
    expect(markup).not.toMatch(/>Instance</u);
  });

  // Fails without the change: a row said only the guardrail's id and what a hit does, not
  // when it runs.
  it("says in each row of the list when the guardrail runs, in English and German", () => {
    const row = (overrides: Partial<BuildAssetRow>): BuildAssetRow => ({
      id: "asset_row",
      kind: "guardrail",
      name: "row",
      title: "Row",
      scope: { kind: "instance" },
      revision: 1,
      updatedAt: "2026-10-14T10:00:00.000Z",
      ...overrides
    });
    const rows = [
      row({
        name: "sales-iban",
        title: "No IBAN in Sales",
        scope: { kind: "workspace", workspaceId: "cws_sales" },
        attributes: {
          event: "asset.before_write",
          checkKind: "pattern",
          outcome: "block",
          origin: "asset",
          appliesTo: "skill",
          callOrigin: "agent"
        }
      }),
      row({
        name: "publish-approval",
        title: "Publishing needs approval",
        attributes: {
          event: "app.before_publish",
          checkKind: "model_judge",
          outcome: "require_approval",
          origin: "release"
        }
      })
    ];
    const english = render(workspaceGuardrail, { rows });
    expect(english).toContain(
      "Runs before an agent saves a skill, in one workspace. Checks the content for a text pattern. Blocks if the check fails."
    );
    expect(english).toContain(
      "Runs before anyone publishes an App, instance-wide, set by the operator."
    );
    expect(english).not.toContain("asset.before_write");
    const german = render(workspaceGuardrail, { rows, locale: "de" });
    expect(german).toContain(
      "Läuft, bevor ein Agent einen Skill speichert, in einem Workspace. Prüft den Inhalt auf ein Textmuster. Blockiert, wenn die Prüfung anschlägt."
    );
    expect(german).toContain(
      "Läuft, bevor jemand eine App veröffentlicht, instanzweit, vom Betreiber festgelegt."
    );
  });
});
