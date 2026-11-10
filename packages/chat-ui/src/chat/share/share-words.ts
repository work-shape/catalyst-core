import {
  CONVERSATION_SHARE_REFUSALS,
  type ConversationShareRefusal
} from "@work-shape/catalyst-core";
import { ApiError } from "@work-shape/catalyst-api-client";
import type { TranslationContextValue, TranslationKey } from "../../shared/i18n";

type Translate = TranslationContextValue["t"];

// The sentence of each refusal of a share, a removal or a leave, by the reason the instance
// gives it (CHAT-SHARE). A reason added in core does not compile until it has its sentence.
const refusalKeys: Record<ConversationShareRefusal, TranslationKey> = {
  personal_conversation_private: "chatShare.refusal.personal_conversation_private",
  data_store_conversation_private: "chatShare.refusal.data_store_conversation_private",
  subject_conversation_private: "chatShare.refusal.subject_conversation_private",
  conversation_in_project: "chatShare.refusal.conversation_in_project",
  personal_workspace_conversation: "chatShare.refusal.personal_workspace_conversation",
  conversation_not_shareable: "chatShare.refusal.conversation_not_shareable",
  share_creator_only: "chatShare.refusal.share_creator_only",
  share_first_party_only: "chatShare.refusal.share_first_party_only",
  share_person_unavailable: "chatShare.refusal.share_person_unavailable",
  share_people_limit: "chatShare.refusal.share_people_limit",
  share_checks_changed: "chatShare.refusal.share_checks_changed",
  person_run_active: "chatShare.refusal.person_run_active"
};

/** A refusal of a share as the interface tells it, with the reason it was told by. */
export interface ShareRefusal {
  reason: ConversationShareRefusal | undefined;
  message: string;
}

/**
 * The sentence for a failed share, removal or leave: the interface's own for a reason it knows,
 * the instance's message for any other refusal. `name` is the person it was about.
 */
export function shareRefusal(error: unknown, t: Translate, name?: string): ShareRefusal {
  const details = detailsOf(error);
  const reason = CONVERSATION_SHARE_REFUSALS.find((known) => known === details?.reason);
  if (reason === undefined) {
    return {
      reason,
      message: error instanceof Error && error.message ? error.message : t("tryAgain")
    };
  }
  return {
    reason,
    message: t(refusalKeys[reason], {
      name: name ?? t("chatShare.someone"),
      store: text(details?.store),
      right: text(details?.right)
    })
  };
}

/** Names as a sentence lists them: "A", "A and B", "A, B and C". */
export function listNames(names: readonly string[], t: Translate): string {
  if (names.length <= 1) return names[0] ?? "";
  return t("chatShare.and", {
    first: names.slice(0, -1).join(", "),
    last: names.at(-1) ?? ""
  });
}

function detailsOf(error: unknown): Record<string, unknown> | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const { payload } = error;
  if (!isRecord(payload) || !isRecord(payload.error)) return undefined;
  return isRecord(payload.error.details) ? payload.error.details : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
