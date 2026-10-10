import { describe, expect, it, vi } from "vitest";

import { NoopAuditRecorder, asClientInstanceId, createPlatformId } from "@vivd-catalyst/core";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { createTestConfig, createTestUser } from "./support/fixtures";
import {
  createMissingRuntime,
  createUnusedModelProvider,
  drainRunEvents,
  parseSseChunks
} from "./support/chat-server-run-harness";
import { createTestInstance } from "./support/test-instance";

describe("the event stream of a run", () => {
  // Fails without the second read: the stream saw no event, then the finished run, and closed
  // with nothing sent.
  it.each([
    ["a new stream", 0],
    ["a stream resumed after a reconnect", 1]
  ])(
    "delivers every event to %s when the run ends between its event read and its status read",
    async (_reader, afterSequence) => {
      const clientInstanceId = asClientInstanceId("demo-local");
      const owner = createTestUser("user-1", clientInstanceId);
      const store = (await createTestInstance()).stores;
      const config = createTestConfig();
      const conversation = await store.createConversationForTesting({
        clientInstanceId,
        createdByUserId: owner.id,
        createdByExternalUserId: owner.externalUserId,
        title: "Run that ends between two reads",
        retainedUntil: "2030-01-01T00:00:00.000Z"
      });
      const userMessage = await store.conversations.appendMessage({
        clientInstanceId,
        conversationId: conversation.id,
        role: "user",
        text: "answer me"
      });
      const run = await store.agentRuns.createAgentRun({
        id: createPlatformId<"AgentRunId">("run"),
        clientInstanceId,
        conversationId: conversation.id,
        ownerUserId: owner.id,
        inputMessageId: userMessage.id,
        agentName: "test_agent",
        correlationId: "ends-between-reads",
        startedAt: "2026-08-11T00:00:00.000Z"
      });
      const append = (sequence: number, delta: string) =>
        store.agentRuns.appendRunObservation({
          clientInstanceId,
          runId: run.id,
          conversationId: conversation.id,
          ownerUserId: owner.id,
          event: {
            type: "message_delta",
            runId: run.id,
            sequence,
            delta,
            createdAt: "2026-08-11T00:00:01.000Z"
          }
        });
      for (let sequence = 1; sequence <= afterSequence; sequence += 1)
        await append(sequence, "Heard before the reconnect. ");

      // The worker of another process: it stores the rest of the answer and the end of the run
      // after the stream's first event read has returned, before the stream reads the run.
      const lastSequence = afterSequence + 2;
      const readEvents = store.agentRuns.listRunObservations.bind(store.agentRuns);
      let runEnded = false;
      vi.spyOn(store.agentRuns, "listRunObservations").mockImplementation(async (input) => {
        const events = await readEvents(input);
        if (runEnded) return events;
        runEnded = true;
        await append(afterSequence + 1, "The whole answer.");
        await store.agentRuns.appendRunObservation({
          clientInstanceId,
          runId: run.id,
          conversationId: conversation.id,
          ownerUserId: owner.id,
          event: {
            type: "run_completed",
            runId: run.id,
            sequence: lastSequence,
            createdAt: "2026-08-11T00:00:02.000Z"
          }
        });
        await store.agentRuns.updateAgentRunStatus({
          clientInstanceId,
          runId: run.id,
          status: "completed",
          updatedAt: "2026-08-11T00:00:02.000Z",
          completedAt: "2026-08-11T00:00:02.000Z",
          lastSequence
        });
        return events;
      });

      const server = await createTestInstance({
        server: {
          config,
          clientInstanceId,
          authAdapter: {
            credentialMode: "ambient",
            id: "test-auth",
            async authenticate() {
              return owner;
            }
          },
          stores: store,
          usageGovernance: new ModelUsageGovernance({
            store: store.usage,
            budget: config.usage.budget,
            safeguards: config.usage.safeguards,
            costs: config.usage.costs
          }),
          auditRecorder: new NoopAuditRecorder(),
          agentRuntime: createMissingRuntime(),
          modelProvider: createUnusedModelProvider()
        }
      });
      try {
        const events = parseSseChunks(
          await drainRunEvents(server, conversation.id, run.id, { afterSequence })
        );
        expect(runEnded).toBe(true);
        expect(events.map((event) => [event.sequence, event.type])).toEqual([
          [afterSequence + 1, "message_delta"],
          [lastSequence, "run_completed"]
        ]);
      } finally {
        await server.close();
      }
    }
  );
});
