import { createElement, type ReactNode } from "react";
import type { ApprovalRequestView } from "@work-shape/catalyst-api-client";
import {
  approvalActionFailure,
  formatInboxAge,
  InboxAreaView,
  inboxItemKinds,
  InboxItemKindsProvider,
  inboxItemSurface,
  InboxItemView,
  InboxList,
  inboxListOutdatesItem,
  inboxRailEntry,
  inboxTabCount,
  inboxTabOfItem,
  inboxTabs,
  orderInboxItems,
  type InboxCounts,
  type InboxItemActions,
  type InboxItemKind,
  type InboxTab
} from "../packages/chat-ui/src/inbox";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// What the Inbox tests share: the Inbox modules themselves, one request to vary and the
// rendering of an item in a language.
export {
  approvalActionFailure,
  formatInboxAge,
  InboxAreaView,
  inboxItemKinds,
  inboxItemSurface,
  InboxItemView,
  InboxList,
  inboxListOutdatesItem,
  inboxRailEntry,
  inboxTabCount,
  inboxTabOfItem,
  inboxTabs,
  orderInboxItems,
  type InboxCounts,
  type InboxItemKind,
  type InboxTab
};

const skillChangePreview = {
  skillName: "payroll",
  skillTitle: "Gehaltsabrechnungen prüfen",
  isNewSkill: false,
  changes: [
    {
      type: "replace",
      target: "root",
      before: "Prüfe den Bruttolohn.",
      after: "Prüfe den Bruttolohn und die Steuerklasse."
    }
  ]
};

export function item(overrides: Partial<ApprovalRequestView> = {}): ApprovalRequestView {
  return {
    id: "apr_1",
    clientInstanceId: "client-1",
    kind: "skill_change",
    summary: "Bei Gehaltsabrechnungen auch die Steuerklasse prüfen.",
    payload: {},
    requestedBy: { id: "user-anna", displayLabel: "Anna Beispiel" },
    origin: {
      conversationId: "conv_1",
      agentRunId: "run_1",
      toolCallId: "call_1",
      agentName: "payroll-agent"
    },
    status: "pending",
    checks: [],
    createdAt: "2026-10-05T08:00:00Z",
    updatedAt: "2026-10-05T08:00:00Z",
    preview: skillChangePreview,
    canDecide: false,
    canWithdraw: false,
    canRevert: false,
    ...overrides
  };
}

export const decision = {
  approved: false,
  decidedBy: "user-felix",
  decidedByLabel: "Felix Pahlke",
  decidedAt: "2026-10-05T09:00:00Z",
  comment: "Bitte ohne Kundennamen."
};

export const idleActions: InboxItemActions = {
  pending: false,
  decide: () => undefined,
  withdraw: () => undefined,
  revert: () => undefined
};

export const now = new Date("2026-10-05T11:00:00Z");

export function render(node: ReactNode, locale: "de" | "en" = "de"): string {
  return renderToStaticMarkup(createElement(TranslationProvider, { children: null, locale }, node));
}

export function renderItem(
  overrides: Partial<ApprovalRequestView> = {},
  options: {
    actions?: InboxItemActions;
    locale?: "de" | "en";
    kinds?: readonly InboxItemKind[];
  } = {}
): string {
  const view = createElement(InboxItemView, {
    state: { status: "ready", request: item(overrides) },
    actions: options.actions ?? idleActions
  });
  return render(
    options.kinds ? createElement(InboxItemKindsProvider, { value: options.kinds }, view) : view,
    options.locale
  );
}
