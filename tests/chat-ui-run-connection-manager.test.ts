import { describe, expect, it } from "vitest";
import type { RunObservation } from "@vivd-catalyst/api-client";
import {
  startRunConnectionManager,
  type RunConnectionCompletion,
  type RunConnectionManager,
  type RunCursorStorage
} from "../packages/chat-ui/src/conversation/run-connection-manager";

describe("chat UI run connection manager", () => {
  it("remembers cursor hints and asks for a snapshot refresh when observation application reports a gap", async () => {
    const afterSequences: Array<number | undefined> = [];
    const signals: AbortSignal[] = [];
    const appliedSequences: number[] = [];
    const rememberedCursors: Array<[string, string, number]> = [];
    const cursorStorage = createCursorStorage(rememberedCursors);
    let manager: RunConnectionManager | undefined;

    const refreshed = new Promise<void>((resolve, reject) => {
      manager = startRunConnectionManager({
        client: {
          async *observeRunEvents(_conversationId, _runId, options = {}) {
            afterSequences.push(options.afterSequence);
            if (options.signal) {
              signals.push(options.signal);
            }
            yield createObservation({
              sequence: 4,
              type: "message_delta",
              payload: {
                delta: " after a gap"
              }
            });
          }
        },
        connection: {
          conversationId: "conv_1",
          runId: "run_1",
          afterSequence: 2
        },
        markConnecting() {},
        applyObservation(observation) {
          appliedSequences.push(observation.sequence);
          return { refreshRequired: true };
        },
        completeStream() {
          reject(new Error("sequence gaps should refresh before stream completion"));
        },
        failStream(error) {
          reject(toError(error));
        },
        async refreshSnapshot() {
          resolve();
        },
        cursorStorage
      });
    });

    await refreshed;

    expect(afterSequences).toEqual([2]);
    expect(appliedSequences).toEqual([4]);
    expect(rememberedCursors).toEqual([["conv_1", "run_1", 4]]);
    expect(signals[0]?.aborted).toBe(true);
    manager?.stop();
  });

  it("reports caught-up empty streams and requests a snapshot refresh", async () => {
    const completions: RunConnectionCompletion[] = [];
    const refreshed = new Promise<void>((resolve, reject) => {
      startRunConnectionManager({
        client: {
          async *observeRunEvents(_conversationId, _runId, options = {}) {
            options.onCaughtUp?.();
          }
        },
        connection: {
          conversationId: "conv_1",
          runId: "run_1",
          afterSequence: 3
        },
        markConnecting() {},
        applyObservation() {
          reject(new Error("caught-up empty streams should not apply observations"));
          return { refreshRequired: false };
        },
        completeStream(completion) {
          completions.push(completion);
        },
        failStream(error) {
          reject(toError(error));
        },
        async refreshSnapshot() {
          resolve();
        }
      });
    });

    await refreshed;

    expect(completions).toEqual([
      {
        sawObservation: false,
        streamCaughtUp: true
      }
    ]);
  });

  it("reports real empty stream closures without deciding product run status", async () => {
    const completions: RunConnectionCompletion[] = [];
    const completed = new Promise<void>((resolve, reject) => {
      startRunConnectionManager({
        client: {
          async *observeRunEvents() {}
        },
        connection: {
          conversationId: "conv_1",
          runId: "run_1",
          afterSequence: 3
        },
        markConnecting() {},
        applyObservation() {
          reject(new Error("empty streams should not apply observations"));
          return { refreshRequired: false };
        },
        completeStream(completion) {
          completions.push(completion);
          resolve();
        },
        failStream(error) {
          reject(toError(error));
        },
        async refreshSnapshot() {
          reject(new Error("real empty stream closures should not refresh snapshots"));
        }
      });
    });

    await completed;

    expect(completions).toEqual([
      {
        sawObservation: false,
        streamCaughtUp: false
      }
    ]);
  });
});

function createCursorStorage(
  rememberedCursors: Array<[string, string, number]>
): RunCursorStorage {
  return {
    rememberCursor(conversationId, runId, sequence) {
      rememberedCursors.push([conversationId, runId, sequence]);
    },
    clearCursors() {}
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createObservation<TType extends RunObservation["payload"]["type"]>({
  sequence,
  type,
  payload = {}
}: {
  sequence: number;
  type: TType;
  payload?: Partial<
    Omit<
      Extract<RunObservation["payload"], { type: TType }>,
      "runId" | "sequence" | "createdAt" | "type"
    >
  >;
}): RunObservation {
  const createdAt = `2026-06-26T10:00:0${sequence}.000Z`;
  return {
    clientInstanceId: "client_1",
    conversationId: "conv_1",
    ownerUserId: "user_1",
    runId: "run_1",
    sequence,
    type,
    payload: {
      ...payload,
      type,
      runId: "run_1",
      sequence,
      createdAt
    } as RunObservation["payload"],
    createdAt
  };
}
