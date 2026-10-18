import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { appAudienceSchema } from "@work-shape/catalyst-api-contract";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import {
  appManifestSummary,
  appPublishDataRead,
  AppSavedLine,
  AppsHostProvider,
  PublishDialog,
  type AppsHost
} from "@work-shape/catalyst-chat-ui/apps";
import { appSavedByCall } from "@work-shape/catalyst-chat-ui/subject-run";
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
  label = "Everyone in Kai Spezis"
) => ({ selected, choices, label });

const dialog = (input: {
  narrative?: PublishNarrativeRead;
  offer?: ReturnType<typeof offer>;
  selected?: Audience;
  storedData?: Parameters<typeof PublishDialog>[0]["storedData"];
  locale?: "en" | "de";
}) =>
  render(
    createElement(PublishDialog, {
      name: "Findings",
      workspace,
      ask: {
        revision: 3,
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
