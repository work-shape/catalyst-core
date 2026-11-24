// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { GUARDRAIL_EVENTS } from "@work-shape/catalyst-core";
import type {
  GuardrailHitView,
  LocaleCode,
  RuleInForceView,
  ShippedGuardrailView
} from "@work-shape/catalyst-api-client";
import {
  buildAssetKinds,
  BuildAssetKindsProvider,
  BuildFrame,
  BuildNavigationProvider,
  GuardrailPage,
  guardrailRunSentence,
  resolveBuildRights,
  ShippedGuardrailsLead,
  type BuildAsset,
  type BuildAssetRow,
  type BuildKind,
  type BuildListedKind,
  type BuildListLeadFilter,
  type BuildScope,
  type BuildSource,
  type GuardrailRunFacts,
  type GuardrailSource,
  type ShippedGuardrailsRead
} from "@work-shape/catalyst-chat-ui/build-area";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { instanceActions, platformContext } from "./chat-ui-build-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { required } from "./support/assertions";
import { createTranslationContext } from "./support/chat-ui/shared";
import {
  GuardrailAnswerView,
  RulesInForceList,
  changersSentence,
  guardrailAnswerOfErrorDetails,
  parseOperationCallPreview,
  readGuardrailRefusal,
  toolUiState,
  type AskClient,
  type GuardrailAnswerRef
} from "./support/chat-ui/chat-guardrails";

// Guardrails in the interface: the run sentence, the Guardrail page and its hits, the
// Guardrails list with the shipped guardrail, and a guardrail's answer where the person acts.

const noop = () => undefined;

const writes: BuildSource["writes"] = {
  put: async () => ({ revision: 1 }),
  readFiles: async () => [],
  delete: async () => undefined,
  publish: async () => ({ draftRevision: 1, publishedRevision: 1 }),
  revert: async () => ({ revision: 1 }),
  revisions: async () => ({ items: [] })
};

describe("the sentence of when a guardrail runs", () => {
  const workspaces: Record<string, string> = { cws_kai: "Kai Spezis" };
  const sentence = (facts: GuardrailRunFacts, locale: "en" | "de" = "en") =>
    guardrailRunSentence(facts, {
      t: createTranslationContext(locale).t,
      workspaceName: (id) => workspaces[id],
      requestKind: (kind) => (kind === "skill_change" ? "Skill change" : undefined)
    });
  const agentSavesSkill: GuardrailRunFacts = {
    event: "asset.before_write",
    outcome: "block",
    checkKind: "pattern",
    kind: "skill",
    callOrigin: "agent",
    scope: { kind: "workspace", workspaceId: "cws_kai" },
    setByOperator: false
  };

  it("names the workspace by name where it is known, and the operator's setup", () => {
    expect(sentence(agentSavesSkill)).toContain("in workspace Kai Spezis");
    expect(
      sentence({ ...agentSavesSkill, scope: { kind: "workspace", workspaceId: "cws_x" } })
    ).toContain("in one workspace");
    expect(
      sentence({ ...agentSavesSkill, scope: { kind: "instance" }, setByOperator: true })
    ).toContain("part of the system setup");
  });

  it("names no event id, for every event and for one this build does not know", () => {
    for (const event of [...GUARDRAIL_EVENTS, "message.after_send"]) {
      for (const locale of ["en", "de"] as const) {
        const said = sentence({ ...agentSavesSkill, event, kind: undefined }, locale);
        expect(said, `${event} ${locale}`).not.toContain(event);
        expect(said).not.toMatch(/guardrails\./u);
      }
    }
  });

  // ACCEPT-FIX-10 B1: the page promised the Build Agent writes guardrails, which it cannot.
  it("says guardrails come from the CLI and never promises the Build Agent", () => {
    for (const locale of ["en", "de"] as const) {
      const { t } = createTranslationContext(locale);
      for (const key of ["guardrails.description", "guardrails.empty"] as const) {
        expect(t(key)).toContain("CLI");
        expect(t(key)).not.toMatch(/Build[- ]Agent/u);
      }
    }
  });
});

const listed = buildAssetKinds.find((kind) => kind.kind === "guardrail");
if (!listed || listed.Editor !== undefined) {
  throw new Error("The platform registry has no guardrail entry that only lists.");
}
const guardrailKind: BuildListedKind = listed;

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

