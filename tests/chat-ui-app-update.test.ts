import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "./support/chat-ui/shared";
import {
  NO_APP_RIGHTS,
  pageAppChoice,
  previewNeedsApp,
  previewStanding,
  previewStateLine,
  SaveAsAppDialogView,
  UpdateAppAction,
  UpdateAppDialogView,
  type AppRights,
  type AppsHost
} from "@work-shape/catalyst-chat-ui/apps";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

const { t } = createTranslationContext("en");
const de = createTranslationContext("de").t;

const render = (node: ReactNode, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));

const workspace = { id: "cw_1", name: "Nordlicht Beratung", emoji: null };
const WRITER: AppRights = { read: true, write: true, publish: false, delete: false };

// Every test of this block fails without Save to draft (first named Update app): the choice, the
// action and the dialog did not exist, and the header of a Page offered Save as app whatever the
// Page had been saved as.
describe("Save to draft", () => {
  const host = (overrides: Partial<AppsHost> = {}): AppsHost => ({
    enabled: true,
    rights: WRITER,
    workspace,
    showRoute() {},
    startChat() {},
    ...overrides
  });
  const app = {
    name: "angebotsrechner",
    title: "Angebotsrechner",
    workspaceId: "cw_1",
    draftRevision: 1,
    draftFromPage: true
  };
  const dialog = (
    overrides: Partial<Parameters<typeof UpdateAppDialogView>[0]> = {},
    locale: "en" | "de" = "en"
  ) =>
    render(
      createElement(UpdateAppDialogView, {
        name: "Angebotsrechner",
        phase: "idle",
        changedElsewhere: false,
        failure: undefined,
        onClose() {},
        onUpdate() {},
        onOpen() {},
        ...overrides
      }),
      locale
    );

  const named = { kind: "app", title: "Angebotsrechner" } as const;
  const unsaved = { kind: "unsaved" } as const;
  const neutral = { kind: "neutral" } as const;

  it("offers the update of the App a Page was saved as, and Save as app for a Page no App holds", () => {
    expect(pageAppChoice(host(), { app, preview: named, settled: true })).toEqual({
      kind: "update",
      app
    });
    expect(pageAppChoice(host(), { app: undefined, preview: unsaved, settled: true })).toEqual({
      kind: "save"
    });
    // The instance names a writable App only to whoever may write it, so the update needs no
    // right of the open workspace; Save as app does.
    const reader = host({ rights: { ...NO_APP_RIGHTS, read: true } });
    expect(pageAppChoice(reader, { app, preview: named, settled: true })).toEqual({
      kind: "update",
      app
    });
    expect(pageAppChoice(reader, { app: undefined, preview: unsaved, settled: true })).toEqual({
      kind: "none"
    });
  });

  // Fails without the reader's standing of PREVIEW-1: a checkout whose App the reader may only
  // read, or not see, offered Save as app to whoever may write Apps in the open workspace.
  it("offers no save for the checkout of an App the reader may not write, whatever the workspace allows", () => {
    expect(pageAppChoice(host(), { app: undefined, preview: named, settled: true })).toEqual({
      kind: "none"
    });
    expect(pageAppChoice(host(), { app: undefined, preview: neutral, settled: true })).toEqual({
      kind: "none"
    });
  });

  it("offers neither before the instance said whether the Page has an App, where it could not say, nor with the module off", () => {
    expect(pageAppChoice(host(), { app: undefined, settled: false })).toEqual({ kind: "none" });
    // A read that failed settles without a preview: the Page may still be an App's checkout.
    expect(pageAppChoice(host(), { app: undefined, settled: true })).toEqual({ kind: "none" });
    expect(pageAppChoice(host({ enabled: false }), { app, settled: true })).toEqual({
      kind: "none"
    });
    expect(pageAppChoice(host({ workspace: undefined }), { app, settled: true })).toEqual({
      kind: "none"
    });
    expect(pageAppChoice(undefined, { app, settled: true })).toEqual({ kind: "none" });
  });

  it("stands in the header of the Page with its words and, where the header is narrow, its icon", () => {
    const markup = render(
      createElement(UpdateAppAction, { conversationId: "conv_1", pageId: "page_1", app })
    );

    expect(markup).toContain(">Save to draft</button>");
    expect(markup.match(/<button/gu)).toHaveLength(2);
    expect(markup).toContain('aria-label="Save to draft"');
    expect(markup).not.toContain("Save as app");
  });

  it("names the App and says that nothing is published before it writes", () => {
    const markup = dialog();

    expect(markup).toContain("Save to the draft of “Angebotsrechner”?");
    expect(markup).toContain(
      "This preview as it is now becomes the draft of the app. Nothing is published."
    );
    expect(markup).toContain(">Save to draft</button>");
    expect(markup).toContain(">Cancel</button>");
    expect(markup).not.toContain("Replace draft");
    expect(markup).not.toContain("changed somewhere else");
  });

  it("holds both buttons while the update is on its way", () => {
    const markup = dialog({ phase: "working" });

    expect(markup.match(/<button[^>]*disabled=""/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(markup).toContain('aria-busy="true"');
  });

  it("says that the draft was changed somewhere else, and replaces it only by a button that says so", () => {
    const markup = dialog({ changedElsewhere: true });

    expect(markup).toContain(
      "The draft of this app was changed somewhere else since this preview last saved to it. Saving replaces those changes."
    );
    expect(markup).toContain(">Replace draft</button>");
    expect(markup).not.toContain(">Save to draft</button>");
  });

  it("says the draft is saved and not published, with Publish for whoever may publish", () => {
    const markup = dialog({ phase: "done", onPublish() {} });

    expect(markup).toContain("Saved to the draft");
    expect(markup).toContain("Not published yet. Others see the change only once you publish.");
    expect(markup).toContain(">Publish</button>");
    expect(markup).toContain(">Close</button>");
    expect(markup).not.toContain(">Open app</button>");
    expect(markup).not.toContain(">Save to draft</button>");
    // A saved draft is not live: no check mark, and nothing says "updated".
    expect(markup).not.toContain('data-tone="success"');
    expect(markup).not.toContain("updated");
  });

  it("offers the App's page in place of Publish to whoever may not publish", () => {
    const markup = dialog({ phase: "done" });

    expect(markup).toContain(">Open app</button>");
    expect(markup).not.toContain(">Publish</button>");
  });

  it("keeps the question open under a refusal, with what the instance said", () => {
    const markup = dialog({ phase: "failed", failure: t("apps.updateFailed") });

    expect(markup).toContain("The draft could not be saved.");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(">Save to draft</button>");
  });

  it("is written in German as well", () => {
    expect(de("apps.update")).toBe("Im Entwurf speichern");
    const question = dialog({}, "de");
    expect(question).toContain("In den Entwurf von „Angebotsrechner“ speichern?");
    expect(question).toContain(
      "Diese Vorschau wird so, wie sie jetzt ist, zum Entwurf der App. Veröffentlicht wird dabei nichts."
    );
    expect(question).toContain(">Im Entwurf speichern</button>");
    expect(question).toContain(">Abbrechen</button>");
    const asked = dialog({ changedElsewhere: true }, "de");
    expect(asked).toContain(">Entwurf ersetzen</button>");
    expect(asked).toContain("an anderer Stelle geändert");
    const done = dialog({ phase: "done", onPublish() {} }, "de");
    expect(done).toContain("Im Entwurf gespeichert");
    expect(done).toContain(
      "Noch nicht veröffentlicht. Andere sehen die Änderung erst, wenn du veröffentlichst."
    );
    expect(done).toContain(">Veröffentlichen</button>");
    expect(done).toContain(">Schließen</button>");
    expect(done).not.toContain("aktualisiert");
    expect(dialog({ phase: "done" }, "de")).toContain(">App öffnen</button>");
  });
});

// Every test of this block fails without PREVIEW-1: the head of a preview did not say whether it
// showed a folder no App holds or an App's checkout, which looks like the App and is not it.
describe("the state line of a preview", () => {
  const host = { enabled: true, workspace };
  const app = {
    name: "umsatz",
    title: "Umsatzübersicht",
    workspaceId: "cw_1",
    draftRevision: 3,
    draftFromPage: true
  };
  const named = { kind: "app", title: "Umsatzübersicht" } as const;
  const lineOfApp = {
    en: "Preview of “Umsatzübersicht” · data stores and workflows run only in the app",
    de: "Vorschau von „Umsatzübersicht“ · Datenspeicher und Workflows laufen nur in der App"
  };

  it("names a folder no App holds as not saved, and an App's checkout as a preview of the App", () => {
    const unsaved = previewStanding(host, {
      app: undefined,
      preview: { kind: "unsaved" },
      settled: true
    });
    expect(unsaved).toEqual({ kind: "unsaved" });
    expect(previewStateLine(unsaved, t)).toBe("Preview · not saved yet");
    expect(previewStateLine(unsaved, de)).toBe("Vorschau · noch nicht gespeichert");

    const checkout = previewStanding(host, { app, preview: named, settled: true });
    expect(checkout).toEqual({ kind: "app", title: "Umsatzübersicht", app });
    expect(previewStateLine(checkout, t)).toBe(lineOfApp.en);
    expect(previewStateLine(checkout, de)).toBe(lineOfApp.de);
  });

  // Fails without the reader's standing of PREVIEW-1: the checkout of an App the reader may read
  // and not write read as "not saved yet", because the instance named only Apps one may write.
  it("names the App to whoever may only read it, without the way to its draft", () => {
    const reading = previewStanding(host, { app: undefined, preview: named, settled: true });
    expect(reading).toEqual({ kind: "app", title: "Umsatzübersicht", app: undefined });
    expect(previewStateLine(reading, t)).toBe(lineOfApp.en);
    expect(previewStateLine(reading, de)).toBe(lineOfApp.de);
  });

  it("calls the checkout of an App the reader may not see a preview, and names nothing", () => {
    const hidden = previewStanding(host, {
      app: undefined,
      preview: { kind: "neutral" },
      settled: true
    });
    expect(hidden).toEqual({ kind: "neutral" });
    expect(previewStateLine(hidden, t)).toBe("Preview");
    expect(previewStateLine(hidden, de)).toBe("Vorschau");
  });

  it("says nothing before the instance answered, and no more than a preview where it could not say", () => {
    expect(previewStanding(host, { app, settled: false })).toEqual({ kind: "unknown" });
    expect(previewStateLine({ kind: "unknown" }, t)).toBeUndefined();
    const failed = previewStanding(host, { app: undefined, settled: true });
    expect(failed).toEqual({ kind: "neutral" });
    expect(previewStateLine(failed, t)).toBe("Preview");
    expect(previewStateLine(failed, de)).toBe("Vorschau");
  });

  it("says nothing where no Apps are offered", () => {
    expect(previewStanding({ enabled: false, workspace }, { app, settled: true })).toEqual({
      kind: "unknown"
    });
    expect(
      previewStanding({ enabled: true, workspace: undefined }, { app, settled: true })
    ).toEqual({ kind: "unknown" });
    expect(previewStanding(undefined, { app, settled: true })).toEqual({ kind: "unknown" });
  });

  it("leads to the App after a refused call only whoever may write it, and to Save as app only for a Page no App holds", () => {
    const writer = previewStanding(host, { app, preview: named, settled: true });
    expect(previewNeedsApp(writer, false)).toEqual({ message: "pages.needsApp", app });
    const unsaved = previewStanding(host, {
      app: undefined,
      preview: { kind: "unsaved" },
      settled: true
    });
    expect(previewNeedsApp(unsaved, true)).toEqual({ message: "pages.needsAppUnsaved" });
    expect(previewNeedsApp(unsaved, false)).toEqual({ message: "pages.needsAppNoWay" });
    const reading = previewStanding(host, { app: undefined, preview: named, settled: true });
    expect(previewNeedsApp(reading, true)).toEqual({ message: "pages.needsAppNoWay" });
    expect(previewNeedsApp({ kind: "neutral" }, true)).toEqual({ message: "pages.needsAppNoWay" });
    expect(previewNeedsApp({ kind: "unknown" }, true)).toEqual({ message: "pages.needsAppNoWay" });
    expect(t("pages.needsAppNoWay")).toBe("This preview reaches no data stores.");
    expect(de("pages.needsAppNoWay")).toBe("Diese Vorschau erreicht keine Datenspeicher.");
  });
});

// Every test of this block fails without the way into an existing App: Save as app answered a
// taken id with a sentence alone, and the dialog knew no App that is not the Page's yet.
describe("a Page put into an App that has the id", () => {
  const taken = {
    name: "angebotsrechner",
    title: "Angebotsrechner",
    workspaceId: "cw_1",
    draftRevision: 4,
    page: "none" as const
  };
  const save = (
    onLink: (() => void) | undefined,
    locale: "en" | "de" = "en",
    proposedName = "Angebotsrechner"
  ) =>
    render(
      createElement(SaveAsAppDialogView, {
        workspaceName: "Nordlicht Beratung",
        proposedName,
        saving: false,
        failure: {
          name: "Angebotsrechner",
          field: "name",
          message: (locale === "en" ? t : de)("apps.saveNameTakenWritable", { name: taken.title }),
          taken
        },
        onClose() {},
        onLink,
        onSave() {}
      }),
      locale
    );
  const dialog = (
    overrides: Partial<Parameters<typeof UpdateAppDialogView>[0]> = {},
    locale: "en" | "de" = "en"
  ) =>
    render(
      createElement(UpdateAppDialogView, {
        name: "Angebotsrechner",
        pageName: "Angebotsrechner",
        phase: "idle",
        link: "none",
        changedElsewhere: false,
        failure: undefined,
        onClose() {},
        onUpdate() {},
        onOpen() {},
        ...overrides
      }),
      locale
    );

  it("names the App that has the id and offers to save the Page to its draft", () => {
    const markup = save(() => undefined);

    expect(markup).toContain(
      "This name is already taken by the app “Angebotsrechner”. Choose another name, or save to its draft."
    );
    expect(markup).toContain(">Save to this app&#x27;s draft</button>");
    // Without somebody to take the App over, the sentence stands alone.
    expect(save(undefined)).not.toContain("Save to this app");
    // Once the name is changed, neither the refusal nor the offer stands.
    expect(save(() => undefined, "en", "Angebotsrechner neu")).not.toContain("Angebotsrechner”");
  });

  it("says that the draft is replaced and that nothing published changes, before it writes", () => {
    const markup = dialog();

    expect(markup).toContain("Save this preview to the draft of “Angebotsrechner”?");
    expect(markup).toContain(
      "The current draft of this app is replaced by this preview as it is now. The published version does not change until someone publishes the draft."
    );
    expect(markup).toContain(">Replace draft</button>");
    expect(markup).not.toContain(">Save to draft</button>");
    expect(markup).not.toContain("another conversation");
  });

  it("names that the App was last saved from another Page", () => {
    expect(dialog({ link: "other_conversation" })).toContain(
      "This app was last saved from a preview in another conversation. That preview will no longer show “Save to draft” for it."
    );
    expect(dialog({ link: "other_page" })).toContain(
      "This app was last saved from another preview of this conversation."
    );
  });

  it("says that the draft moved while the question stood", () => {
    expect(dialog({ changedElsewhere: true })).toContain(
      "The draft of this app was changed just now. If you replace it, that change is lost."
    );
  });

  it("confirms the draft, and says that the App keeps its name where the Page has another", () => {
    const same = dialog({ phase: "done" });
    expect(same).toContain("Saved to the draft");
    expect(same).not.toContain("keeps its name");

    const other = dialog({ phase: "done", pageName: "Angebotsrechner 2026" });
    expect(other).toContain(
      "The app keeps its name “Angebotsrechner”. The preview is called “Angebotsrechner 2026”."
    );
    // An update of the Page's own App says the same about the name.
    const own = dialog({ phase: "done", link: undefined, pageName: "Angebotsrechner 2026" });
    expect(own).toContain("The app keeps its name “Angebotsrechner”.");
  });

  it("is written in German as well", () => {
    const taken = save(() => undefined, "de");
    expect(taken).toContain(
      "Dieser Name ist schon an die App „Angebotsrechner“ vergeben. Wähle einen anderen Namen, oder speichere im Entwurf dieser App."
    );
    expect(taken).toContain(">Im Entwurf dieser App speichern</button>");
    const asked = dialog({ link: "other_conversation" }, "de");
    expect(asked).toContain("Diese Vorschau in den Entwurf von „Angebotsrechner“ speichern?");
    expect(asked).toContain(
      "Die veröffentlichte Version ändert sich erst, wenn jemand den Entwurf veröffentlicht."
    );
    expect(asked).toContain("in einer anderen Unterhaltung");
    expect(dialog({ phase: "done", pageName: "Rechner" }, "de")).toContain(
      "Die App behält ihren Namen „Angebotsrechner“. Die Vorschau heißt „Rechner“."
    );
  });
});
