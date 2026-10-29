import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AgentRun,
  ApiClient,
  ConversationFollowUp,
  FollowUpMode,
  LocaleCode,
  StartConversationRunResponse
} from "@work-shape/catalyst-api-client";
import type { TranslationContextValue } from "../../shared/i18n";
import { apiErrorStatus } from "../../shared/workspace-utils";
import type { FollowUpQueueModel } from "../assistant/follow-up-queue";
import {
  createRunIdempotencyKey,
  sendProductConversationMessage
} from "../assistant/product-run-transport";
import type { ReasoningEffort } from "../workspace/agent-model-selection";
import { isLiveRunStatus } from "./conversation-controller-state";
import {
  followUpDispatchReread,
  followUpQueueItem,
  followUpQueuePhase,
  isFollowUpDispatchOverdue
} from "./follow-up-queue-state";

/**
 * How often an open page reads the thread while its queue is paused. Nothing streams a paused
 * queue, so another member's Edit, Remove or Send now reaches this page only by a read; until
 * then it may hide Send now from the reader whose message became the oldest.
 */
const PAUSED_QUEUE_REREAD_MS = 10_000;

/** The composer's drafts of every conversation, read again after Edit returns files to them. */
const DRAFT_ATTACHMENTS_KEY = ["draft-attachments"] as const;

/** What the workspace knows of the open conversation's queue. */
export interface FollowUpSource {
  /** The pending follow-ups of the thread, oldest first. */
  followUps: readonly ConversationFollowUp[];
  currentUserId: string | undefined;
  /** What Enter does with a message the reader sends during their own run. */
  followUpMode: FollowUpMode;
  /** Reads the thread again: nothing reaches the page about a queue while no run goes. */
  refreshThread(conversationId: string): Promise<unknown>;
}

export function useFollowUpSource(input: FollowUpSource): FollowUpSource {
  const { currentUserId, followUps, followUpMode, refreshThread } = input;
  return useMemo(
    () => ({ followUps, currentUserId, followUpMode, refreshThread }),
    [currentUserId, followUps, followUpMode, refreshThread]
  );
}

/**
 * The queue of one open conversation and the reader's actions on it. A pane lives for one
 * conversation, so what it remembers goes with it.
 */
