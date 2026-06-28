import type { ApiClient, RunObservation } from "@vivd-catalyst/api-client";
import { isTerminalObservation } from "./conversation-controller-state";

export interface RunConnectionTarget {
  conversationId: string;
  runId: string;
  afterSequence: number;
}

export interface RunConnectionCompletion {
  sawObservation: boolean;
  streamCaughtUp: boolean;
}

export interface RunCursorStorage {
  rememberCursor(conversationId: string, runId: string, sequence: number): void;
  clearCursors(): void;
}

export interface RunConnectionManager {
  stop(): void;
}

export interface StartRunConnectionManagerInput {
  client: Pick<ApiClient, "observeRunEvents">;
  connection: RunConnectionTarget;
  markConnecting(): void;
  applyObservation(observation: RunObservation): {
    refreshRequired: boolean;
  };
  completeStream(completion: RunConnectionCompletion): void;
  failStream(error: unknown): void;
  refreshSnapshot(conversationId: string): Promise<unknown>;
  onTerminalObservation?: (observation: RunObservation) => void;
  cursorStorage?: RunCursorStorage;
}

export function startRunConnectionManager(
  input: StartRunConnectionManagerInput
): RunConnectionManager {
  const abortController = new AbortController();
  const cursorStorage = input.cursorStorage ?? browserRunCursorStorage;
  let cancelled = false;

  input.markConnecting();

  void (async () => {
    try {
      let streamCaughtUp = false;
      let sawObservation = false;
      for await (const observation of input.client.observeRunEvents(
        input.connection.conversationId,
        input.connection.runId,
        {
          afterSequence: input.connection.afterSequence,
          onCaughtUp: () => {
            streamCaughtUp = true;
          },
          signal: abortController.signal
        }
      )) {
        if (cancelled) {
          return;
        }
        sawObservation = true;
        cursorStorage.rememberCursor(
          input.connection.conversationId,
          input.connection.runId,
          observation.sequence
        );
        const applied = input.applyObservation(observation);
        if (isTerminalObservation(observation)) {
          input.onTerminalObservation?.(observation);
        }
        if (applied.refreshRequired) {
          abortController.abort();
          await input.refreshSnapshot(input.connection.conversationId);
          return;
        }
      }
      if (!cancelled) {
        input.completeStream({
          streamCaughtUp,
          sawObservation
        });
        if (streamCaughtUp && !sawObservation) {
          await input.refreshSnapshot(input.connection.conversationId);
        }
      }
    } catch (error) {
      if (cancelled || isAbortLikeError(error)) {
        return;
      }
      input.failStream(error);
    }
  })();

  return {
    stop() {
      cancelled = true;
      abortController.abort();
    }
  };
}

export function clearRunCursors(): void {
  browserRunCursorStorage.clearCursors();
}

export function rememberRunCursor(
  conversationId: string,
  runId: string,
  sequence: number
): void {
  browserRunCursorStorage.rememberCursor(conversationId, runId, sequence);
}

const RUN_CURSOR_STORAGE_PREFIX = "vivd-catalyst:run-cursor";

const browserRunCursorStorage: RunCursorStorage = {
  rememberCursor(conversationId, runId, sequence) {
    if (typeof window === "undefined") {
      return;
    }
    window.sessionStorage.setItem(
      `${RUN_CURSOR_STORAGE_PREFIX}:${conversationId}:${runId}`,
      String(sequence)
    );
  },
  clearCursors() {
    if (typeof window === "undefined") {
      return;
    }
    for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(RUN_CURSOR_STORAGE_PREFIX)) {
        window.sessionStorage.removeItem(key);
      }
    }
  }
};

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort/u.test(error.message.toLowerCase()));
}