function readyHits(items: GuardrailHitView[], hasMore = false): GuardrailHitsRead {
  return {
    status: "ready",
    hits: {
      items,
      hasMore,
      counts: { last7Days: items.length, last30Days: items.length }
    }
  };
}

function renderPage(
  input: {
    asset?: BuildAsset;
    hits?: GuardrailHitsRead;
    locale?: LocaleCode;
    /** The further kinds the reader sees in Build. */
    sees?: string[];
    /** Renders the list with these rows instead of the asset's page. */
    rows?: BuildAssetRow[];
  } = {}
): string {
  const asset = input.asset ?? guardrailAsset();
  const hits = input.hits ?? readyHits([]);
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
      rows: input.rows ?? [],
      error: undefined,
      hasMore: false,
      loadingMore: false,
      loadMore: noop,
      retry: noop
    }),
    useAsset: () => ({ status: "ready", asset, loadedAt: 1, reload: async () => "loaded" }),
    exists: async () => true,
    checkName: async () => ({ available: true }),
    writes
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
              location: input.rows
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

describe("Guardrail page", () => {
  it("says what is checked and when, with nothing to edit and no model binding", () => {
    const markup = renderPage();
    expect(markup).toContain("No personal data in skills");
    expect(markup).toContain("Runs before anyone asks for an approval");
    expect(markup).toContain("Check whether the text names a person.");
    expect(markup).not.toContain("Save");
    expect(markup).not.toContain("judge");
  });

  // Fails without the fix: the page labelled every guardrail "Instance".
  it("does not label a workspace guardrail as the instance's, and says in each row when it runs", () => {
    const workspaceGuardrail = guardrailAsset({
      on: "asset.before_write",
      filter: { kind: "app" }
    });
    const markup = renderPage({
      asset: { ...workspaceGuardrail, scope: { kind: "workspace", workspaceId: "cws_sales" } }
    });
    expect(markup).not.toMatch(/>Instance</u);

    const list = renderPage({
      rows: [
        {
          id: "asset_row",
          kind: "guardrail",
          name: "sales-iban",
          title: "No IBAN in Sales",
          scope: { kind: "workspace", workspaceId: "cws_sales" },
          revision: 1,
          updatedAt: "2026-10-14T10:00:00.000Z",
          attributes: {
            event: "asset.before_write",
            checkKind: "pattern",
            outcome: "block",
            origin: "asset",
            appliesTo: "skill",
            callOrigin: "agent"
          }
        }
      ]
    });
    expect(list).toContain("Runs before an agent saves a skill, in one workspace.");
    expect(list).not.toContain("asset.before_write");
  });

  it("counts the hits by period and lists the newest by outcome", () => {
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
    expect(markup).toMatch(/Last 7 days<\/dt>.*?>2</su);
    expect(markup).toMatch(/Last 30 days<\/dt>.*?>61</su);
  });

  // ACCEPT-FIX-10 E8 and the subject link: a hit names its subject by title, never by internal
  // name, and links an asset only for a reader who sees its kind in Build.
  it("names the subject of a hit and links it only for a reader who sees its kind", () => {
    const read = (sees?: string[], subjectTitle?: string) =>
      renderPage({
        ...(sees ? { sees } : {}),
        asset: guardrailAsset({ on: "asset.before_write", filter: { kind: "skill" } }),
        hits: readyHits([
          hit({
            event: "asset.before_write",
            subjectKind: "skill",
            subjectName: "kunden-faq",
            ...(subjectTitle ? { subjectTitle } : {})
          }),
          hit({
            id: "ghit_2",
            event: "operation.before_call",
            outcome: "require_approval",
            subjectKind: "operation",
            subjectName: "data_store.kunden.insert"
          })
        ])
      });
    const markup = read(["skill"]);
    expect(markup).toContain('href="/build/skills/kunden-faq"');
    expect(markup).not.toContain(">kunden-faq<");
    // A call is no page of the Build area: nothing links it.
    expect(markup).not.toMatch(/href="[^"]*data_store\.kunden\.insert/u);
    const titled = read(["skill"], "Kunden-FAQ");
    expect(titled).toContain(">Kunden-FAQ<");
    expect(titled).not.toContain(">kunden-faq<");
    expect(read()).not.toContain('href="/build/skills/kunden-faq"');
  });

  // LOWS-A: the platform's own sentences are said in the reader's language without the
  // guardrail's id; a reason its author wrote is quoted in its own words.
  it("says the platform's reasons in the reader's language and keeps the author's own", () => {
    const de = renderPage({
      locale: "de",
      hits: readyHits([
        hit({
          id: "ghit_2",
          event: "operation.before_call",
          subjectKind: "operation",
          message: "The input matches the pattern of guardrail 'no_personal_data'."
        }),
        hit({
          id: "ghit_3",
          message: "Check 'no_personal_data' did not answer within 20 seconds. Try again later."
        })
      ])
    });
    expect(de).toContain("Der Inhalt passt auf das Muster.");
    expect(de).toContain("Die Prüfung konnte nicht ausgeführt werden.");
    expect(de).not.toContain("&#x27;no_personal_data&#x27;");

    const authored = [
      "Never send what guardrail 'no_personal_data' forbids.",
      "Check 'no_personal_data' could not be evaluated, ask the data protection officer.",
      "The input matches the pattern of guardrail 'no_personal_data'. Remove the IBAN."
    ];
    const en = renderPage({
      hits: readyHits(
        authored.map((message, index) =>
          hit({
            id: `ghit_${index}`,
            event: "operation.before_call",
            subjectKind: "operation",
            message
          })
        )
      )
    });
    for (const message of authored) expect(en).toContain(message.replaceAll("'", "&#x27;"));
    expect(en).not.toContain("The content matches the pattern.");
    expect(en).not.toContain("The check could not be run.");
  });

  it("shows an empty, a waiting and a failed read of the hits", () => {
    expect(renderPage()).toContain("No hits yet.");
    expect(renderPage({ hits: { status: "loading" } })).not.toContain("No hits yet.");
    expect(renderPage({ hits: { status: "failed", message: undefined, retry: noop } })).toContain(
      "Try again"
    );
  });

  // Fails without the change: a block that answered an approval request read as any block.
  it("marks a block that answered a request for an approval that could not wait", () => {
    const markup = renderPage({
      hits: readyHits([hit({ id: "ghit_2", convertedFrom: "require_approval" })])
    });
    expect(markup).toContain('data-guardrail-hit-converted-from="require_approval"');
  });
});

