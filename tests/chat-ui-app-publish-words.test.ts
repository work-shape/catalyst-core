import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  AppEditFrame,
  appManifestSummary,
  AppPublishConfirmationView,
  appWorkspaceName,
  PublishDialog
} from "@work-shape/catalyst-chat-ui/apps";
import type { PublishNarrativeRead } from "./support/chat-ui";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// ACCEPT-FIX-2 C5: an App's Publish question names its workspace one way, and its head says
// what is published. A Personal Workspace is named after its owner ("Mara's workspace"); the
// name stored on its row, "Personal workspace" in every language, is never shown beside it.
// An App published before SHARE-1 is live for its workspace, and the instance's label for that
// carries the stored name. After a publish the head says "Published · revision 1", not
// "Draft · revision 1".

const render = (node: ReactNode, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));
const noop = () => undefined;
const ready = (summary: string): PublishNarrativeRead => ({
  status: "ready",
  narrative: { summary, warnings: [] }
});
const STORED = "Personal workspace";
const ALL = { read: true, write: true, publish: true, delete: true };

/** What the instance offers a Personal Workspace's App that went live for its workspace. */
const legacyOffer = (locale: "en" | "de") => ({
  selected: "self" as const,
  choices: ["self", "instance"] as const,
  label: locale === "de" ? "Nur für mich" : "Only me",
  live: {
    audience: "workspace" as const,
    label: locale === "de" ? `Alle in ${STORED}` : `Everyone in ${STORED}`
  },
  workspaceName: STORED
});

const dialog = (locale: "en" | "de", name: string) =>
  render(
    createElement(PublishDialog, {
      name: "Urlaubsanträge",
      workspace: { id: "cw_mara", name, emoji: null },
      ask: {
        revision: 1,
        live: 1,
        summary: appManifestSummary({}),
        readsStoredData: false
      },
      loading: false,
      error: undefined,
      narrative: ready(locale === "de" ? "Urlaubsanträge öffnet sich nur für dich." : "Opens."),
      audience: { offer: legacyOffer(locale), selected: "self", onChange: noop },
      onConfirm: noop,
      onClose: noop
    }),
    locale
  );

describe("the Publish dialog of an App in a Personal Workspace", () => {
  it("names the workspace after its owner where it says who has the App now", () => {
    const german = dialog("de", "Maras Arbeitsbereich");
    expect(german).toContain(
      "Jetzt geteilt: Alle in Maras Arbeitsbereich. Nach dem Veröffentlichen: Nur für mich."
    );
    expect(german).not.toContain(STORED);
    const english = dialog("en", "Mara's workspace");
    expect(english).toContain(
      "Shared now: Everyone in Mara&#x27;s workspace. After publishing: Only me."
    );
    expect(english).not.toContain(STORED);
  });
});

describe("the confirmation of an agent's App publish", () => {
  it("names the open workspace as the interface shows it, not by its stored name", () => {
    const open = { id: "cw_mara", name: "Maras Arbeitsbereich" };
    expect(appWorkspaceName(undefined, open, STORED)).toBe("Maras Arbeitsbereich");
    expect(appWorkspaceName("cw_mara", open, STORED)).toBe("Maras Arbeitsbereich");
    // Another workspace than the open one is named as the instance names it.
    expect(appWorkspaceName("cw_sales", open, "Sales")).toBe("Sales");
    const card = render(
      createElement(AppPublishConfirmationView, {
        offer: legacyOffer("de"),
        selected: "self",
        workspaceName: appWorkspaceName(undefined, open, STORED),
        narrative: ready("Urlaubsanträge öffnet sich nur für dich."),
        storedData: undefined,
        disabled: false,
        onChange: noop
      }),
      "de"
    );
    expect(card).toContain("Jetzt geteilt: Alle in Maras Arbeitsbereich.");
    expect(card).not.toContain(STORED);
  });
});

describe("the head of an App's draft", () => {
  const head = (
    revisions: { draftRevision: number; publishedRevision?: number },
    locale: "en" | "de" = "en"
  ) =>
    render(
      createElement(AppEditFrame, {
        name: "Urlaubsanträge",
        workspace: { id: "cw_mara", name: "Maras Arbeitsbereich" },
        rights: ALL,
        ...revisions,
        children: null,
        onBack: noop
      }),
      locale
    );

  it("says the App is published once its draft is what is published", () => {
    const german = head({ draftRevision: 1, publishedRevision: 1 }, "de");
    expect(german).toContain("Veröffentlicht · Revision 1");
    expect(german).not.toContain("Entwurf · Revision 1");
    const english = head({ draftRevision: 1, publishedRevision: 1 });
    expect(english).toContain("Published · revision 1");
    expect(english).not.toContain("Draft · revision 1");
  });

  it("names the draft's number while the draft is ahead, and says when nothing is published", () => {
    expect(head({ draftRevision: 2, publishedRevision: 1 })).toContain("Draft · revision 2");
    expect(head({ draftRevision: 1 }, "de")).toContain("Entwurf · nicht veröffentlicht");
  });
});
