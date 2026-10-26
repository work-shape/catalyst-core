import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { appAudienceSchema } from "@work-shape/catalyst-api-contract";
import { createTranslationContext } from "./support/chat-ui/shared";
import {
  appManifestSummary,
  appPublishCall,
  appPublishConfirmationReady,
  AppPublishConfirmationView,
  appPublishDataRead,
  appPublishMaySend,
  PublishDialog
} from "@work-shape/catalyst-chat-ui/apps";
import {
  ToolDecisionCardView,
  type ToolDecisionAnswer
} from "@work-shape/catalyst-chat-ui/tool-decision-card";
import type { AppDataSources } from "@work-shape/catalyst-chat-ui/build-area";
import type { PublishNarrativeRead } from "./support/chat-ui";
import { renderItem } from "./chat-ui-inbox-harness";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// SHARE-1 in the interface: an App's Publish dialog opens with "For whom?", offers the whole
// instance only where the instance does, and names the people chosen in its sentence and in
// the line on who sees which stored data. A held publish's Inbox item names the audience the
// requester chose. The App's card in the conversation is tested in chat-ui-app-card.test.ts.

type Audience = (typeof appAudienceSchema.options)[number];

const render = (node: ReactNode, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));
const noop = () => undefined;
const workspace = { id: "cw_1", name: "Kai Spezis", emoji: null };
const ready = (summary: string): PublishNarrativeRead => ({
  status: "ready",
  narrative: { summary, warnings: [] }
});
const at = (markup: string, text: string) => {
  const index = markup.indexOf(text);
  expect(index, `${text} is in the markup`).toBeGreaterThan(-1);
  return index;
};
const publishButton = (markup: string) =>
  markup.match(/<button[^>]*>(?:(?!<\/button>).)*(?:Publish|Veröffentlichen)<\/button>/u)?.[0] ??
  "";
const held = (markup: string) => / disabled=""/u.test(publishButton(markup));

const offer = (
  selected: Audience,
  choices: readonly Audience[] = appAudienceSchema.options,
  label = "Everyone in Kai Spezis",
  extra: { people?: number; live?: { audience: Audience; label: string | undefined } } = {}
) => ({ selected, choices, label, ...extra });

const dialog = (input: {
  narrative?: PublishNarrativeRead;
  offer?: ReturnType<typeof offer>;
  selected?: Audience;
  storedData?: Parameters<typeof PublishDialog>[0]["storedData"];
  locale?: "en" | "de";
  /** The live revision; left out, nothing is live yet. */
  live?: number;
}) =>
  render(
    createElement(PublishDialog, {
      name: "Findings",
      workspace,
      ask: {
        revision: 3,
        live: input.live,
        summary: appManifestSummary({ manifest: { connections: ["crm"] } }),
        readsStoredData: input.storedData !== undefined
      },
      loading: false,
      error: undefined,
      narrative: input.narrative ?? ready("Findings opens for everyone in Kai Spezis."),
      audience: {
        offer: input.offer,
        selected: input.selected ?? input.offer?.selected,
        onChange: noop
      },
      ...(input.storedData ? { storedData: input.storedData } : {}),
      onConfirm: noop,
      onClose: noop
    }),
    input.locale ?? "en"
  );

