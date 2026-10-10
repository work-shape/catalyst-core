import { FileText, type LucideIcon } from "lucide-react";
import { createContext, createElement, useContext, type ComponentType } from "react";
import type { ApprovalRequestView } from "@vivd-catalyst/api-client";
import { SkillChangeBody } from "../approvals/skill-change-body";
import { parseSkillChangePreview } from "../approvals/skill-change-preview";
import type { TranslationContextValue, TranslationKey } from "../i18n";
import type { InboxItemActions } from "./inbox-item-actions";

export type Translate = TranslationContextValue["t"];

/** One of the three answers the frame's foot can give. */
export type InboxDecision = "approve" | "reject" | "request_changes";

/**
 * What the client knows about one kind of Inbox item. The frame (the lists, the item panel, the
 * rail and the routes) is the same for every kind; a slice that adds a kind adds its body in a
 * file of its own and one entry to `inboxItemKinds`.
 */
export interface InboxItemKind {
  /** The Approval Request kind, as the server stores it. */
  kind: string;
  label: TranslationKey;
  icon: LucideIcon;
  /** One line that says what the item is about, for the row and the surface subtitle. */
  subject?(item: ApprovalRequestView, t: Translate): string | undefined;
  /** The middle of the item. It reads `item.preview` and nothing else from the server. */
  Body: ComponentType<{ item: ApprovalRequestView }>;
  /** Which of the three decisions the foot offers, with the kind's own words. Default: all three. */
  decisions?: readonly {
    decision: InboxDecision;
    label: TranslationKey;
  }[];
  /** Replaces the foot for a kind whose answers are not these three. */
  Foot?: ComponentType<{ item: ApprovalRequestView; actions: InboxItemActions }>;
}

/** The three decisions in the frame's own words, for a kind that names none. */
export const defaultInboxDecisions: NonNullable<InboxItemKind["decisions"]> = [
  { decision: "reject", label: "approvalReject" },
  { decision: "request_changes", label: "approvalRequestChanges" },
  { decision: "approve", label: "approvalAccept" }
];

const skillChange: InboxItemKind = {
  kind: "skill_change",
  label: "inbox.kindSkillChange",
  icon: FileText,
  subject(item, t) {
    const change = parseSkillChangePreview(item.preview);
    if (!change) {
      return undefined;
    }
    return change.isNewSkill
      ? `${t("skillChangeNewSkill")}: ${change.skillTitle}`
      : t("skillChangeConcerns", { skill: change.skillTitle });
  },
  Body: ({ item }) => createElement(SkillChangeBody, { preview: item.preview })
};

/**
 * The item kinds of the platform. This is deliberately not the client widget registry: an item
 * decides a change to the instance, so its body must not be replaceable by a client assembly.
 */
export const inboxItemKinds: readonly InboxItemKind[] = [skillChange];

const InboxItemKindsContext = createContext<readonly InboxItemKind[]>(inboxItemKinds);

/** Hands the frame another list of kinds than the platform's. Tests plant a kind through it. */
export const InboxItemKindsProvider = InboxItemKindsContext.Provider;

/** Finds the entry of a kind. A kind without one has none: the frame then shows its fallback. */
export function useInboxItemKindLookup(): (kind: string) => InboxItemKind | undefined {
  const kinds = useContext(InboxItemKindsContext);
  return (kind) => kinds.find((candidate) => candidate.kind === kind);
}
