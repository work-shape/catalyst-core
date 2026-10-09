import { useCallback, useEffect, useState } from "react";
import type { ConversationListItem, StartConversationRunResponse } from "@vivd-catalyst/api-client";

const REFRESH_INTERVAL_MS = 1_000;
/** How long the list waits for the title of a new conversation before it stops asking. */
const TITLE_WAIT_MS = 30_000;

interface AwaitedTitle {
  conversationId: string;
  /** The title the conversation carried when its first message was sent. */
  temporaryTitle: string;
  until: number;
}

/**
 * Refetches the conversation list every second while the server still changes it without a
 * request from this tab: while a run is active, and while a conversation whose first message
 * was just sent still carries its temporary title. The server writes the real title with a
 * job, which may end after a short run does.
 */
export function useConversationListRefresh(input: {
  enabled: boolean;
  conversations: readonly ConversationListItem[];
  refresh(): void;
}): { runAccepted(response: StartConversationRunResponse): void } {
  const { enabled, conversations, refresh } = input;
  const [awaitedTitles, setAwaitedTitles] = useState<readonly AwaitedTitle[]>([]);
  const hasActiveRun = conversations.some((conversation) => conversation.activeRun);
  const awaitsTitle = awaitedTitles.some((awaited) =>
    conversations.some(
      (conversation) =>
        conversation.id === awaited.conversationId && conversation.title === awaited.temporaryTitle
    )
  );

  useEffect(() => {
    if (!enabled || !(hasActiveRun || awaitsTitle)) {
      return undefined;
    }
    const intervalId = window.setInterval(() => {
      setAwaitedTitles((current) => {
        const waiting = current.filter((awaited) => awaited.until > Date.now());
        return waiting.length === current.length ? current : waiting;
      });
      refresh();
    }, REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [awaitsTitle, enabled, hasActiveRun, refresh]);

  const runAccepted = useCallback(
    (response: StartConversationRunResponse) => {
      refresh();
      // Only the first user message of a conversation gets a title job.
      if (response.thread.messages.filter((message) => message.role === "user").length !== 1) {
        return;
      }
      const awaited: AwaitedTitle = {
        conversationId: response.conversation.id,
        temporaryTitle: response.conversation.title,
        until: Date.now() + TITLE_WAIT_MS
      };
      setAwaitedTitles((current) => [
        ...current.filter(
          (other) => other.conversationId !== awaited.conversationId && other.until > Date.now()
        ),
        awaited
      ]);
    },
    [refresh]
  );

  return { runAccepted };
}
