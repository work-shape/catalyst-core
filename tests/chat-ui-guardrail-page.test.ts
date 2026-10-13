import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { GuardrailHitView, LocaleCode } from "@vivd-catalyst/api-client";
import {
  buildAssetKinds,
  BuildAssetKindsProvider,
  BuildFrame,
  BuildNavigationProvider,
  GuardrailPage,
  resolveBuildRights,
  type BuildAsset,
  type BuildListedKind,
  type BuildSource,
  type GuardrailSource
} from "@vivd-catalyst/chat-ui/build-area";
import { platformContext } from "./chat-ui-build-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The Guardrail page against fixed answers of `guardrails.list_hits`: what is checked and
// when, what a hit does, and the newest hits in each state of their read.

const listed = buildAssetKinds.find((kind) => kind.kind === "guardrail");
if (!listed || listed.Editor !== undefined) {
  throw new Error("The platform registry has no guardrail entry that only lists.");
}
const guardrailKind: BuildListedKind = listed;
const noop = () => undefined;

type GuardrailHitsRead = ReturnType<GuardrailSource["useHits"]>;

function guardrailAsset(config: Record<string, unknown> = {}): BuildAsset {
  return {
    id: "asset_privacy",
    kind: "guardrail",
    name: "no_personal_data",
    scope: { kind: "instance" },
    revision: 1,
    config: {
      name: "no_personal_data",
      displayName: "No personal data in skills",
      on: "approval_request.before_create",
      filter: { kind: "skill_change" },
      check: {
        kind: "model_judge",
        modelBindingId: "judge",
        instruction: "Check whether the text names a person."
      },
      outcome: "block",
      origin: "release",
      ...config
    },
    updatedAt: "2026-10-08T10:00:00.000Z"
  };
}

function hit(overrides: Partial<GuardrailHitView> = {}): GuardrailHitView {
  return {
    id: "ghit_1",
    event: "approval_request.before_create",
    outcome: "block",
    message: "The text names a customer.",
    subjectKind: "skill_change",
    createdAt: "2026-10-12T08:15:00.000Z",
    ...overrides
  };
}

function renderPage(
  input: { asset?: BuildAsset; hits?: GuardrailHitsRead; locale?: LocaleCode } = {}
): string {
  const asset = input.asset ?? guardrailAsset();
  const hits: GuardrailHitsRead = input.hits ?? {
    status: "ready",
    hits: { items: [], hasMore: false, counts: { last7Days: 0, last30Days: 0 } }
  };
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
      Page: (frame) => createElement(GuardrailPage, { ...frame, source: { useHits: () => hits } })
    }
  };
  const kinds = buildAssetKinds.map((kind) => (kind.kind === "guardrail" ? viewed : kind));
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale: input.locale ?? "en" },
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

describe("Guardrail page", () => {
  it("says what is checked and when, and what a hit does, with nothing to edit", () => {
    const markup = renderPage();

    expect(markup).toContain(">No personal data in skills</h1>");
    expect(markup).toContain("Before a request for approval is filed");
    expect(markup).toContain("Check whether the text names a person.");
    expect(markup).toContain("The request is not filed. Whoever asked is told the reason.");
    expect(markup).toContain("Guardrails come from the release config and cannot be changed here.");
    expect(markup).not.toContain("Save");
    // The judge's model binding is configuration, not something a reader acts on.
    expect(markup).not.toContain("judge");
  });

  it("names every kind of request where no filter narrows it, and a warning outcome", () => {
    const { filter: _filter, ...unfiltered } = guardrailAsset({ outcome: "warn" }).config;
    const markup = renderPage({ asset: { ...guardrailAsset(), config: unfiltered } });
    expect(markup).toContain("Every kind of request");
    expect(markup).toContain("whoever decides it sees the warning");
  });

  it("counts the hits by period and lists the newest by kind, reason and outcome, naming nobody", () => {
    const markup = renderPage({
      hits: {
        status: "ready",
        hits: {
          items: [hit(), hit({ id: "ghit_2", outcome: "warn", message: "" })],
          hasMore: true,
          counts: { last7Days: 2, last30Days: 61 }
        }
      }
    });
    expect(markup).toContain('data-guardrail-hit="block"');
    expect(markup).toContain('data-guardrail-hit="warn"');
    expect(markup).toContain("The text names a customer.");
    expect(markup).toContain("Skill change");
    expect(markup).toMatch(/Last 7 days<\/dt>.*?>2</su);
    expect(markup).toMatch(/Last 30 days<\/dt>.*?>61</su);
    expect(markup).toContain("The check could not be run.");
    expect(markup).toContain("Only the newest 2 hits are shown.");
  });

  it("shows an empty, a waiting and a failed read of the hits", () => {
    expect(renderPage()).toContain("No hits yet.");
    expect(renderPage({ hits: { status: "loading" } })).not.toContain("No hits yet.");
    const failed = renderPage({
      hits: { status: "failed", message: undefined, retry: noop }
    });
    expect(failed).toContain("The hits of this guardrail could not be loaded.");
    expect(failed).toContain("Try again");
  });

  it("reads in German", () => {
    const markup = renderPage({ locale: "de" });
    expect(markup).toContain("Bevor eine Freigabe-Anfrage gestellt wird");
    expect(markup).toContain("Noch keine Treffer.");
  });
});