// Build > Guardrails: the guardrail the platform ships is the first row of the one list (GR-PUB-1).
describe("the Guardrails list", () => {
  const TEAM = "cws_team";
  const shipped: ShippedGuardrailView = {
    name: "publishing-needs-approval",
    displayName: "Publishing needs approval from an admin for all workspaces",
    reason: "A new revision of an App or a Workflow goes live once an instance admin approved it.",
    on: ["app.before_publish", "workflow.before_publish"],
    outcome: "require_approval",
    enabled: true,
    canSwitch: true
  };
  const ready = (
    items: ShippedGuardrailView[],
    calls: Partial<
      Pick<Extract<ShippedGuardrailsRead, { status: "ready" }>, "switchTo" | "setAlwaysAsk">
    > = {}
  ): ShippedGuardrailsRead => ({
    status: "ready",
    items,
    switching: undefined,
    switchTo: async () => undefined,
    setAlwaysAsk: async () => undefined,
    ...calls
  });
  const kindOf = (read: ShippedGuardrailsRead): BuildKind => ({
    // The fixture's instance knows agents: the list of this test stands on their rights.
    kind: "agent",
    path: "guardrails",
    label: "guardrails.kind",
    searchLabel: "guardrails.search",
    emptyText: "guardrails.empty",
    icon: "guardrail",
    ListLead: (props) => createElement(ShippedGuardrailsLead, { read, ...props })
  });
  const source = (scope: BuildScope, rows: BuildAssetRow[], listError?: string): BuildSource => {
    const permissions = ["config_assets.read", "config_assets.write"];
    const context = {
      ...platformContext([], instanceActions(permissions)),
      workspaces: [
        { id: TEAM, name: "Team", kind: "shared" as const, member: true, actions: ["agent.read"] }
      ]
    };
    return {
      kinds: [{ kind: "agent", canCreate: false, canDelete: false }],
      rights: resolveBuildRights({ permissions }, context),
      loading: false,
      error: undefined,
      reload: async () => undefined,
      useList: () => ({
        rows: listError === undefined ? rows : undefined,
        error: listError,
        hasMore: false,
        loadingMore: false,
        loadMore: noop,
        retry: noop
      }),
      useAsset: () => ({ status: "missing" }),
      exists: async () => true,
      checkName: async () => ({ available: true }),
      writes,
      scopeOf: () => scope,
      chooseScope: noop
    };
  };
  type ListInput = {
    read?: ShippedGuardrailsRead;
    scope?: BuildScope;
    rows?: BuildAssetRow[];
    listError?: string;
  };
  const listElement = (input: ListInput = {}) =>
    createElement(
      BuildAssetKindsProvider,
      { value: [kindOf(input.read ?? ready([shipped]))] },
      createElement(
        BuildNavigationProvider,
        {
          value: {
            location: { kindPath: "guardrails" },
            open: noop,
            href: (place) => `/build/${place.kindPath ?? ""}/${place.name ?? ""}`
          }
        },
        createElement(BuildFrame, {
          source: source(input.scope ?? { kind: "instance" }, input.rows ?? [], input.listError)
        })
      )
    );
  const renderList = (input: ListInput = {}) =>
    renderToStaticMarkup(
      createElement(TranslationProvider, { children: null, locale: "en" }, listElement(input))
    );
  const own = (name: string): BuildAssetRow => ({
    id: `asset_${name}`,
    kind: "agent",
    name,
    title: name,
    scope: { kind: "instance" },
    revision: 1,
    updatedAt: "2026-10-08T10:00:00.000Z"
  });
  const shippedTitles = (filter: Partial<BuildListLeadFilter>) =>
    renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "en" },
        createElement(ShippedGuardrailsLead, {
          read: ready([shipped]),
          filter: { text: "", scope: undefined, ...filter },
          children: (lead) => lead.rows?.map((row) => row.title).join("|") ?? "loading"
        })
      )
    );

  it("shows the shipped guardrail, on and switchable, before the instance's own", () => {
    const markup = renderList({ rows: [own("privacy-check")] });
    const list = markup.slice(markup.indexOf('aria-label="Guardrails"'));
    expect(list).toMatch(/role="switch"[^>]*aria-checked="true"/u);
    expect(list).not.toMatch(/<button[^>]*role="switch"[^>]* disabled=""/u);
    expect(list.indexOf("privacy-check")).toBeGreaterThan(list.indexOf(shipped.displayName));
  });

  // Fails without the fix: a failed read of the instance's own hid the shipped guardrail.
  it("keeps the shipped guardrail and its switch where the instance's own could not be read", () => {
    const failed = "The guardrails could not be loaded.";
    const markup = renderList({ listError: failed });
    expect(markup).toContain(failed);
    expect(markup.slice(markup.indexOf('aria-label="Guardrails"'))).toMatch(
      /role="switch"[^>]*aria-checked="true"/u
    );
    const alone = renderList({ listError: failed, read: ready([]) });
    expect(alone).toContain(failed);
    expect(alone).not.toContain('aria-label="Guardrails"');
  });

  it("leaves the shipped guardrail out of a workspace, and matches it by title or name", () => {
    expect(renderList({ scope: { kind: "workspace", workspaceId: TEAM } })).not.toContain(
      shipped.displayName
    );
    expect(shippedTitles({ text: "PUBLISHING" })).toBe(shipped.displayName);
    expect(shippedTitles({ text: "needs-approval" })).toBe(shipped.displayName);
    expect(shippedTitles({ text: "privacy" })).toBe("");
    expect(shippedTitles({ scope: { kind: "workspace", workspaceId: TEAM } })).toBe("");
  });

  it("holds the switch for a reader who may not switch it, and names a gone account as deleted", () => {
    const markup = renderList({
      read: ready([
        {
          ...shipped,
          enabled: false,
          canSwitch: false,
          switchedBy: { id: "usr_admin", label: "Ada Admin" },
          switchedAt: "2026-10-14T21:00:00.000Z"
        }
      ])
    });
    expect(markup).toMatch(/role="switch"[^>]*aria-checked="false"/u);
    expect(markup).toMatch(/<button[^>]*role="switch"[^>]* disabled=""/u);
    expect(markup).toContain("Ada Admin");
    // ERASE-ACTOR-IDS: the account deletion empties the name; the id is never shown.
    const gone = renderList({
      read: ready([
        {
          ...shipped,
          enabled: false,
          switchedBy: { id: "usr_gone", label: "" },
          switchedAt: "2026-10-14T21:00:00.000Z"
        }
      ])
    });
    expect(gone).toContain("Deleted account");
    expect(gone).not.toContain("usr_gone");
  });

  it("waits for the shipped guardrails and says when they could not be read", () => {
    expect(renderList({ read: { status: "loading" } })).not.toContain('aria-label="Guardrails"');
    expect(renderList({ read: { status: "failed", message: undefined, retry: noop } })).toContain(
      "The guardrails of the platform could not be loaded."
    );
  });

  async function mount(read: ShippedGuardrailsRead) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        createElement(
          TranslationProvider,
          { children: null, locale: "en" },
          createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, listElement({ read }))
        )
      )
    );
    return {
      host,
      close: async () => {
        await act(async () => root.unmount());
        host.remove();
        vi.unstubAllGlobals();
      }
    };
  }

  // Replaces the e2e check: switching off asks first, and Cancel leaves it on.
  it("asks before switching it off, and Cancel keeps it on", async () => {
    const switched: [string, boolean][] = [];
    const view = await mount(
      ready([shipped], {
        switchTo: async (name, enabled) => {
          switched.push([name, enabled]);
          return undefined;
        }
      })
    );
    try {
      const toggle = required(view.host.querySelector<HTMLButtonElement>('[role="switch"]'));
      await act(async () => toggle.click());
      const asked = required(document.querySelector<HTMLElement>("dialog[open]"));
      expect(switched).toEqual([]);
      const cancel = required(
        [...asked.querySelectorAll("button")].find((button) => button.textContent === "Cancel")
      );
      await act(async () => cancel.click());
      expect(document.querySelector("dialog[open]")).toBeNull();
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      expect(switched).toEqual([]);
    } finally {
      await view.close();
    }
  });

  // GR-PUB-2: an admin sets the publish guardrail to ask on every publish; not while it is off.
  it("sets the guardrail to ask on every publish, and offers no setting while it is off", async () => {
    const set: [string, boolean][] = [];
    const view = await mount(
      ready([{ ...shipped, alwaysAsk: false }], {
        setAlwaysAsk: async (name, value) => {
          set.push([name, value]);
          return undefined;
        }
      })
    );
    try {
      const box = required(
        view.host.querySelector<HTMLButtonElement>('[data-shipped-always-ask] [role="checkbox"]')
      );
      expect(box.getAttribute("aria-checked")).toBe("false");
      await act(async () => box.click());
      expect(set).toEqual([["publishing-needs-approval", true]]);
    } finally {
      await view.close();
    }
    const off = await mount(ready([{ ...shipped, enabled: false, alwaysAsk: false }]));
    try {
      expect(off.host.querySelector("[data-shipped-always-ask]")).toBeNull();
    } finally {
      await off.close();
    }
  });
});