export function useFollowUpQueueModel(input: {
  source: FollowUpSource;
  client: ApiClient;
  conversationId: string | undefined;
  /** The status of the run the thread names last, if it still names one. */
  runStatus: AgentRun["status"] | undefined;
  /** That run and who started it: only they steer it. */
  runId: string | undefined;
  runOwnerUserId: string | undefined;
  agentName: string | undefined;
  modelBindingId: string | undefined;
  reasoningEffort: ReasoningEffort | undefined;
  locale: LocaleCode;
  messageSubmitted(conversationId: string): void;
  runStarted(response: StartConversationRunResponse): void;
  t: TranslationContextValue["t"];
}): FollowUpQueueModel | undefined {
  const { source, client, conversationId, runStatus, messageSubmitted, runStarted, t } = input;
  const { runId, runOwnerUserId } = input;
  const { agentName, modelBindingId, reasoningEffort, locale } = input;
  const { refreshThread } = source;
  const queryClient = useQueryClient();
  // A message the server took stands in the list at once. It stays until the thread changes,
  // which then names it itself, or names it no longer because it has started.
  const [echo, setEcho] = useState<{
    followUp: ConversationFollowUp;
    seenWith: readonly ConversationFollowUp[];
  }>();
  const [withdrawnIds, setWithdrawnIds] = useState<ReadonlySet<string>>(new Set());
  /** Messages whose withdrawal or steer is on its way. */
  const [withdrawingIds, setWithdrawingIds] = useState<ReadonlySet<string>>(new Set());
  /** Messages the server turned into a steer, until the thread says so itself. */
  const [steeredIds, setSteeredIds] = useState<ReadonlySet<string>>(new Set());
  const [queueing, setQueueing] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [error, setError] = useState<string>();
  const [rereads, setRereads] = useState<{ followUpId: string; attempts: number }>();
  /** The message Send now was accepted for, until the thread no longer names it first. */
  const [sentNowId, setSentNowId] = useState<string>();

  const followUps = useMemo(() => {
    const listed =
      echo &&
      echo.seenWith === source.followUps &&
      !source.followUps.some((followUp) => followUp.id === echo.followUp.id)
        ? [...source.followUps, echo.followUp]
        : source.followUps;
    return listed.filter((followUp) => !withdrawnIds.has(followUp.id));
  }, [echo, source.followUps, withdrawnIds]);
  const runLive = runStatus !== undefined && isLiveRunStatus(runStatus);
  const nextFollowUpId = followUps[0]?.id;
  const phase = followUpQueuePhase({
    runStatus,
    sentNow: sentNowId !== undefined && sentNowId === nextFollowUpId,
    dispatchOverdue: isFollowUpDispatchOverdue({ nextFollowUpId, rereads })
  });
  const reread = followUpDispatchReread({
    phase: followUps.length > 0 ? phase : undefined,
    nextFollowUpId,
    attempts: rereads && rereads.followUpId === nextFollowUpId ? rereads.attempts : 0
  });

  // The server starts the next message when a run completes, and tells no page. While the
  // queue should be moving, the page reads the thread again, a bounded few times.
  useEffect(() => {
    if (!conversationId || !reread) {
      return undefined;
    }
    const timeout = globalThis.setTimeout(() => {
      setRereads((current) => ({
        followUpId: reread.followUpId,
        attempts: (current?.followUpId === reread.followUpId ? current.attempts : 0) + 1
      }));
      refreshThread(conversationId).catch(() => undefined);
    }, reread.delayMs);
    return () => globalThis.clearTimeout(timeout);
  }, [conversationId, refreshThread, reread?.delayMs, reread?.followUpId]);

  // A paused queue changes only through the members' own actions. A hidden page reads the
  // thread again once it is shown.
  const pausedWithItems = phase === "paused" && followUps.length > 0;
  useEffect(() => {
    if (!conversationId || !pausedWithItems) {
      return undefined;
    }
    const interval = globalThis.setInterval(() => {
      if (globalThis.document?.visibilityState !== "hidden") {
        refreshThread(conversationId).catch(() => undefined);
      }
    }, PAUSED_QUEUE_REREAD_MS);
    return () => globalThis.clearInterval(interval);
  }, [conversationId, pausedWithItems, refreshThread]);

  // Without a run nothing streams the queue's changes, so the page reads them itself.
  const settle = useCallback(
    (id: string) => {
      if (!runLive) {
        refreshThread(id).catch(() => undefined);
      }
    },
    [refreshThread, runLive]
  );

  const sendToQueue = useCallback(
    async (text: string, followUp: FollowUpMode): Promise<boolean> => {
      if (!conversationId) {
        return false;
      }
      setQueueing(true);
      setError(undefined);
      try {
        const response = await sendProductConversationMessage({
          agentName,
          modelBindingId,
          reasoningEffort,
          client,
          conversationId,
          idempotencyKey: createRunIdempotencyKey(),
          locale,
          text,
          followUp
        });
        messageSubmitted(conversationId);
        if ("followUp" in response) {
          setEcho({ followUp: response.followUp, seenWith: source.followUps });
        } else {
          // The run ended meanwhile: the message started at once.
          runStarted(response);
        }
        return true;
      } catch {
        setError(t("followUpQueueFailed"));
        return false;
      } finally {
        setQueueing(false);
      }
    },
    [
      agentName,
      client,
      conversationId,
      locale,
      messageSubmitted,
      modelBindingId,
      reasoningEffort,
      runStarted,
      source.followUps,
      t
    ]
  );

  /**
   * Its text once the server let it go; undefined where it did not, with the error shown. With
   * `keepAttachments` its files go back to the composer instead of away.
   */
  const withdrawOne = useCallback(
    async (id: string, keepAttachments = false): Promise<string | undefined> => {
      if (!conversationId) {
        return undefined;
      }
      setWithdrawingIds((current) => new Set(current).add(id));
      setError(undefined);
      try {
        const { followUp } = await client.conversations.follow_ups.withdraw({
          params: { conversationId, followUpId: id },
          body: keepAttachments ? { keepAttachments } : {}
        });
        setWithdrawnIds((current) => new Set(current).add(id));
        settle(conversationId);
        if (keepAttachments) {
          queryClient.invalidateQueries({ queryKey: DRAFT_ATTACHMENTS_KEY }).catch(() => undefined);
        }
        return followUp.text;
      } catch (cause) {
        // A message the server already started cannot be taken back; the thread shows it.
        setError(t(apiErrorStatus(cause) === 409 ? "followUpAlreadySent" : "followUpActionFailed"));
        refreshThread(conversationId).catch(() => undefined);
        return undefined;
      } finally {
        setWithdrawingIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    },
    [client, conversationId, queryClient, refreshThread, settle, t]
  );

  const queue = useCallback(
    (text: string, onQueued: () => void, mode: FollowUpMode = "queue") => {
      sendToQueue(text, mode)
        .then((queued) => queued && onQueued())
        .catch(() => undefined);
    },
    [sendToQueue]
  );

  /** Hands the reader's queued message to their own running turn, keeping its place on refusal. */
  const steer = useCallback(
    (id: string) => {
      if (!conversationId) {
        return;
      }
      setWithdrawingIds((current) => new Set(current).add(id));
      setError(undefined);
      client.conversations.follow_ups
        .steer({ params: { conversationId, followUpId: id }, body: {} })
        .then(({ followUp }) => {
          // The stream tells every tab as well; this tab need not wait for it.
          setSteeredIds((current) => new Set(current).add(followUp.id));
        })
        .catch((cause: unknown) => {
          setError(
            t(apiErrorStatus(cause) === 409 ? "followUpSteerRefused" : "followUpActionFailed")
          );
          refreshThread(conversationId).catch(() => undefined);
        })
        .finally(() =>
          setWithdrawingIds((current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
          })
        );
    },
    [client, conversationId, refreshThread, t]
  );

  const withdraw = useCallback(
    (id: string, onWithdrawn?: (text: string) => void) => {
      // Edit takes the whole message back into the composer, its files with it.
      withdrawOne(id, onWithdrawn !== undefined)
        .then((text) => text !== undefined && onWithdrawn?.(text))
        .catch(() => undefined);
    },
    [withdrawOne]
  );

  const ownIds = useMemo(
    () =>
      followUps
        .filter((followUp) => followUp.authorUserId === source.currentUserId)
        .map((followUp) => followUp.id),
    [followUps, source.currentUserId]
  );
  const discardOwn = useCallback(
    (onDone: () => void) => {
      // One at a time, oldest first: one the server started meanwhile stays in the transcript.
      const discard = async () => {
        for (const id of ownIds) {
          await withdrawOne(id);
        }
      };
      discard()
        .finally(onDone)
        .catch(() => undefined);
    },
    [ownIds, withdrawOne]
  );

  const sendNow = useCallback(() => {
    if (!conversationId) {
      return;
    }
    const startingId = nextFollowUpId;
    setDispatching(true);
    setError(undefined);
    client.conversations.follow_ups
      .dispatch({ params: { conversationId }, body: {} })
      .then(() => {
        // The queue is sending again and reads the thread until the run of this message is in
        // it, with re-reads of its own.
        setRereads(undefined);
        setSentNowId(startingId);
      })
      .catch(() => setError(t("followUpActionFailed")))
      .finally(() => setDispatching(false));
  }, [client, conversationId, nextFollowUpId, t]);

  return useMemo(() => {
    if (!conversationId) {
      return undefined;
    }
    const liveRunId = runLive ? runId : undefined;
    const items = followUps.map((followUp) =>
      followUpQueueItem(
        steeredIds.has(followUp.id) && followUp.mode === "queue" && liveRunId !== undefined
          ? { ...followUp, mode: "steer", dispatchedRunId: liveRunId }
          : followUp,
        source.currentUserId,
        liveRunId
      )
    );
    return {
      items,
      mode: source.followUpMode,
      ownRun:
        liveRunId !== undefined &&
        runOwnerUserId !== undefined &&
        runOwnerUserId === source.currentUserId,
      phase,
      withdrawingIds,
      queueing,
      dispatching,
      error,
      queue,
      steer,
      withdraw,
      discardOwn,
      sendNow
    };
  }, [
    conversationId,
    discardOwn,
    dispatching,
    error,
    followUps,
    phase,
    queue,
    queueing,
    runId,
    runLive,
    runOwnerUserId,
    runStatus,
    sendNow,
    source,
    steer,
    steeredIds,
    withdraw,
    withdrawingIds
  ]);
}
