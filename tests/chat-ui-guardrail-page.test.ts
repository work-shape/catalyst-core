import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { GuardrailHitView, LocaleCode } from "@work-shape/catalyst-api-client";
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
} from "@work-shape/catalyst-chat-ui/build-area";
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
  input: {
    asset?: BuildAsset;
    hits?: GuardrailHitsRead;
    locale?: LocaleCode;
    /** The further kinds the reader sees in Build. */
    sees?: string[];
  } = {}
): string {
  const asset = input.asset ?? guardrailAsset();
  const hits: GuardrailHitsRead = input.hits ?? {
    status: "ready",
    hits: { items: [], hasMore: false, counts: { last7Days: 0, last30Days: 0 } }
  };
  const source: BuildSource = {
    kinds: ["guardrail", ...(input.sees ?? [])].map((kind) => ({
      kind,
      canCreate: false,
      canDelete: false
    })),
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
    // When it runs, in one line built from its event, filter, check and outcome.
    expect(markup).toContain(
      "Runs before anyone asks for an approval of the kind Skill change, instance-wide, set by the operator. Checks the content for breaches of its rule, with a model. Blocks if the check fails."
    );
    expect(markup).toContain(">Instance<");
    expect(markup).toContain("Check whether the text names a person.");
    expect(markup).toContain("The action does not happen. Whoever acted is told the reason.");
    expect(markup).toContain("guardrails come from the release config; further ones are written");
    expect(markup).not.toContain("Save");
    // The judge's model binding is configuration, not something a reader acts on.
    expect(markup).not.toContain("judge");
  });

  it("names every kind of request where no filter narrows it, and a warning outcome", () => {
    const { filter: _filter, ...unfiltered } = guardrailAsset({ outcome: "warn" }).config;
    const markup = renderPage({ asset: { ...guardrailAsset(), config: unfiltered } });
    expect(markup).toContain("Everything at this point");
    expect(markup).toContain("whoever acts or decides on it sees the warning");
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

  // Fails without the change: a hit named only the kind of what it checked, so nobody could
  // tell which skill was blocked or open it.
  it("names the subject of a hit and links an asset of the Build area to its page", () => {
    const read = (sees?: string[]) =>
      renderPage({
        ...(sees ? { sees } : {}),
        asset: guardrailAsset({
          on: "asset.before_write",
          filter: { kind: "skill" },
          check: { kind: "pattern", pattern: "DE\\d{2}", reason: "Skills hold no IBAN." }
        }),
        hits: {
          status: "ready",
          hits: {
            items: [
              hit({
                event: "asset.before_write",
                subjectKind: "skill",
                subjectName: "kunden-faq",
                message: "Skills hold no IBAN."
              }),
              hit({
                id: "ghit_2",
                event: "operation.before_call",
                outcome: "require_approval",
                subjectKind: "operation",
                subjectName: "data_store.kunden.insert",
                message: "Inserts wait for an approval."
              })
            ],
            hasMore: false,
            counts: { last7Days: 2, last30Days: 2 }
          }
        }
      });
    const markup = read(["skill"]);
    expect(markup).toContain(
      "Runs before anyone saves a skill, instance-wide, set by the operator. Checks the content for a text pattern."
    );
    expect(markup).toContain("Pattern");
    expect(markup).toContain("Skills hold no IBAN.");
    expect(markup).toContain('data-guardrail-hit-subject="kunden-faq"');
    expect(markup).toContain('href="/build/skills/kunden-faq"');
    expect(markup).toContain("Call of data_store.kunden.insert");
    expect(markup).toContain("Held for approval");
    // A call is no page of the Build area: its hit names it and links nothing.
    expect(markup).not.toContain("data_store.kunden.insert</a>");
    expect(markup).not.toMatch(/href="[^"]*data_store\.kunden\.insert/u);
    // A reader who does not see skills in Build is named the skill and offered no link.
    const unseen = read();
    expect(unseen).toContain('data-guardrail-hit-subject="kunden-faq"');
    expect(unseen).not.toContain('href="/build/skills/kunden-faq"');
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

  // Fails without the change: a block that answered a request for an approval the action could
  // not wait for read as any other block.
  it("says where a block answered a request for an approval that could not wait", () => {
    const converted = (locale: "en" | "de") =>
      renderPage({
        locale,
        hits: {
          status: "ready",
          hits: {
            items: [hit({ id: "ghit_2", convertedFrom: "require_approval" })],
            hasMore: false,
            counts: { last7Days: 1, last30Days: 1 }
          }
        }
      });
    expect(converted("en")).toContain('data-guardrail-hit-converted-from="require_approval"');
    expect(converted("en")).toContain("Blocked: approval could not wait");
    expect(converted("de")).toContain("Blockiert: konnte nicht auf Freigabe warten");
  });

  it("reads in German", () => {
    const markup = renderPage({ locale: "de" });
    expect(markup).toContain("Läuft, bevor jemand eine Freigabe der Art");
    expect(markup).toContain("instanzweit, vom Betreiber festgelegt.");
    expect(markup).toContain("Noch keine Treffer.");
  });
});
