import {
  PREVIEW_CAPTURE_TOOL_NAME,
  type ApiClient,
  type RunObservation
} from "@work-shape/catalyst-api-client";
import { forgetWhenSessionEnds } from "../../shared/shell-session";
import { isTerminalObservation, type RunConnectionTarget } from "./conversation-controller-state";

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
  client: { conversations: { runs: Pick<ApiClient["conversations"]["runs"], "observe"> } };
  connection: RunConnectionTarget;
  markConnecting(): void;
  applyObservation(observation: RunObservation): {
    refreshRequired: boolean;
  };
  completeStream(completion: RunConnectionCompletion): void;
  failStream(error: unknown): void;
  refreshSnapshot(conversationId: string): Promise<unknown>;
  onTerminalObservation?: (observation: RunObservation) => void;
  onToolCallCompleted?: (conversationId: string) => void;
  /** The run asks the browser of the person it serves for a picture of the preview. */
  onPreviewCaptureAsked?: (conversationId: string) => void;
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
      const { conversationId, runId, afterSequence } = input.connection;
      for await (const observation of input.client.conversations.runs.observe({
        params: { conversationId, runId },
        query: afterSequence === undefined ? {} : { after: String(afterSequence) },
        onCaughtUp: () => {
          streamCaughtUp = true;
        },
        // An event of a newer server this client does not know: its place still counts.
        onSkipped: (skipped) => {
          if (skipped.runId !== runId) return;
          cursorStorage.rememberCursor(conversationId, runId, skipped.sequence);
        },
        signal: abortController.signal
      })) {
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
        // A started subagent is a row of the conversation's Resources, as a finished call's
        // file is one.
        if (
          observation.payload.type === "tool_call_completed" ||
          observation.payload.type === "subagent_started"
        ) {
          input.onToolCallCompleted?.(observation.conversationId);
        }
        if (
          observation.payload.type === "tool_call_started" &&
          observation.payload.toolName === PREVIEW_CAPTURE_TOOL_NAME
        ) {
          input.onPreviewCaptureAsked?.(observation.conversationId);
        }
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

export function rememberRunCursor(conversationId: string, runId: string, sequence: number): void {
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
forgetWhenSessionEnds(() => browserRunCursorStorage.clearCursors());

function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || /abort/u.test(error.message.toLowerCase()))
  );
}
