import { useEffect, useMemo, useState } from "react";
import type {
  ApiClient,
  ConversationThreadSnapshot,
  RunObservation
} from "@vivd-catalyst/api-client";
import {
  applyRunObservationToControllerState,
  completeRunObservationStreamInControllerState,
  createControllerStateFromSnapshot,
  createInitialControllerState,
  isLiveRunStatus,
  type ConversationControllerState
} from "./conversation-controller-state";
import {
  rememberRunCursor,
  startRunConnectionManager,
  type RunConnectionTarget
} from "./run-connection-manager";

export interface UseConversationControllerInput {
  client: ApiClient;
  conversationId: string | undefined;
  enabled: boolean;
  snapshot: ConversationThreadSnapshot | undefined;
  snapshotLoading: boolean;
  snapshotError: unknown;
  refreshSnapshot: (conversationId: string) => Promise<unknown>;
  onTerminalObservation?: (observation: RunObservation) => void;
}

export function useConversationController({
  client,
  conversationId,
  enabled,
  snapshot,
  snapshotLoading,
  snapshotError,
  refreshSnapshot,
  onTerminalObservation
}: UseConversationControllerInput): ConversationControllerState {
  const [state, setState] = useState<ConversationControllerState>(() =>
    createInitialControllerState()
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
      setState((current) => ({
        ...current,
        snapshotStatus: current.snapshotStatus === "ready" ? "ready" : "loading"
      }));
      return;
    }
    if (snapshotError) {
      setState({
        ...createInitialControllerState(),
        snapshotStatus: "error",
        error: {
          class: "stream_disconnected",
          message: snapshotError instanceof Error ? snapshotError.message : "Conversation snapshot failed"
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
      setState((current) => createControllerStateFromSnapshot(snapshot, current));
    }
  }, [conversationId, enabled, snapshot, snapshotError, snapshotLoading, snapshotRunKey]);

  const activeRunConnection = useMemo<RunConnectionTarget | undefined>(() => {
    const snapshotActiveRun = snapshot?.activeRun;
    const stateActiveRun = state.activeRun;
    const liveActiveRun =
      snapshotActiveRun && stateActiveRun?.run.id === snapshotActiveRun.run.id &&
      stateActiveRun.lastAppliedSequence >= snapshotActiveRun.projection.lastSequence
        ? stateActiveRun
        : snapshotActiveRun ?? stateActiveRun;
    if (!enabled || !conversationId || !liveActiveRun) {
      return undefined;
    }
    if (!isLiveRunStatus(liveActiveRun.run.status)) {
      return undefined;
    }
    return {
      conversationId,
      runId: liveActiveRun.run.id,
      afterSequence: liveActiveRun.projection.lastSequence
    };
  }, [
    conversationId,
    enabled,
    snapshotRunKey,
    state.activeRun?.run.id,
    state.activeRun?.run.status
  ]);

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
        setState((current) =>
          completeRunObservationStreamInControllerState(current, completion)
        );
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
      onTerminalObservation
    });

    return () => {
      manager.stop();
    };
  }, [activeRunConnection, client, onTerminalObservation, refreshSnapshot]);

  return state;
}
