import { useCallback, useEffect, useState } from "react";
import type { ConversationListItem, StartConversationRunResponse } from "@vivd-catalyst/api-client";

/**
 * How often the rail's conversations are read again while the server still changes them. Each
 * reading is one request for one page, so a person costs the instance at most one such request
 * per interval, whatever the number of conversations; a longer interval shows a title or the
 * end of a run in another conversation that much later.
 */
const RAIL_REFRESH_INTERVAL_MS = 2_000;
/** How long the list waits for the title of a new conversation before it stops asking. */
const TITLE_WAIT_MS = 30_000;

interface AwaitedTitle {
  conversationId: string;
  /** The title the conversation carried when its first message was sent. */
  temporaryTitle: string;
  until: number;
}

/**
 * Reads the rail's conversations again at an interval while the server still changes them
 * without a request from this tab, and stops when it no longer does. That is the case while a
 * listed conversation has a run that nothing here follows, and while a conversation whose
 * first message was just sent still carries its temporary title: the server writes the real
 * title with a job, which may end after a short run does.
 *
 * The run of the open conversation is followed by its own event stream, whose end marks the
 * list as changed, so it needs no reading here. Once the stream no longer reports the run and
 * the list still does, the list is behind and is read until it has caught up.
 */
export function useConversationListRefresh(input: {
  enabled: boolean;
  conversations: readonly ConversationListItem[];
  /** The open conversation while its event stream reports a run. */
  streamedConversationId: string | undefined;
  refresh(): void;
}): { runAccepted(response: StartConversationRunResponse): void } {
  const { enabled, conversations, streamedConversationId, refresh } = input;
  const [awaitedTitles, setAwaitedTitles] = useState<readonly AwaitedTitle[]>([]);
  const hasUnfollowedRun = conversations.some(
    (conversation) => conversation.activeRun && conversation.id !== streamedConversationId
  );
  const awaitsTitle = awaitedTitles.some((awaited) =>
    conversations.some(
      (conversation) =>
        conversation.id === awaited.conversationId && conversation.title === awaited.temporaryTitle
    )
  );

  useEffect(() => {
    if (!enabled || !(hasUnfollowedRun || awaitsTitle)) {
      return undefined;
    }
    const intervalId = window.setInterval(() => {
      setAwaitedTitles((current) => {
        const waiting = current.filter((awaited) => awaited.until > Date.now());
        return waiting.length === current.length ? current : waiting;
      });
      refresh();
    }, RAIL_REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [awaitsTitle, enabled, hasUnfollowedRun, refresh]);

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