describe("check 56: the App's Publish dialog asks “For whom?” first", () => {
  it("opens with the question, its three choices and the owning workspace by its name", () => {
    const markup = dialog({ offer: offer("workspace") });
    const question = at(markup, "For whom?");
    expect(at(markup, "Findings opens for everyone in Kai Spezis.")).toBeGreaterThan(question);
    expect(at(markup, ">Only me<")).toBeGreaterThan(question);
    expect(at(markup, ">Kai Spezis<")).toBeGreaterThan(at(markup, ">Only me<"));
    expect(at(markup, ">Whole instance<")).toBeGreaterThan(at(markup, ">Kai Spezis<"));
    expect(held(markup)).toBe(false);
  });

  it("asks it in German for a German reader", () => {
    const markup = dialog({ offer: offer("self"), locale: "de" });
    expect(at(markup, "Für wen?")).toBeLessThan(at(markup, ">Nur für mich<"));
    expect(markup).toContain(">Ganze Instanz<");
    expect(markup).toContain("Nur du bekommst Version 3, wenn du die App öffnest.");
  });

  it("offers no whole instance where the instance does not", () => {
    const markup = dialog({ offer: offer("workspace", ["self", "workspace"]) });
    expect(markup).toContain(">Only me<");
    expect(markup).toContain(">Kai Spezis<");
    expect(markup).not.toContain("Whole instance");
    expect(dialog({ offer: offer("self", ["self", "workspace"]), locale: "de" })).not.toContain(
      "Ganze Instanz"
    );
  });

  it("names the chosen audience in the revision sentence", () => {
    expect(dialog({ offer: offer("self", undefined, "Only you") })).toContain(
      "Only you get version 3 when you open the app."
    );
    expect(dialog({ offer: offer("workspace") })).toContain(
      "Everyone in Kai Spezis gets version 3 when they open the app."
    );
    expect(dialog({ offer: offer("instance", undefined, "Everyone on the instance") })).toContain(
      "Everyone here gets version 3 when they open the app."
    );
  });

  it("holds Publish while the answer for a new choice is not there yet", () => {
    // The last answer was for the workspace; the reader chose "Only me" and its read loads.
    const markup = dialog({
      offer: offer("workspace"),
      selected: "self",
      narrative: { status: "loading" }
    });
    expect(markup).toContain('data-testid="publish-narrative-loading"');
    expect(held(markup)).toBe(true);
    // Even an answer in hand holds it while the offer is of another audience than the choice.
    expect(held(dialog({ offer: offer("workspace"), selected: "self" }))).toBe(true);
  });

  it("names the chosen people in the line on who sees the stored data (DS-13b)", () => {
    const sources: AppDataSources = {
      stores: [{ name: "kunden", title: "Kunden", fillers: [], actions: ["list"] }],
      revision: 3,
      audience: { workspace: { title: "Kai Spezis", members: 14 }, holders: [], hiddenHolders: 0 },
      truncated: false
    };
    const { t } = createTranslationContext("en");
    const storedData = appPublishDataRead(
      { data: sources, failed: false, retry: noop },
      3,
      t,
      "en"
    );
    const markup = dialog({ offer: offer("self", undefined, "Only you"), storedData });
    expect(markup).toMatch(/data-field="data-audience"[^>]*>(?:(?!<\/dd>).)*Only you/u);
    expect(markup).not.toContain("Everyone in Kai Spezis (14 people)");
  });

  it("hides the people of the choice before while the answer for a new choice loads", () => {
    const sources: AppDataSources = {
      stores: [{ name: "kunden", title: "Kunden", fillers: [], actions: ["list"] }],
      revision: 3,
      audience: { workspace: { title: "Kai Spezis", members: 14 }, holders: [], hiddenHolders: 0 },
      truncated: false
    };
    const { t } = createTranslationContext("en");
    const storedData = appPublishDataRead(
      { data: sources, failed: false, retry: noop },
      3,
      t,
      "en"
    );
    // The last answer was for the workspace; the reader chose "Only me" and its read loads.
    const markup = dialog({
      offer: offer("workspace", undefined, "Everyone in Kai Spezis"),
      selected: "self",
      narrative: { status: "loading" },
      storedData
    });
    const line = /data-field="data-audience"[^>]*>((?:(?!<\/dd>).)*)/u.exec(markup)?.[1] ?? "";
    expect(line).toContain('data-testid="app-publish-audience-pending"');
    expect(line).not.toContain("Everyone in Kai Spezis");
    expect(markup).not.toContain("Everyone in Kai Spezis (14 people)");
    // What the stores are stays while the people load.
    expect(markup).toContain('data-data-store="kunden"');
    expect(held(markup)).toBe(true);
  });

  it("asks as before where the instance offers no choice", () => {
    const markup = dialog({});
    expect(markup).not.toContain("For whom?");
    expect(held(markup)).toBe(false);
  });
});

