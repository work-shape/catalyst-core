import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import { AppEditFrame, AppsHostProvider, type AppsHost } from "@work-shape/catalyst-chat-ui/apps";
import { WorkflowPageView, toWorkflow } from "@work-shape/catalyst-chat-ui/workflows";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { dockConversationToReuse } from "./support/chat-ui";

// ACCEPT-1c C12: with the dock open beside an App's draft, "Edit with the agent" folded into
// the head's "…" menu, as every secondary action does where the head is narrow, and pressing it
// again made a second conversation. It now keeps its own place in the head, as its icon where
// room is short, and opens the dock's conversation about the same asset again.

const t = createTranslationContext("en").t;
const noop = () => undefined;
const render = (node: ReactNode) =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale: "en", children: node }));

/**
 * The head's secondary actions are drawn a second time in an inert row that measures whether
 * they fit; those are the ones that fold into "…". The agent action must never be one of them.
 */
function foldable(markup: string): string {
  return /<div inert=""[^>]*>.*?<\/div>/su.exec(markup)?.[0] ?? "";
}

/** The kept slot of the agent action: its labelled button and its icon twin. */
function keptSlot(markup: string): string {
  return (
    /<span data-head-agent-action=""[^>]*>.*?aria-label="[^"]*"[^>]*>.*?<\/button><\/span>/su.exec(
      markup
    )?.[0] ?? ""
  );
}

describe("Edit with the agent stays in sight beside the dock", () => {
  it("keeps its place in the head of an App's draft, never in the foldable actions", () => {
    const host: AppsHost = {
      enabled: true,
      rights: { read: true, write: true, publish: true, delete: false },
      workspace: { id: "cw_1", name: "Sales" },
      showRoute: noop,
      startChat: noop,
      editWithAgent: () => Promise.resolve()
    };
    const markup = render(
      createElement(AppsHostProvider, {
        value: host,
        children: createElement(AppEditFrame, {
          app: "orders",
          name: "Orders",
          workspace: { id: "cw_1", name: "Sales" },
          rights: { read: true, write: true, publish: true, delete: false },
          draftRevision: 4,
          publishedRevision: 3,
          view: "preview",
          detailsOpen: false,
          children: null,
          onViewChange: noop,
          onDetailsOpenChange: noop,
          onBack: noop,
          onDiscard: noop
        })
      })
    );
    const label = t("apps.editWithAgent");
    expect(keptSlot(markup)).toContain(`>${label}<`);
    expect(keptSlot(markup)).toContain(`aria-label="${label}"`);
    expect(foldable(markup)).not.toContain(label);
    // Discard still folds, as before.
    expect(foldable(markup)).toContain(t("apps.discard"));
  });

  it("keeps its place in the head of a Workflow", () => {
    const workflow = toWorkflow({
      name: "month-end",
      config: {
        id: "month-end",
        name: "Month end",
        runAs: "runner",
        inputs: { type: "object" },
        outputs: { type: "object" },
        steps: [{ id: "start", type: "trigger", name: "Start", triggers: [{ kind: "manual" }] }]
      },
      publishedRevision: 1
    });
    const markup = render(
      createElement(WorkflowPageView, {
        workspaceId: "cw_1",
        workflowId: "month-end",
        read: { workflow, problem: undefined, retry: noop },
        runsAvailable: true,
        edit: { busy: false, error: undefined, start: noop, startWith: noop, dismissError: noop },
        draft: undefined,
        onOpenChild: noop,
        onOpenRoute: noop,
        onStart: noop
      })
    );
    const label = t("workflows.edit.withAgent");
    expect(keptSlot(markup)).toContain(`aria-label="${label}"`);
    expect(foldable(markup)).not.toContain(label);
  });
});

describe("pressing Edit with the agent again", () => {
  const subject = { kind: "app", name: "orders" };
  const base = {
    dockConversationId: "conv_1",
    dock: { subject, collaborationWorkspaceId: "cw_1" },
    subject,
    workspaceId: "cw_1",
    prompt: undefined,
    draftText: ""
  };

  it("opens the dock's conversation about the same asset again", () => {
    expect(dockConversationToReuse(base)).toBe("conv_1");
    // Also with a half-typed message: nothing is put in the composer.
    expect(dockConversationToReuse({ ...base, draftText: "Make the" })).toBe("conv_1");
    // A prompt goes into an empty composer, or one that already holds it.
    expect(dockConversationToReuse({ ...base, prompt: "Fix it" })).toBe("conv_1");
    expect(dockConversationToReuse({ ...base, prompt: "Fix it", draftText: "Fix it" })).toBe(
      "conv_1"
    );
  });

  it("makes a new conversation where the dock's conversation is about the same name in another workspace", () => {
    // An App "orders" of another workspace is another App: its conversation is never opened
    // in this one, nor typed into.
    expect(
      dockConversationToReuse({
        ...base,
        dock: { subject, collaborationWorkspaceId: "cw_other" }
      })
    ).toBeUndefined();
    expect(
      dockConversationToReuse({
        ...base,
        dock: { subject, collaborationWorkspaceId: "cw_other" },
        prompt: "Fix it"
      })
    ).toBeUndefined();
  });

  it("makes a new conversation where the dock holds another one or the person's own words", () => {
    expect(dockConversationToReuse({ ...base, dockConversationId: undefined })).toBeUndefined();
    expect(dockConversationToReuse({ ...base, dock: undefined })).toBeUndefined();
    expect(
      dockConversationToReuse({ ...base, dock: { ...base.dock, subject: undefined } })
    ).toBeUndefined();
    expect(
      dockConversationToReuse({
        ...base,
        dock: { ...base.dock, subject: { kind: "app", name: "invoices" } }
      })
    ).toBeUndefined();
    expect(
      dockConversationToReuse({
        ...base,
        dock: { ...base.dock, subject: { kind: "workflow", name: "orders" } }
      })
    ).toBeUndefined();
    // A prompt never replaces what the person typed.
    expect(
      dockConversationToReuse({ ...base, prompt: "Fix it", draftText: "My own words" })
    ).toBeUndefined();
  });
});
