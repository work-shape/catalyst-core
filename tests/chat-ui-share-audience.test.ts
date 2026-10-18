import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { appAudienceSchema } from "@work-shape/catalyst-api-contract";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import {
  appManifestSummary,
  appPublishCall,
  appPublishDataRead,
  appPublishMaySend,
  AppSavedLine,
  AppsHostProvider,
  PublishDialog,
  type AppsHost
} from "@work-shape/catalyst-chat-ui/apps";
import { appSavedByCall } from "@work-shape/catalyst-chat-ui/subject-run";
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
// requester chose; the first save of an App says who can use it now, with "Share".

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
    expect(markup).toContain("Nur du bekommst Revision 3, wenn du die App öffnest.");
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
      "Only you get revision 3 when you open the app."
    );
    expect(dialog({ offer: offer("workspace") })).toContain(
      "Everyone in Kai Spezis gets revision 3 when they open the app."
    );
    expect(dialog({ offer: offer("instance", undefined, "Everyone on the instance") })).toContain(
      "Everyone on this instance gets revision 3 when they open the app."
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

  it("says whether the publish widens the App's reach, in both languages", () => {
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
    expect(widening(true)).toContain(
      "Its reach widens: people who cannot use the app now can use it after this."
    );
    expect(widening(false)).toContain("Its reach does not widen: nobody new can use the app.");
    expect(widening(true, "de")).toContain("Die Reichweite wird größer:");
    expect(widening(false, "de")).toContain("Die Reichweite wird nicht größer:");
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

describe("the line the first save of an App leaves", () => {
  const save = (result: unknown, isError = false) =>
    appSavedByCall({ toolName: "app.save", result, isError });

  it("names a save that made the App and a later save of its draft, never a refused one", () => {
    expect(
      save({
        kind: "app",
        name: "findings",
        title: "Findings",
        saved: true,
        created: true,
        revision: 1
      })
    ).toEqual({ name: "findings", title: "Findings", created: true });
    expect(
      save({
        kind: "app",
        name: "findings",
        title: "Findings",
        saved: true,
        created: false,
        revision: 2
      })
    ).toEqual({ name: "findings", title: "Findings", created: false });
    expect(
      save({ kind: "app", name: "findings", title: "Findings", saved: false, message: "x" })
    ).toBeUndefined();
    expect(save(undefined)).toBeUndefined();
    expect(save({ name: "findings", saved: true, created: true }, true)).toBeUndefined();
    expect(
      appSavedByCall({
        toolName: "platform.assets.put",
        result: { name: "findings", saved: true, created: true }
      })
    ).toBeUndefined();
  });

  const host = (publish: boolean): AppsHost => ({
    enabled: true,
    rights: { read: true, write: true, publish, delete: false },
    workspace,
    showRoute: noop,
    startChat: noop
  });
  const line = (value: AppsHost | undefined, locale: "en" | "de" = "en", created = true) => {
    const node = createElement(AppSavedLine, {
      saved: { name: "findings", title: "Findings", created }
    });
    return render(
      value ? createElement(AppsHostProvider, { value, children: node }) : node,
      locale
    );
  };

  it("says the builder can use it now, with Share for a reader who may publish", () => {
    const markup = line(host(true));
    expect(markup).toContain(
      "Saved as the app Findings. You can use it now; others can once you share it."
    );
    expect(markup).toMatch(/data-testid="app-saved-share"[^>]*>Share<\/button>/u);
    expect(line(host(true), "de")).toContain(
      "Als App Findings gespeichert. Du kannst sie jetzt nutzen, andere, sobald du sie teilst."
    );
    expect(line(host(true), "de")).toContain(">Teilen</button>");
  });

  it("words a later save as the saved draft, never as an App nobody else may use", () => {
    const markup = line(host(true), "en", false);
    expect(markup).toContain(
      "Saved to the draft of Findings. You can use it now; others see the change once you share it."
    );
    expect(markup).not.toContain("others can once you share it");
    expect(markup).toContain(">Share</button>");
    expect(line(host(true), "de", false)).toContain(
      "Im Entwurf von Findings gespeichert. Du kannst ihn jetzt nutzen; andere sehen die Änderung, sobald du ihn teilst."
    );
  });

  it("offers no Share to a reader who may not publish, or outside a workspace", () => {
    expect(line(host(false))).not.toContain('data-testid="app-saved-share"');
    expect(line(undefined)).not.toContain('data-testid="app-saved-share"');
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
    ).toEqual({ app: "findings", revision: 2, workspaceId: "cw_1", suggested: "self" });
    expect(preview({ kind: "app", name: "findings", revision: 2 })).toEqual({
      app: "findings",
      revision: 2,
      workspaceId: undefined,
      suggested: undefined
    });
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

  it("shows the question before the call's inputs and holds Allow until it is answered", () => {
    const markup = card(false);
    expect(at(markup, 'data-testid="question"')).toBeLessThan(at(markup, 'data-input-key="kind"'));
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