describe("check 80: the Inbox item of a held App publish names the chosen audience", () => {
  const item = (audience: Record<string, unknown> | undefined, locale: "en" | "de" = "en") =>
    renderItem(
      {
        kind: "app_publish",
        summary: "assets.publish",
        preview: {
          runId: "opr_1",
          operation: "assets.publish",
          effect: "changing",
          actor: { kind: "user", id: "usr_kai", label: "Kai Member" },
          origin: { kind: "user" },
          inputs: [{ key: "revision", value: "3" }],
          review: {
            kind: "app",
            name: "findings",
            title: "Findings",
            revision: 3,
            files: [],
            hostsAdded: [],
            connections: [],
            dataStores: [],
            publishNarrative: {
              summary: "Findings opens for everyone in Kai Spezis.",
              warnings: []
            },
            ...(audience ? { audience } : {})
          }
        },
        canDecide: true
      },
      { locale }
    );

  it("shows who the requester chose before the sentence", () => {
    const markup = item({ selected: "workspace", label: "Everyone in Kai Spezis" });
    const audience = at(markup, 'data-testid="publish-review-audience"');
    expect(at(markup, "Everyone in Kai Spezis<")).toBeGreaterThan(audience);
    expect(at(markup, "Findings opens for everyone")).toBeGreaterThan(audience);
    expect(at(markup, ">For whom<")).toBeLessThan(audience);
  });

  it("says it in German", () => {
    expect(item({ selected: "self", label: "Nur Kai Member" }, "de")).toMatch(
      />Für wen<.*Nur Kai Member/u
    );
  });

  it("says whether the publish widens access, in both languages", () => {
    const widening = (widens: unknown, locale: "en" | "de" = "en") =>
      renderItem(
        {
          kind: "app_publish",
          summary: "assets.publish",
          preview: {
            runId: "opr_1",
            operation: "assets.publish",
            effect: "changing",
            actor: { kind: "user", id: "usr_kai", label: "Kai Member" },
            origin: { kind: "user" },
            inputs: [{ key: "revision", value: "3" }],
            review: {
              kind: "app",
              name: "findings",
              title: "Findings",
              revision: 3,
              files: [],
              hostsAdded: [],
              connections: [],
              dataStores: [],
              audience: { selected: "instance", label: "Everyone in the instance" },
              ...(widens === undefined ? {} : { publish_widens: widens })
            }
          },
          canDecide: true
        },
        { locale }
      );
    expect(widening(true)).toContain(">This publish widens access.<");
    expect(widening(false)).toContain(">This publish does not widen access.<");
    expect(widening(true, "de")).toContain(">Diese Veröffentlichung erweitert den Zugriff.<");
    expect(widening(false, "de")).toContain(
      ">Diese Veröffentlichung erweitert den Zugriff nicht.<"
    );
    expect(at(widening(true), 'data-testid="publish-review-widens"')).toBeGreaterThan(
      at(widening(true), 'data-testid="publish-review-audience"')
    );
    expect(widening(undefined)).not.toContain('data-testid="publish-review-widens"');
    expect(widening("yes")).not.toContain('data-testid="publish-review-widens"');
  });

  it("shows no audience for a request without one, or with one it cannot read", () => {
    expect(item(undefined)).not.toContain('data-testid="publish-review-audience"');
    expect(item({ selected: "everyone", label: "Everyone" })).not.toContain(
      'data-testid="publish-review-audience"'
    );
  });
});

const storedSources = (holders: AppDataSources["audience"] = undefined): AppDataSources => ({
  stores: [{ name: "kunden", title: "Kunden", fillers: [], actions: ["list"] }],
  revision: 3,
  audience: holders ?? {
    workspace: { title: "Kai Spezis", members: 14 },
    holders: [],
    hiddenHolders: 0
  },
  truncated: false
});
const storedDataOf = (sources: AppDataSources, locale: "en" | "de" = "en") =>
  appPublishDataRead(
    { data: sources, failed: false, retry: noop },
    3,
    createTranslationContext(locale).t,
    locale
  );
const audienceCell = (markup: string) =>
  /data-field="data-audience"[^>]*>((?:(?!<\/dd>).)*)/u.exec(markup)?.[1] ?? "";

