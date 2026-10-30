import { createElement } from "react";
import type { ConversationThreadSnapshot, RunObservation } from "@work-shape/catalyst-api-client";
import { runObservationSchema } from "@work-shape/catalyst-api-contract";
import { describe, expect, it } from "vitest";
import {
  applyRunObservationToControllerState,
  createControllerStateFromSnapshot,
  RATE_LIMIT_CONTINUE_WAIT_MS,
  rateLimitContinueOffer,
  RunContinueAction,
  secondsUntil
} from "./support/chat-ui";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// T6: the notice of a run the model provider stopped for too many requests offers its
// conversation's owner a button that goes on once the wait the notice names is over.

const failedAt = "2026-10-30T10:00:00.000Z";
const rateLimited = {
  code: "RATE_LIMITED",
  message: "The model is receiving too many requests. Try again in a minute.",
  category: "app_error"
} as const;

type RunError = NonNullable<
  NonNullable<ConversationThreadSnapshot["activeRun"]>["projection"]["error"]
>;

function snapshot(status: "running" | "failed", error?: RunError): ConversationThreadSnapshot {
  const lastSequence = status === "failed" ? 2 : 1;
  return {
    conversation: {
      id: "conv_1",
      clientInstanceId: "client_1",
      collaborationWorkspaceId: "cw_test",
      visibility: "workspace",
      createdByUserId: "user_1",
      createdByExternalUserId: "external_1",
      title: "Test",
      status: "active",
      createdAt: failedAt,
      updatedAt: failedAt,
      retainedUntil: "2026-11-30T10:00:00.000Z"
    },
    messages: [],
    activeRun: {
      run: {
        id: "run_1",
        conversationId: "conv_1",
        agentName: "test_agent",
        status,
        startedAt: "2026-10-30T09:58:00.000Z",
        updatedAt: failedAt,
        lastSequence
      },
      projection: {
        runId: "run_1",
        lastSequence,
        status,
        parts: [],
        text: "",
        reasoning: [],
        activeToolCalls: [],
        ...(error ? { error } : {})
      }
    },
    userState: {
      clientInstanceId: "client_1",
      conversationId: "conv_1",
      userId: "user_1",
      updatedAt: failedAt
    },
    serverTime: failedAt
  };
}

// The failure as the stream carries it, read through the API's own schema.
const failedObservation: RunObservation = runObservationSchema.parse({
  clientInstanceId: "client_1",
  runId: "run_1",
  conversationId: "conv_1",
  ownerUserId: "user_1",
  sequence: 2,
  type: "run_failed",
  payload: {
    type: "run_failed",
    runId: "run_1",
    sequence: 2,
    createdAt: failedAt,
    error: rateLimited
  },
  createdAt: failedAt
});

describe("going on after a rate-limited run (T6)", () => {
  it("offers to go on a minute after the run failed, live and after a reload", () => {
    const live = applyRunObservationToControllerState(
      createControllerStateFromSnapshot(snapshot("running")),
      failedObservation
    ).state;
    const reloaded = createControllerStateFromSnapshot(snapshot("failed", rateLimited));
    for (const state of [live, reloaded]) {
      expect(rateLimitContinueOffer(state.error, state.activeRun?.run)).toEqual({
        runId: "run_1",
        readyAt: Date.parse(failedAt) + RATE_LIMIT_CONTINUE_WAIT_MS
      });
    }
  });

  it("offers nothing for any other end of a run", () => {
    const timedOut = createControllerStateFromSnapshot(
      snapshot("failed", { code: "TIMEOUT", message: "stream ended", category: "app_error" })
    );
    expect(rateLimitContinueOffer(timedOut.error, timedOut.activeRun?.run)).toBeUndefined();
    const running = createControllerStateFromSnapshot(snapshot("running"));
    expect(rateLimitContinueOffer(running.error, running.activeRun?.run)).toBeUndefined();
    expect(
      rateLimitContinueOffer({ class: "run_cancelled", message: "Run cancelled" }, undefined)
    ).toBeUndefined();
  });

  it("counts the wait down in whole seconds and never past the minute where clocks differ", () => {
    const readyAt = Date.parse(failedAt) + RATE_LIMIT_CONTINUE_WAIT_MS;
    expect(secondsUntil(readyAt, Date.parse(failedAt))).toBe(60);
    expect(secondsUntil(readyAt, readyAt - 41_500)).toBe(42);
    expect(secondsUntil(readyAt, readyAt)).toBe(0);
    expect(secondsUntil(readyAt, readyAt + 5_000)).toBe(0);
    // A browser clock behind the server's would otherwise count longer than the notice says.
    expect(secondsUntil(readyAt, readyAt - 10 * 60_000)).toBe(60);
  });

  it("shows the button disabled with its count while the wait lasts, in German", () => {
    const render = (readyAt: number, canSend = true) =>
      renderToStaticMarkup(
        createElement(TranslationProvider, {
          locale: "de",
          children: createElement(RunContinueAction, {
            offer: { runId: "run_1", readyAt, canSend, send: () => undefined }
          })
        })
      );
    const waiting = render(Date.now() + 41_500);
    expect(waiting).toContain("Weitermachen in 42 s");
    expect(waiting).toMatch(/<button[^>]*disabled=""/u);
    const ready = render(Date.now() - 1_000);
    expect(ready).toContain(">Weitermachen</button>");
    expect(ready).not.toMatch(/<button[^>]*disabled=""/u);
    // While the composer could not send either, such as during another run, it waits too.
    expect(render(Date.now() - 1_000, false)).toMatch(/<button[^>]*disabled=""/u);
  });
});
