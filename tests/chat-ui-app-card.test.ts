import { createElement } from "react";
import type { PartState } from "@assistant-ui/react";
import { describe, expect, it, vi } from "vitest";
import {
  afterPublishSend,
  AppCard,
  AppCardView,
  appCardState,
  AppsHostProvider,
  type AppsHost
} from "@work-shape/catalyst-chat-ui/apps";
import { appSavedByCall, foldedCards } from "@work-shape/catalyst-chat-ui/subject-run";
import { createTranslationContext } from "./support/chat-ui/shared";
import {
  createAssistantMessageGroupBy,
  createCompletedAssistantWorkIndices,
  createVisibleFinalAssistantPartIndices
} from "./support/chat-ui";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// APPCARD-1 (check 68): a conversation in which the agent saved one App three times shows one
// App card, at the newest save, with "Open" and "Publish"; the earlier saves are lines in the
// run's work. The newest preview of a folder is a card in the same way, and a folder that a
// save made into an App has the App's card stand for it. The card reads the App's live state,
// and a publish from it tells the conversation so its agent carries on.

const save = (toolCallId: string, path = "apps/findings", created = false) => ({
  type: "tool-call",
  toolCallId,
  toolName: "app.save",
  args: { path, name: "Findings" },
  result: { kind: "app", name: "findings", title: "Findings", saved: true, created, revision: 1 }
});
const open = (toolCallId: string, path: string, number = 1) => ({
  type: "tool-call",
  toolCallId,
  toolName: "workspace.open",
  args: { path },
  result: { pageId: "page_1", fileSetId: `fs_${toolCallId}`, number }
});
const text = (value: string) => ({ type: "text", text: value });

describe("one card per App and per preview in a conversation", () => {
  it("folds three saves of one App into one card at the newest and two lines", () => {
    const folded = foldedCards([
      save("call_1", "apps/findings", true),
      text("Saved."),
      save("call_2"),
      save("call_3")
    ]);
    expect([...folded]).toEqual([
      ["call_1", "app_draft"],
      ["call_2", "app_draft"]
    ]);
  });

  it("decides the newest across the whole conversation, one App at a time", () => {
    const other = {
      ...save("call_b"),
      result: { kind: "app", name: "orders", title: "Orders", saved: true, created: true }
    };
    // Earlier runs and the run that goes are one list of parts, in the order of the thread.
    const folded = foldedCards([save("call_a1", "apps/findings", true), other, save("call_a2")]);
    expect(folded.get("call_a1")).toBe("app_draft");
    expect(folded.has("call_a2")).toBe(false);
    expect(folded.has("call_b")).toBe(false);
  });

  it("counts a call the thread shows twice, as it streams and from its projection, once", () => {
    const folded = foldedCards([save("call_1", "apps/findings", true), save("call_1")]);
    expect(folded.size).toBe(0);
  });

  it("leaves a refused save and a save that changed nothing out", () => {
    const refused = { ...save("call_2"), isError: true };
    const unchanged = {
      ...save("call_3"),
      result: { kind: "app", name: "findings", title: "Findings", saved: false, message: "x" }
    };
    expect(foldedCards([save("call_1", "apps/findings", true), refused, unchanged]).size).toBe(0);
  });

  it("keeps the newest preview of a folder as its card and folds the earlier ones", () => {
    const folded = foldedCards([
      open("call_o1", "drafts/report"),
      open("call_o2", "./drafts/report/", 2),
      open("call_x", "drafts/other")
    ]);
    expect([...folded]).toEqual([["call_o1", "preview"]]);
  });

  it("folds every preview of a folder a save made into an App: the App's card stands for it", () => {
    const folded = foldedCards([
      open("call_o1", "apps/findings"),
      save("call_s1", "apps/findings", true),
      open("call_o2", "apps/findings", 2),
      save("call_s2", "apps/findings")
    ]);
    expect(folded.get("call_o1")).toBe("preview");
    expect(folded.get("call_o2")).toBe("preview");
    expect(folded.get("call_s1")).toBe("app_draft");
    expect(folded.has("call_s2")).toBe(false);
  });

  it("keeps a preview that builds or that the build refused as its own card", () => {
    const building = { ...open("call_o2", "drafts/report"), result: undefined };
    const refused = {
      ...open("call_o3", "drafts/report"),
      result: { errors: [{ file: "index.html", message: "x" }] }
    };
    const folded = foldedCards([open("call_o1", "drafts/report"), building, refused]);
    expect(folded.size).toBe(0);
  });
});