describe("SHARE-1 fix round: audience-only publish", () => {
  it("lets the live revision be published again only for another audience", () => {
    const live = offer("workspace", undefined, "Everyone in Kai Spezis", {
      live: { audience: "workspace", label: "Everyone in Kai Spezis" }
    });
    expect(appPublishMaySend({ revision: 3, live: 3 }, live, "workspace")).toBe(false);
    expect(appPublishMaySend({ revision: 3, live: 3 }, live, "self")).toBe(true);
    expect(appPublishMaySend({ revision: 4, live: 3 }, live, "workspace")).toBe(true);
    expect(appPublishMaySend({ revision: 1, live: undefined }, undefined, undefined)).toBe(true);
    // "Only me" where the live revision is only another person's makes it live for someone else.
    const anna = offer("self", undefined, "Only me", {
      live: { audience: "self", label: "Only Anna" }
    });
    expect(appPublishMaySend({ revision: 3, live: 3 }, anna, "self")).toBe(true);
  });

  it("holds Publish in the dialog for the live revision and its own audience", () => {
    const live = { audience: "workspace" as const, label: "Everyone in Kai Spezis" };
    expect(
      held(dialog({ offer: offer("workspace", undefined, undefined, { live }), live: 3 }))
    ).toBe(true);
    const narrowed = dialog({
      offer: offer("self", undefined, "Only me", { live }),
      live: 3,
      narrative: ready("Findings opens only for you.")
    });
    expect(held(narrowed)).toBe(false);
  });
});

describe("SHARE-1 fix round: a narrower publisher of an instance-wide App", () => {
  const live = { audience: "instance" as const, label: "Everyone in the instance" };
  it("says who it is shared with now and who after publishing, in both languages", () => {
    const markup = dialog({
      offer: offer("workspace", ["self", "workspace"], "Everyone in Kai Spezis", { live }),
      live: 3
    });
    expect(markup).toContain(
      "Shared now: Everyone in the instance. After publishing: Everyone in Kai Spezis."
    );
    expect(markup).not.toContain("Whole instance");
    expect(at(markup, 'data-testid="app-publish-audience-change"')).toBeGreaterThan(
      at(markup, "For whom?")
    );
    expect(held(markup)).toBe(false);
    const german = dialog({
      offer: offer("workspace", ["self", "workspace"], "Alle in Kai Spezis", {
        live: { audience: "instance", label: "Alle in der Instanz" }
      }),
      live: 3,
      locale: "de"
    });
    expect(german).toContain(
      "Jetzt geteilt: Alle in der Instanz. Nach dem Veröffentlichen: Alle in Kai Spezis."
    );
  });

  it("says nothing about a change where the choice is the live audience", () => {
    const same = dialog({
      offer: offer("instance", undefined, "Everyone in the instance", { live }),
      live: 3
    });
    expect(same).not.toContain('data-testid="app-publish-audience-change"');
  });

  it("never names the people of another choice in the change line while a read loads", () => {
    const loading = dialog({
      offer: offer("workspace", ["self", "workspace"], "Everyone in Kai Spezis", { live }),
      selected: "self",
      narrative: { status: "loading" },
      live: 3
    });
    expect(loading).not.toContain('data-testid="app-publish-audience-change"');
  });
});

describe("SHARE-1 fix round: who sees the stored data", () => {
  it("names the people count, grant holders and the instance admins with a chosen audience", () => {
    const storedData = storedDataOf(
      storedSources({
        workspace: { title: "Kai Spezis", members: 14 },
        holders: [{ kind: "user", name: "usr_anna", title: "Anna Berg" }],
        hiddenHolders: 2
      })
    );
    const cell = audienceCell(
      dialog({
        offer: offer("workspace", undefined, "Everyone in Kai Spezis", { people: 14 }),
        storedData
      })
    );
    expect(cell).toContain("Everyone in Kai Spezis (14 people)");
    expect(cell).toContain("Also by a right on the app: Anna Berg · 2 more with access");
    expect(cell).toContain("Instance admins also have access.");
    expect(at(cell, "Instance admins")).toBeGreaterThan(at(cell, "Anna Berg"));
  });

  it("keeps the admins line under “Only me”, without a count, and says it in German", () => {
    const cell = audienceCell(
      dialog({
        offer: offer("self", undefined, "Only me", { people: 1 }),
        storedData: storedDataOf(storedSources())
      })
    );
    expect(cell).toContain("Only me");
    expect(cell).not.toContain("(1 person)");
    expect(cell).toContain("Instance admins also have access.");
    expect(cell).not.toContain("Also by a right on the app");
    const german = audienceCell(
      dialog({
        offer: offer("instance", undefined, "Alle in der Instanz", { people: 1 }),
        storedData: storedDataOf(storedSources(), "de"),
        locale: "de"
      })
    );
    expect(german).toContain("Alle in der Instanz (1 Person)");
    expect(german).toContain("Instanz-Admins haben ebenfalls Zugriff.");
  });
});

