import { useEffect, useMemo, useState } from "react";
import type {
  ApiClient,
  ConversationThreadSnapshot,
  RunObservation
} from "@vivd-catalyst/api-client";
import {
  applyRunObservationToControllerState,
  completeRunObservationStreamInControllerState,
  controllerStateForConversation,
  createControllerStateFromSnapshot,
  createInitialControllerState,
  resolveRunConnectionTarget,
  staleThreadReread,
  type ConversationControllerState,
  type RunConnectionTarget
} from "./conversation-controller-state";
import { rememberRunCursor, startRunConnectionManager } from "./run-connection-manager";

export interface UseConversationControllerInput {
  client: ApiClient;
  conversationId: string | undefined;
  enabled: boolean;
  snapshot: ConversationThreadSnapshot | undefined;
  snapshotLoading: boolean;
  snapshotError: unknown;
  refreshSnapshot: (conversationId: string) => Promise<unknown>;
  onTerminalObservation?: (observation: RunObservation) => void;
  onToolCallCompleted?: (conversationId: string) => void;
}

export function useConversationController({
  client,
  conversationId,
  enabled,
  snapshot,
  snapshotLoading,
  snapshotError,
  refreshSnapshot,
  onTerminalObservation,
  onToolCallCompleted
}: UseConversationControllerInput): ConversationControllerState {
  const [storedState, setState] = useState<ConversationControllerState>(() =>
    createInitialControllerState()
  );
  // The stored state changes one effect after the selection does. What a render shows and
  // connects to is the selected conversation's own state, from the first render on.
  const state = useMemo(
    () => controllerStateForConversation(storedState, conversationId),
    [conversationId, storedState]
  );
  const snapshotRunKey = snapshot?.activeRun
    ? `${snapshot.activeRun.run.id}:${snapshot.activeRun.projection.lastSequence}:${snapshot.activeRun.run.status}`
    : undefined;

  useEffect(() => {
    if (!enabled || !conversationId) {
      setState(createInitialControllerState());
      return;
    }
    if (snapshotLoading) {
      setState((current) => {
        const own = controllerStateForConversation(current, conversationId);
        return {
          ...own,
          snapshotStatus: own.snapshotStatus === "ready" ? "ready" : "loading"
        };
      });
      return;
    }
    if (snapshotError) {
      setState({
        ...createInitialControllerState(),
        snapshotStatus: "error",
        error: {
          class: "stream_disconnected",
          message:
            snapshotError instanceof Error ? snapshotError.message : "Conversation snapshot failed"
        }
      });
      return;
    }
    if (snapshot) {
      if (snapshot.activeRun) {
        rememberRunCursor(
          conversationId,
          snapshot.activeRun.run.id,
          snapshot.activeRun.projection.lastSequence
        );
      }
      setState((current) =>
        createControllerStateFromSnapshot(
          snapshot,
          controllerStateForConversation(current, conversationId)
        )
      );
    }
  }, [conversationId, enabled, snapshot, snapshotError, snapshotLoading, snapshotRunKey]);

  const activeRunConnection = useMemo<RunConnectionTarget | undefined>(
    () => resolveRunConnectionTarget({ conversationId, enabled, snapshot, state }),
    [conversationId, enabled, snapshotRunKey, state.activeRun?.run.id, state.activeRun?.run.status]
  );

  useEffect(() => {
    if (!activeRunConnection) {
      return undefined;
    }

    const manager = startRunConnectionManager({
      client,
      connection: activeRunConnection,
      markConnecting: () => {
        setState((current) => ({
          ...current,
          connectionStatus:
            current.connectionStatus === "disconnected" ? "reconnecting" : "connecting"
        }));
      },
      applyObservation: (observation) => {
        let refreshRequired = false;
        setState((current) => {
          const applied = applyRunObservationToControllerState(current, observation);
          refreshRequired = applied.refreshRequired;
          return applied.state;
        });
        return { refreshRequired };
      },
      completeStream: (completion) => {
        setState((current) => completeRunObservationStreamInControllerState(current, completion));
      },
      failStream: (error) => {
        setState((current) => ({
          ...current,
          connectionStatus: "disconnected",
          error: {
            class: "stream_disconnected",
            message: error instanceof Error ? error.message : "Run observation stream disconnected"
          }
        }));
      },
      refreshSnapshot,
      onTerminalObservation,
      onToolCallCompleted
    });

    return () => {
      manager.stop();
    };
  }, [activeRunConnection, client, onTerminalObservation, onToolCallCompleted, refreshSnapshot]);

  // A thread read before the store had recorded the end of a run stays behind the page, which
  // saw the run end. Nothing else would read it again, so the page does, a bounded few times.
  const [staleRereads, setStaleRereads] = useState<{ runId: string; attempts: number }>();
  const reread = staleThreadReread({
    snapshot: snapshot?.conversation.id === conversationId ? snapshot : undefined,
    state,
    attempts:
      staleRereads && staleRereads.runId === snapshot?.activeRun?.run.id ? staleRereads.attempts : 0
  });
  const rereadRunId = reread?.runId;
  const rereadDelayMs = reread?.delayMs;

  useEffect(() => {
    if (!conversationId || rereadRunId === undefined || rereadDelayMs === undefined) {
      return undefined;
    }
    const timeout = globalThis.setTimeout(() => {
      setStaleRereads((current) => ({
        runId: rereadRunId,
        attempts: (current?.runId === rereadRunId ? current.attempts : 0) + 1
      }));
      // A re-read that fails shows as the thread's own error.
      refreshSnapshot(conversationId).catch(() => undefined);
    }, rereadDelayMs);
    return () => globalThis.clearTimeout(timeout);
  }, [conversationId, refreshSnapshot, rereadDelayMs, rereadRunId]);

  return state;
}
