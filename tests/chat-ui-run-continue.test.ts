// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ConversationThreadSnapshot, RunObservation } from "@work-shape/catalyst-api-client";
import { runObservationSchema } from "@work-shape/catalyst-api-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
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
      retainedUntil: "2026-11-30T10:00:00.000Z",
      people: []
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
    expect(secondsUntil(readyAt, readyAt + 5_000)).toBe(0);
    // A browser clock behind the server's would otherwise count longer than the notice says.
    expect(secondsUntil(readyAt, readyAt - 10 * 60_000)).toBe(60);
  });

  it("holds the button while the wait lasts or the composer cannot send", () => {
    const render = (readyAt: number, canSend = true) =>
      renderToStaticMarkup(
        createElement(TranslationProvider, {
          locale: "de",
          children: createElement(RunContinueAction, {
            offer: { runId: "run_1", readyAt, canSend, send: () => undefined }
          })
        })
      );
    expect(render(Date.now() + 41_500)).toMatch(/<button[^>]*disabled=""/u);
    expect(render(Date.now() - 1_000)).not.toMatch(/<button[^>]*disabled=""/u);
    // While the composer could not send either, such as during another run, it waits too.
    expect(render(Date.now() - 1_000, false)).toMatch(/<button[^>]*disabled=""/u);
  });
});

// Moved down from the browser suite: once the wait is over, "Continue" sends the word once.
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("Continue after a rate-limited run", () => {
  it("sends once, however often it is pressed", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const send = vi.fn();
    await act(async () => {
      root.render(
        createElement(TranslationProvider, {
          locale: "en",
          children: createElement(RunContinueAction, {
            offer: { runId: "run_1", readyAt: Date.now() - 1_000, canSend: true, send }
          })
        })
      );
      await Promise.resolve();
    });
    const button = container.querySelector<HTMLButtonElement>("[data-testid=run-continue]");
    expect(button?.disabled).toBe(false);

    // Each press is its own event, as two clicks of a person are.
    for (let press = 0; press < 2; press += 1) {
      await act(async () => {
        button?.click();
        await Promise.resolve();
      });
    }

    expect(send).toHaveBeenCalledTimes(1);
    expect(button?.disabled).toBe(true);
    act(() => root.unmount());
  });
});