describe("SHARE-1 fix round: the agent's App publish asks “For whom?” before Allow", () => {
  const preview = (input: Record<string, unknown>) =>
    appPublishCall({ operationId: "assets.publish", inputPreview: input });

  it("reads the App, its revision, its workspace and the agent's suggestion", () => {
    expect(
      preview({ kind: "app", name: "findings", revision: 2, workspaceId: "cw_1", audience: "self" })
    ).toEqual({
      app: "findings",
      revision: 2,
      workspaceId: "cw_1",
      suggested: "self",
      workflows: [],
      dataStores: []
    });
    expect(preview({ kind: "app", name: "findings", revision: 2 })).toEqual({
      app: "findings",
      revision: 2,
      workspaceId: undefined,
      suggested: undefined,
      workflows: [],
      dataStores: []
    });
    // DP-3: the Workflows the call makes live with the App, by name.
    expect(
      preview({
        kind: "app",
        name: "findings",
        revision: 2,
        workflows: [{ name: "w", revision: 3 }]
      })
    ).toEqual(expect.objectContaining({ workflows: ["w"] }));
    expect(preview({ kind: "app", name: "findings", revision: 2, audience: "everyone" })).toEqual(
      expect.objectContaining({ suggested: undefined })
    );
    expect(preview({ kind: "workflow", name: "w", revision: 2 })).toBeUndefined();
    expect(
      appPublishCall({ operationId: "assets.put", inputPreview: { kind: "app", name: "x" } })
    ).toBeUndefined();
  });

  const idle: ToolDecisionAnswer = {
    decide: noop,
    pending: false,
    decided: undefined,
    failure: undefined
  };
  const card = (ready: boolean, answer: Partial<ToolDecisionAnswer> = {}) =>
    render(
      createElement(ToolDecisionCardView, {
        decision: {
          toolCallId: "call_1",
          operationRunId: "oprun_1",
          operationId: "assets.publish",
          mode: "confirm",
          inputPreview: { kind: "app", name: "findings", revision: 2, audience: "instance" },
          expiresAt: "2026-10-18T18:30:00Z"
        },
        title: "Publish an asset",
        toolName: "assets.publish",
        answer: { ...idle, ...answer },
        ask: {
          node: createElement("p", { "data-testid": "question" }, "For whom?"),
          audience: "workspace",
          ready
        }
      })
    );
  const allow = (markup: string) =>
    markup.match(/<button[^>]*>(?:(?!<\/button>).)*Allow<\/button>/u)?.[0] ?? "";

  it("asks the question before Allow and folds the raw inputs under Details", () => {
    const markup = card(false);
    // The question, then Details, then Allow: no input box between the question and Allow.
    expect(at(markup, 'data-testid="question"')).toBeLessThan(
      at(markup, 'data-testid="tool-decision-details"')
    );
    expect(at(markup, 'data-testid="tool-decision-details"')).toBeLessThan(at(markup, ">Allow<"));
    for (const key of ["kind", "name", "revision"]) {
      expect(markup).not.toContain(`data-input-key="${key}"`);
    }
    // Another tool's confirmation, without a question, still lists its inputs at once.
    const plain = render(
      createElement(ToolDecisionCardView, {
        decision: {
          toolCallId: "call_2",
          operationRunId: "oprun_2",
          operationId: "connections.crm.create_offer",
          mode: "confirm",
          inputPreview: { customer: "Müller GmbH" },
          expiresAt: "2026-10-18T18:30:00Z"
        },
        title: "Create an offer",
        toolName: "connection.crm.create_offer",
        answer: idle
      })
    );
    expect(at(plain, 'data-input-key="customer"')).toBeLessThan(
      at(plain, 'data-testid="tool-decision-details"')
    );
  });

  it("holds Allow until the question is answered", () => {
    const markup = card(false);
    expect(allow(markup)).toContain('disabled=""');
    expect(allow(card(true))).not.toContain('disabled=""');
    // The agent's suggestion is not listed as the input: the person's answer is.
    expect(markup).not.toContain('data-input-key="audience"');
  });

  it("takes the question away once the answer is taken", () => {
    expect(card(true, { decided: { decision: "confirm", audience: "workspace" } })).not.toContain(
      'data-testid="question"'
    );
  });
});