describe("the work of a run with folded cards", () => {
  const toolCall = (call: ReturnType<typeof save>): PartState => ({
    type: "tool-call",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    args: call.args,
    argsText: "{}",
    result: call.result,
    status: { type: "complete" }
  });
  const parts: PartState[] = [
    toolCall(save("call_1", "apps/findings", true)),
    toolCall(save("call_2")),
    toolCall(save("call_3")),
    { type: "text", text: "Saved Findings.", status: { type: "complete" } }
  ];
  const folded = foldedCards(parts);

  it("puts an earlier save in the work and keeps the newest as a card after the run", () => {
    expect(createCompletedAssistantWorkIndices(parts, 3, folded)).toEqual([0, 1]);
    expect(createVisibleFinalAssistantPartIndices(parts, 3, folded)).toEqual([3, 2]);
    // Without folds, every save stood as a card of its own.
    expect(createCompletedAssistantWorkIndices(parts, 3)).toEqual([]);
  });

  it("groups an earlier save with the run's work while the run goes", () => {
    const groupBy = createAssistantMessageGroupBy(folded);
    const paths = parts.map((value) => groupBy(value, {}));
    expect(paths.slice(0, 3)).toEqual([["group-work"], ["group-work"], []]);
  });
});

const workspace = { id: "cw_1", name: "Kai Spezis", emoji: null };
const saved = { name: "findings", title: "Findings", created: true };
const route = {
  kind: "app-edit" as const,
  collaborationWorkspaceId: workspace.id,
  app: "findings"
};
const noop = () => undefined;
const card = (
  input: {
    state?: ReturnType<typeof appCardState>;
    open?: boolean;
    publish?: boolean;
  },
  locale: "en" | "de" = "en"
) =>
  renderToStaticMarkup(
    createElement(TranslationProvider, {
      locale,
      children: createElement(AppCardView, {
        saved,
        state: input.state ?? "saved_only_you",
        ...(input.open === false ? {} : { open: { route, onOpen: noop } }),
        ...(input.publish === false ? {} : { onPublish: noop })
      })
    })
  );

describe("the App's card", () => {
  it("reads the App's live state", () => {
    expect(appCardState({ revision: 3, draftRevision: 3 }, saved)).toBe("saved_only_you");
    expect(appCardState({ revision: 3, draftRevision: 3, publishedRevision: 2 }, saved)).toBe(
      "draft_saved"
    );
    expect(appCardState({ revision: 3, draftRevision: 3, publishedRevision: 3 }, saved)).toBe(
      "published"
    );
    // Until the record is read, the save says it.
    expect(appCardState(undefined, saved)).toBe("saved_only_you");
    expect(appCardState(undefined, { created: false })).toBe("draft_saved");
  });

  it("names the App with its state, Open and Publish, in German and English", () => {
    const de = card({}, "de");
    expect(de).toContain(">Findings</p>");
    expect(de).toContain("Gespeichert · nur für dich, noch nicht veröffentlicht");
    expect(de).toMatch(
      /<a[^>]*data-testid="app-card-open"[^>]*href="\/w\/cw_1\/app-drafts\/findings"[^>]*>Öffnen<\/a>/u
    );
    expect(de).toMatch(/data-testid="app-card-publish"[^>]*>Veröffentlichen<\/button>/u);
    expect(de).not.toContain("Teilen");
    expect(card({ state: "draft_saved" }, "de")).toContain(
      "Entwurf gespeichert · noch nicht veröffentlicht"
    );
    expect(card({ state: "published", publish: false }, "de")).toContain(">Veröffentlicht</p>");
    const en = card({ state: "draft_saved" });
    expect(en).toContain("Draft saved · not published yet");
    expect(en).toMatch(/data-testid="app-card-publish"[^>]*>Publish<\/button>/u);
    expect(en).not.toContain("Share");
  });

  it("offers only what its reader may do", () => {
    const reader = card({ open: false, publish: false });
    expect(reader).not.toContain("app-card-open");
    expect(reader).not.toContain("app-card-publish");
  });

  it("says what the save said outside a workspace shell, with nothing to press", () => {
    const host: AppsHost = {
      enabled: false,
      rights: { read: true, write: true, publish: true, delete: false },
      workspace,
      showRoute: noop,
      startChat: noop
    };
    const markup = renderToStaticMarkup(
      createElement(TranslationProvider, {
        locale: "en",
        children: createElement(AppsHostProvider, {
          value: host,
          children: createElement(AppCard, { saved })
        })
      })
    );
    expect(markup).toContain("Saved · only for you, not published yet");
    expect(markup).not.toContain("app-card-publish");
  });
});

describe("a publish from the App's card tells the conversation", () => {
  it("tells it once the draft went live, and not when the publish waits or was refused", () => {
    const tell = vi.fn(async (_text: string) => undefined);
    const { t } = createTranslationContext("de");
    const onClose = vi.fn();
    const onPublished = () => {
      tell(t("apps.cardPublishedTell", { title: "Findings" })).catch(() => undefined);
    };
    afterPublishSend("waits", { onClose, onPublished });
    afterPublishSend("failed", { onClose, onPublished });
    expect(tell).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    afterPublishSend("published", { onClose, onPublished });
    expect(tell).toHaveBeenCalledExactlyOnceWith("Ich habe „Findings“ veröffentlicht.");
    expect(onClose).toHaveBeenCalledOnce();
    expect(createTranslationContext("en").t("apps.cardPublishedTell", { title: "Findings" })).toBe(
      "I published “Findings”."
    );
  });

  it("names the App a save wrote, as the card shows it", () => {
    expect(appSavedByCall(save("call_1", "apps/findings", true))).toEqual(saved);
  });
});
