import { describe, expect, it } from "vitest";
import { createApiClient } from "@work-shape/catalyst-api-client";

// CR-1, check 98: a client built before an event type existed skips it and keeps the stream
// open, keeping its sequence as the cursor, so a newer server never breaks an older page.

const createdAt = "2026-10-17T09:00:00.000Z";
const runParams = { conversationId: "conv_1", runId: "run_1" };

function observation(sequence: number, payload: Record<string, unknown>) {
  return {
    clientInstanceId: "client_1",
    runId: "run_1",
    conversationId: "conv_1",
    ownerUserId: "user_1",
    sequence,
    type: payload.type,
    payload: { runId: "run_1", sequence, createdAt, ...payload },
    createdAt
  };
}

function streamOf(values: unknown[]) {
  const body = values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("");
  return createApiClient({
    baseUrl: "https://chat.example/",
    fetchImpl: async () => new Response(body, { headers: { "content-type": "text/event-stream" } })
  });
}

describe("an observation of a type the client does not know", () => {
  it("is skipped, keeps the stream open and reports its sequence", async () => {
    const client = streamOf([
      observation(1, { type: "message_delta", delta: "Hello" }),
      observation(2, { type: "subagent_heartbeat_from_a_newer_server", beats: 3 }),
      observation(3, { type: "message_delta", delta: " world" })
    ]);
    const seen: number[] = [];
    const skipped: { runId: string; sequence: number }[] = [];

    for await (const event of client.conversations.runs.observe({
      params: runParams,
      onSkipped: (value) => skipped.push({ runId: value.runId, sequence: value.sequence })
    })) {
      seen.push(event.sequence);
    }

    expect(seen).toEqual([1, 3]);
    expect(skipped).toEqual([{ runId: "run_1", sequence: 2 }]);
  });

  it("reads subagent_started, the event CR-1 adds", async () => {
    const client = streamOf([
      observation(1, {
        type: "subagent_started",
        toolCallId: "call_1",
        subagentRunId: "run_child",
        threadId: "conv_thread",
        agent: "researcher",
        description: "Marktanalyse"
      })
    ]);
    const events = [];
    for await (const event of client.conversations.runs.observe({ params: runParams })) {
      events.push(event.payload);
    }
    expect(events).toEqual([
      expect.objectContaining({ type: "subagent_started", subagentRunId: "run_child" })
    ]);
  });

  it("still fails on a known type whose fields are wrong", async () => {
    const client = streamOf([observation(1, { type: "message_delta", delta: 42 })]);
    const failure = await (async () => {
      for await (const _event of client.conversations.runs.observe({ params: runParams })) {
        // Nothing arrives before the failure.
      }
    })().catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(Error);
  });
});