describe("check 80 on the agent's App publish: the chosen audience's data lines", () => {
  const live = ready("Findings opens for everyone in Kai Spezis.");
  const withHolders = storedDataOf(
    storedSources({
      workspace: { title: "Kai Spezis", members: 14 },
      holders: [{ kind: "user", name: "usr_anna", title: "Anna Berg" }],
      hiddenHolders: 0
    })
  );
  const view = (input: {
    offer: ReturnType<typeof offer>;
    selected?: Audience;
    narrative?: PublishNarrativeRead;
    storedData?: Parameters<typeof AppPublishConfirmationView>[0]["storedData"];
    locale?: "en" | "de";
  }) =>
    render(
      createElement(AppPublishConfirmationView, {
        offer: input.offer,
        selected: input.selected ?? input.offer.selected,
        workspaceName: "Kai Spezis",
        narrative: input.narrative ?? live,
        storedData: input.storedData,
        disabled: false,
        onChange: noop
      }),
      input.locale ?? "en"
    );

  it("names the chosen people, the App's other right holders and the instance admins", () => {
    const cell = audienceCell(
      view({
        offer: offer("workspace", undefined, "Everyone in Kai Spezis", { people: 14 }),
        storedData: withHolders
      })
    );
    expect(cell).toContain("Everyone in Kai Spezis (14 people)");
    expect(cell).toContain("Also by a right on the app: Anna Berg");
    expect(cell).toContain("Instance admins also have access.");
    const german = audienceCell(
      view({
        offer: offer("self", undefined, "Nur für mich", { people: 1 }),
        storedData: storedDataOf(storedSources(), "de"),
        locale: "de"
      })
    );
    expect(german).toContain("Nur für mich");
    expect(german).not.toContain("(1 Person)");
    expect(german).toContain("Instanz-Admins haben ebenfalls Zugriff.");
  });

  it("never names the people of the choice before while the new choice's answer loads", () => {
    const markup = view({
      offer: offer("instance", undefined, "Everyone in the instance", { people: 40 }),
      selected: "self",
      narrative: { status: "loading" },
      storedData: withHolders
    });
    const cell = audienceCell(markup);
    expect(cell).toContain('data-testid="app-publish-audience-pending"');
    expect(cell).not.toContain("Everyone in the instance");
    expect(markup).toContain('data-data-store="kunden"');
  });

  it("shows no data lines for a revision that reads no stored data", () => {
    const markup = view({ offer: offer("workspace") });
    expect(markup).not.toContain('data-field="data-audience"');
    expect(markup).toContain("Findings opens for everyone in Kai Spezis.");
  });

  it("holds Allow while the sentence or the required data lines load or failed", () => {
    const chosen = offer("workspace");
    const base = {
      offer: chosen,
      selected: "workspace" as const,
      narrative: live,
      readsStoredData: true,
      storedData: withHolders
    };
    expect(appPublishConfirmationReady(base)).toBe(true);
    expect(appPublishConfirmationReady({ ...base, storedData: { status: "loading" } })).toBe(false);
    expect(
      appPublishConfirmationReady({ ...base, storedData: { status: "failed", retry: noop } })
    ).toBe(false);
    expect(appPublishConfirmationReady({ ...base, narrative: { status: "loading" } })).toBe(false);
    expect(appPublishConfirmationReady({ ...base, selected: "self" })).toBe(false);
    expect(appPublishConfirmationReady({ ...base, readsStoredData: undefined })).toBe(false);
    // A plain App needs no data lines: the never-asked read does not hold it.
    expect(
      appPublishConfirmationReady({
        ...base,
        readsStoredData: false,
        storedData: { status: "loading" }
      })
    ).toBe(true);
  });
});