// GR-3: a guardrail's answer where the person acts, and Rules in force.
describe("a guardrail's answer", () => {
  const client: AskClient = { guardrails: { ask: () => Promise.reject(new Error("not asked")) } };
  const salesRule: RuleInForceView = {
    name: "no-iban",
    displayName: "Keine IBAN",
    reason: "Bankdaten gehören nicht in Skills.",
    on: ["asset.before_write"],
    filter: { kind: "skill" },
    checkKind: "pattern",
    outcome: "block",
    origin: "asset",
    scope: { kind: "workspace", workspaceId: "cws_sales", workspaceName: "Vertrieb" },
    revision: 3,
    changedBy: "Mara Beispiel",
    changedAt: "2026-10-20T09:30:00.000Z",
    changers: ["Mara Beispiel", "Jo Muster"],
    askable: true,
    hitsLast30Days: 4
  };
  const floorRule: RuleInForceView = {
    name: "floor-secrets",
    displayName: "Keine Geheimnisse",
    reason: "Schlüssel bleiben im Tresor.",
    on: ["operation.before_call"],
    outcome: "block",
    origin: "release",
    scope: { kind: "instance" },
    changers: [],
    askable: false,
    hitsLast30Days: 0
  };
  const answerOf = (rule: RuleInForceView): GuardrailAnswerRef => ({
    name: rule.name,
    title: rule.displayName,
    outcome: rule.outcome,
    reason: rule.reason,
    origin: rule.origin,
    ...(rule.revision === undefined ? {} : { revision: rule.revision }),
    ...(rule.scope.kind === "workspace"
      ? { scope: { kind: "workspace" as const, workspaceId: rule.scope.workspaceId } }
      : {})
  });
  const render = (node: ReactNode) =>
    renderToStaticMarkup(
      createElement(TranslationProvider, { children: null, locale: "en" }, node)
    );

  it("names who can change a published rule and offers to ask; a floor names nobody", () => {
    const published = render(
      createElement(GuardrailAnswerView, {
        answer: answerOf(salesRule),
        rule: salesRule,
        instanceAdmin: undefined,
        client
      })
    );
    expect(published).toContain("Mara Beispiel, Jo Muster");
    expect(published).toContain('data-testid="guardrail-answer-ask"');
    const floor = render(
      createElement(GuardrailAnswerView, {
        answer: answerOf(floorRule),
        rule: floorRule,
        instanceAdmin: "Mara Beispiel",
        client: undefined
      })
    );
    expect(floor).not.toContain("Mara");
    expect(floor).not.toContain('data-testid="guardrail-answer-ask"');
  });

  it("names an admin for all workspaces where the reader may see no one who can change it", () => {
    const hidden = {
      ...salesRule,
      changers: [],
      changedBy: undefined,
      changedByHidden: true as const
    };
    expect(changersSentence(hidden, hidden, "Root Admin")).toEqual({
      key: "guardrailAnswer.changersAdmin",
      values: { name: "Root Admin" }
    });
    expect(changersSentence(hidden, hidden, undefined).key).toBe("guardrailAnswer.changersUnnamed");
    const many = { ...salesRule, changers: ["A", "B", "C", "D", "E"] };
    expect(changersSentence(many, many, undefined)).toEqual({
      key: "guardrailAnswer.changersMore",
      values: { names: "A, B, C", count: 2 }
    });
    const markup = render(
      createElement(GuardrailAnswerView, {
        answer: answerOf(hidden),
        rule: hidden,
        instanceAdmin: undefined,
        client: undefined
      })
    );
    expect(markup).not.toContain("Mara");
  });

  it("reads the answer from a refused tool call, a refused App action and a held call", () => {
    const answer = answerOf(salesRule);
    const output = { status: "failed", guardrail: answer, message: "Blocked." };
    expect(readGuardrailRefusal(output)).toEqual(answer);
    expect(toolUiState({ result: output, toolName: "save_skill" })).toBe("failed");
    expect(readGuardrailRefusal({ status: "failed", guardrail: { name: 1 } })).toBeUndefined();
    expect(guardrailAnswerOfErrorDetails({ guardrailId: "no-iban", guardrail: answer })).toEqual(
      answer
    );
    expect(guardrailAnswerOfErrorDetails({ guardrailId: "no-iban" })).toBeUndefined();
    const preview = parseOperationCallPreview({
      runId: "run_1",
      operation: "demo.send",
      effect: "changing",
      actor: { kind: "user", id: "usr_1", label: "Kai" },
      origin: { kind: "agent" },
      inputs: [],
      guardrails: [answer, { name: "broken" }]
    });
    expect(preview?.guardrails).toEqual([answer]);
  });

  it("lists the rules in force, the operator's first and each workspace's last, asking only of published ones", () => {
    const instanceRule: RuleInForceView = {
      ...salesRule,
      name: "warn-mail",
      displayName: "Mails nach außen",
      outcome: "warn",
      scope: { kind: "instance" },
      on: ["operation.before_call"],
      filter: { operation: "mail.send" },
      checkKind: undefined,
      hitsLast30Days: 0
    };
    const markup = render(
      createElement(RulesInForceList, {
        rules: { items: [salesRule, instanceRule, floorRule] },
        failed: false,
        client,
        onRetry: noop
      })
    );
    const positions = ["Keine Geheimnisse", "Mails nach außen", "Keine IBAN"].map((title) =>
      markup.indexOf(title)
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(markup.match(/data-testid="rule-in-force-ask"/gu)?.length).toBe(2);
    expect(
      render(
        createElement(RulesInForceList, { rules: undefined, failed: true, client, onRetry: noop })
      )
    ).toContain("The rules in force could not be loaded.");
  });
});
