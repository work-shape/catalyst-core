import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import {
  chatInputRefusalDetailsSchema,
  type ChatInputCheckView,
  type ChatInputRefusalDetails
} from "@work-shape/catalyst-api-client";
import { apiErrorCode } from "../../shared/workspace-utils";

// The guardrails on a person's chat message, as the composer shows them (GR-4). The instance
// checks each message before it stores it. A block refuses it and the draft stays; a warning
// refuses it until the person sends it anyway. What the instance did not check is said beside
// the message. Nothing of the text leaves this page for it: the text the person accepted
// warnings for stays in memory, to send it once more.

/** A message the guardrails refused, in the conversation it was written for. */
export interface ChatInputRefusal {
  conversationId: string | undefined;
  text: string;
  details: ChatInputRefusalDetails;
}

/** What the instance says about a message it took: warnings accepted, parts not checked. */
interface ChatInputSent {
  conversationId: string;
  view: ChatInputCheckView;
}

export interface ChatInputGuard {
  /** The conversation open in the pane; undefined on the start page. */
  conversationId: string | undefined;
  refusal: ChatInputRefusal | undefined;
  sent: ChatInputSent | undefined;
  /** Whether the person sends this text despite the warnings it had. */
  acceptsWarnings(text: string): boolean;
  /**
   * Reads a refused send. True where the guardrails refused it, which is then shown in the
   * composer; false for any other failure, which the caller shows as before.
   */
  refused(error: unknown, text: string, conversationId: string | undefined): boolean;
  /** A message went out: what the instance said about it is shown, the refusal goes. */
  delivered(conversationId: string, view: ChatInputCheckView | undefined): void;
  /** The person sends the refused text anyway: its warnings are accepted. */
  acceptWarnings(): void;
  dismiss(): void;
}

/** The refusal of a chat message in an error the instance sent, where it is one. */
export function readChatInputRefusal(error: unknown): ChatInputRefusalDetails | undefined {
  const code = apiErrorCode(error);
  if (code !== "GUARDRAIL_BLOCKED" && code !== "CONFLICT") return undefined;
  const details = errorDetails(error);
  const parsed = chatInputRefusalDetailsSchema.safeParse(details);
  return parsed.success ? parsed.data : undefined;
}

/** True where the person can send the refused message anyway: it was only warned about. */
export function canSendAnyway(refusal: ChatInputRefusal | undefined): boolean {
  return refusal?.details.reason === "chat_input_warning";
}

/** The guard of one chat pane. */
export function useChatInputGuardModel(conversationId: string | undefined): ChatInputGuard {
  const [refusal, setRefusal] = useState<ChatInputRefusal>();
  const [sent, setSent] = useState<ChatInputSent>();
  const acceptedRef = useRef<string | undefined>(undefined);
  const refusalRef = useRef<ChatInputRefusal | undefined>(undefined);

  const acceptsWarnings = useCallback(
    (text: string) => acceptedRef.current !== undefined && acceptedRef.current === text.trim(),
    []
  );
  const refused = useCallback(
    (error: unknown, text: string, conversationId: string | undefined) => {
      const details = readChatInputRefusal(error);
      if (!details) return false;
      const next = { conversationId, text: text.trim(), details };
      refusalRef.current = next;
      setRefusal(next);
      setSent(undefined);
      // A block refuses an accepted text as well: accepting it again would change nothing.
      if (details.reason === "chat_input_blocked") acceptedRef.current = undefined;
      return true;
    },
    []
  );
  const delivered = useCallback((conversationId: string, view: ChatInputCheckView | undefined) => {
    acceptedRef.current = undefined;
    refusalRef.current = undefined;
    setRefusal(undefined);
    setSent(view && hasSomethingToSay(view) ? { conversationId, view } : undefined);
  }, []);
  const acceptWarnings = useCallback(() => {
    if (refusalRef.current) acceptedRef.current = refusalRef.current.text;
  }, []);
  const dismiss = useCallback(() => {
    refusalRef.current = undefined;
    setRefusal(undefined);
    setSent(undefined);
  }, []);

  return useMemo(
    () => ({
      conversationId,
      refusal,
      sent,
      acceptsWarnings,
      refused,
      delivered,
      acceptWarnings,
      dismiss
    }),
    [acceptWarnings, acceptsWarnings, conversationId, delivered, dismiss, refusal, refused, sent]
  );
}

/** The warnings the person accepted were said already; what was not checked is said now. */
function hasSomethingToSay(view: ChatInputCheckView): boolean {
  return view.textNotChecked === true || (view.attachmentsNotChecked?.length ?? 0) > 0;
}

function errorDetails(error: unknown): unknown {
  const field = (value: unknown, key: string): unknown =>
    value !== null && typeof value === "object" && !Array.isArray(value) && key in value
      ? Object.getOwnPropertyDescriptor(value, key)?.value
      : undefined;
  return field(field(field(error, "payload"), "error"), "details");
}

const ChatInputGuardContext = createContext<ChatInputGuard | undefined>(undefined);

export const ChatInputGuardProvider = ChatInputGuardContext.Provider;

/** The pane's guard, where the composer stands in a chat pane. */
export function useChatInputGuard(): ChatInputGuard | undefined {
  return useContext(ChatInputGuardContext);
}
