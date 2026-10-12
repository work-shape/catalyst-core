import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@vivd-catalyst/chat-ui";
import {
  NO_APP_RIGHTS,
  pageAppChoice,
  UpdateAppAction,
  UpdateAppDialogView,
  type AppRights,
  type AppsHost
} from "@vivd-catalyst/chat-ui/apps";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

const { t } = createTranslationContext("en");
const de = createTranslationContext("de").t;

const render = (node: ReactNode, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));

const workspace = { id: "cw_1", name: "Nordlicht Beratung", emoji: null };
const WRITER: AppRights = { read: true, write: true, publish: false, delete: false };

// Every test of this block fails without Update app: the choice, the action and the dialog did
// not exist, and the header of a Page offered Save as app whatever the Page had been saved as.
describe("Update app", () => {
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

  it("offers the update of the App a Page was saved as, and Save as app for every other Page", () => {
    expect(pageAppChoice(host(), { app, settled: true })).toEqual({ kind: "update", app });
    expect(pageAppChoice(host(), { app: undefined, settled: true })).toEqual({ kind: "save" });
    // The instance names an App only to whoever may write it, so the update needs no right of
    // the open workspace; Save as app does.
    const reader = host({ rights: { ...NO_APP_RIGHTS, read: true } });
    expect(pageAppChoice(reader, { app, settled: true })).toEqual({ kind: "update", app });
    expect(pageAppChoice(reader, { app: undefined, settled: true })).toEqual({ kind: "none" });
  });

  it("offers neither before the instance said whether the Page has an App, nor with the module off", () => {
    expect(pageAppChoice(host(), { app: undefined, settled: false })).toEqual({ kind: "none" });
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

    expect(markup).toContain(">Update app</button>");
    expect(markup.match(/<button/gu)).toHaveLength(2);
    expect(markup).toContain('aria-label="Update app"');
    expect(markup).not.toContain("Save as app");
  });

  it("names the App and says that nothing is published before it writes", () => {
    const markup = dialog();

    expect(markup).toContain("Update “Angebotsrechner”?");
    expect(markup).toContain(
      "The page as it is now becomes the draft of this app. People who use the app see the change only once the draft is published."
    );
    expect(markup).toContain(">Update draft</button>");
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
      "The draft of this app was changed somewhere else since it was last updated from this page. Updating replaces those changes."
    );
    expect(markup).toContain(">Replace draft</button>");
    expect(markup).not.toContain(">Update draft</button>");
  });

  it("confirms with the App's name and the way to its draft", () => {
    const markup = dialog({ phase: "done" });

    expect(markup).toContain("“Angebotsrechner” is updated");
    expect(markup).toContain(
      "The draft of the app now holds this page as it is. Open the app to check the draft and publish it."
    );
    expect(markup).toContain(">Open app</button>");
    expect(markup).toContain(">Close</button>");
    expect(markup).not.toContain(">Update draft</button>");
  });

  it("keeps the question open under a refusal, with what the instance said", () => {
    const markup = dialog({ phase: "failed", failure: t("apps.updateFailed") });

    expect(markup).toContain("The app could not be updated.");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(">Update draft</button>");
  });

  it("is written in German as well", () => {
    expect(de("apps.update")).toBe("App aktualisieren");
    const asked = dialog({ changedElsewhere: true }, "de");
    expect(asked).toContain("„Angebotsrechner“ aktualisieren?");
    expect(asked).toContain(">Entwurf ersetzen</button>");
    expect(asked).toContain("an anderer Stelle geändert");
    const done = dialog({ phase: "done" }, "de");
    expect(done).toContain("„Angebotsrechner“ ist aktualisiert");
    expect(done).toContain(">App öffnen</button>");
  });
});
