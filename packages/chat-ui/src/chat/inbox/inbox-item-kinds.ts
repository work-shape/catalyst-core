import { BookOpen, FileText, LayoutGrid, Workflow, Zap, type LucideIcon } from "lucide-react";
import { createContext, createElement, useContext, type ComponentType } from "react";
import type { ApprovalRequestView } from "@work-shape/catalyst-api-client";
import { OperationCallBody } from "../approvals/operation-call-body";
import {
  SKILL_ASSET_KIND,
  operationCallOutcome,
  parseOperationCallPreview,
  type OperationCallAsset
} from "../approvals/operation-call-preview";
import { SkillChangeBody } from "../approvals/skill-change-body";
import { parseSkillChangePreview } from "../approvals/skill-change-preview";
import type { TranslationContextValue, TranslationKey } from "../../shared/i18n";
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
  /** The icon of one item, where the item says more than its kind. */
  itemIcon?(item: ApprovalRequestView): LucideIcon | undefined;
  /** The surface's title for one item, where the item says more than the kind's label. */
  title?(item: ApprovalRequestView, t: Translate): string | undefined;
  /** One line that says what the item is about, for the surface subtitle. */
  subject?(item: ApprovalRequestView, t: Translate): string | undefined;
  /**
   * What the row and the item are headed with. A kind without one is headed with the summary
   * the request was filed with.
   */
  heading?(item: ApprovalRequestView, t: Translate): string | undefined;
  /** What the row says after who asked, such as the Namespace of what is asked. */
  rowDetail?(item: ApprovalRequestView, t: Translate): string | undefined;
  /**
   * The middle of the item. It reads `item.preview`, and from the item itself only what the
   * server recorded on the request.
   */
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
  Body: ({ item }) => {
    // An approved change that a guardrail blocked when it was to be applied says why.
    const outcome = operationCallOutcome(item);
    return createElement(SkillChangeBody, {
      preview: item.preview,
      ...(outcome?.outcome === "refused" ? { refusal: outcome.reason ?? "" } : {})
    });
  }
};

/** The skill a held call saves, where it saves one. */
function savedSkill(item: ApprovalRequestView): OperationCallAsset | undefined {
  const asset = parseOperationCallPreview(item.preview)?.asset;
  return asset?.kind === SKILL_ASSET_KIND ? asset : undefined;
}

function savedSkillTitle(skill: OperationCallAsset, t: Translate): string {
  return t(skill.isNew ? "skillChangeNewSkill" : "inbox.kindSkillChange");
}

/**
 * An operation call that waits for another person's approval. A call that saves a skill is
 * named as that skill, new or changed; every other call is an action to approve. The approver
 * cannot edit the call, so there is no request for changes: it runs as it is, or it does not
 * run.
 */
const operationCall: InboxItemKind = {
  kind: "operation_call",
  label: "inbox.kindOperationCall",
  icon: Zap,
  itemIcon: (item) => (savedSkill(item) ? BookOpen : undefined),
  title(item, t) {
    const skill = savedSkill(item);
    return skill ? savedSkillTitle(skill, t) : undefined;
  },
  subject(item, t) {
    const skill = savedSkill(item);
    if (skill) {
      return skill.title;
    }
    const call = parseOperationCallPreview(item.preview);
    return call
      ? t("operations.callSubject", { operation: call.operation, actor: call.actor.label })
      : undefined;
  },
  heading(item, t) {
    const skill = savedSkill(item);
    if (skill) {
      return `${savedSkillTitle(skill, t)}: ${skill.title}`;
    }
    return parseOperationCallPreview(item.preview) ? t("inbox.kindOperationCall") : undefined;
  },
  rowDetail(item) {
    const call = parseOperationCallPreview(item.preview);
    return call?.asset ? call.asset.namespace : call?.operation;
  },
  Body: ({ item }) => createElement(OperationCallBody, { request: item }),
  decisions: [
    { decision: "reject", label: "operations.callDecline" },
    { decision: "approve", label: "operations.callApprove" }
  ]
};

/**
 * A publish of an App or a Workflow that waits for an approver: a held call of `assets.publish`
 * whose item shows what the version makes live. The approver cannot edit it, so there is no
 * request for changes.
 */
function publishKind(kind: string, label: TranslationKey, icon: LucideIcon): InboxItemKind {
  return {
    ...operationCall,
    kind,
    label,
    icon,
    itemIcon: () => undefined,
    title: () => undefined,
    subject(item) {
      return parseOperationCallPreview(item.preview)?.review?.title;
    },
    heading: (_item, t) => t(label),
    rowDetail: (item) => parseOperationCallPreview(item.preview)?.review?.title,
    decisions: [
      { decision: "reject", label: "operations.callDecline" },
      { decision: "approve", label: "operations.publishApprove" }
    ]
  };
}

/**
 * The item kinds of the platform. This is deliberately not the client widget registry: an item
 * decides a change to the instance, so its body must not be replaceable by a client assembly.
 */
export const inboxItemKinds: readonly InboxItemKind[] = [
  skillChange,
  operationCall,
  publishKind("app_publish", "inbox.kindAppPublish", LayoutGrid),
  publishKind("workflow_publish", "inbox.kindWorkflowPublish", Workflow)
];

const InboxItemKindsContext = createContext<readonly InboxItemKind[]>(inboxItemKinds);

/** Hands the frame another list of kinds than the platform's. Tests plant a kind through it. */
export const InboxItemKindsProvider = InboxItemKindsContext.Provider;

/** Finds the entry of a kind. A kind without one has none: the frame then shows its fallback. */
export function useInboxItemKindLookup(): (kind: string) => InboxItemKind | undefined {
  const kinds = useContext(InboxItemKindsContext);
  return (kind) => kinds.find((candidate) => candidate.kind === kind);
}
