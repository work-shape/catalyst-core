import { LocalAgentRuntime } from "@work-shape/catalyst-agent-runtime";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asMessageId,
  type ModelProviderConfig,
  type RuntimeCallContext
} from "@work-shape/catalyst-core";
import { ToolRegistry } from "@work-shape/catalyst-tool-execution";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import { describe, expect, it } from "vitest";
import {
  createConversationWithMessages,
  createUnusedToolRunner,
  noReportedUsage
} from "./helpers/agent-runtime";
import { withTestModelGateway } from "./support/model-gateway";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";
import { createTestInstance } from "./support/test-instance";

describe("local agent runtime", () => {
  it("reclaims stale pending run-start idempotency commands", async () => {
    const store = (await createTestInstance()).stores;
    const clientInstanceId = asClientInstanceId("run-start-reclaim-client");
    const baseInput = {
      clientInstanceId,
      ownerUserId: "user-1",
      idempotencyKey: "idem-reclaim",
      commandKind: "start_conversation_run" as const
    };

    const firstClaim = await store.agentRuns.claimRunStartCommand({
      ...baseInput,
      createdAt: "2026-06-27T00:00:00.000Z"
    });
    expect(firstClaim.status).toBe("claimed");

    const freshRetry = await store.agentRuns.claimRunStartCommand({
      ...baseInput,
      createdAt: "2026-06-27T00:01:00.000Z",
      reclaimPendingBefore: "2026-06-26T23:59:00.000Z"
    });
    expect(freshRetry.status).toBe("existing");

    const reclaimed = await store.agentRuns.claimRunStartCommand({
      ...baseInput,
      createdAt: "2026-06-27T00:06:00.000Z",
      reclaimPendingBefore: "2026-06-27T00:05:00.000Z"
    });
    expect(reclaimed.status).toBe("claimed");
    expect(reclaimed.command).toMatchObject({
      status: "pending",
      updatedAt: "2026-06-27T00:06:00.000Z"
    });
    await expect(
      store.agentRuns.completeRunStartCommand({
        ...baseInput,
        claimedAt: firstClaim.command.updatedAt,
        conversationId: asConversationId("conv_reclaim_old"),
        userMessageId: asMessageId("msg_reclaim_old"),
        runId: asAgentRunId("run_reclaim_old"),
        updatedAt: "2026-06-27T00:07:00.000Z"
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
  });

  it("observes a completed local run from an event cursor", async () => {
    const clientInstanceId = asClientInstanceId("cursor-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-cursor",
      user: {
        id: "user-1",
        externalUserId: "user-1",
        displayLabel: "User",
        roles: ["user"],
        permissionRefs: [],
        clientInstanceId,
        authSource: "test"
      }
    };
    const store = (await createTestInstance()).stores;
    const conversationId = await createConversationWithMessages(store, {
      clientInstanceId,
      messages: []
    });
    const providerConfig: ModelProviderConfig = {
      id: "test-provider",
      type: "deterministic",
      model: "test-model"
    };
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              skillNames: [],
              name: "cursor_agent",
              displayName: "Cursor Agent",
              instructions: "Help the user.",
              modelProviderId: "test-provider",
              toolNames: [],
              initialPrompts: []
            }
          ]
        }),
        modelProviders: [providerConfig],
        defaultModelProvider: providerConfig,
        conversationHistory: store.conversations,
        modelProvider: {
          id: "test-provider",
          async complete() {
            return {
              text: "Cursor response.",
              toolCalls: [],
              usage: noReportedUsage()
            };
          }
        },
        toolRegistry: new ToolRegistry({ tools: [] }),
        runTool: createUnusedToolRunner(),
        usageGovernance: new ModelUsageGovernance({
          store: store.usage,
          budget: {},
          safeguards: {}
        })
      })
    );

    const run = await runtime.start(
      {
        agentName: "cursor_agent",
        conversationId,
        message: {
          text: "hello"
        }
      },
      context
    );

    const allEvents = [];
    for await (const event of runtime.observe(run.runId, context)) {
      allEvents.push(event);
    }
    expect(allEvents.map((event) => event.type)).toEqual([
      "message_delta",
      "message_completed",
      "run_completed"
    ]);

    const resumedEvents = [];
    for await (const event of runtime.observe(run.runId, context, { afterSequence: 1 })) {
      resumedEvents.push(event);
    }

    expect(resumedEvents.map((event) => event.type)).toEqual([
      "message_completed",
      "run_completed"
    ]);
    expect(resumedEvents.map((event) => event.sequence)).toEqual([2, 3]);
  });

  it("announces the end of a run only after the run is recorded as ended", async () => {
    const clientInstanceId = asClientInstanceId("terminal-order-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-terminal-order",
      user: {
        id: "user-1",
        externalUserId: "user-1",
        displayLabel: "User",
        roles: ["user"],
        permissionRefs: [],
        clientInstanceId,
        authSource: "test"
      }
    };
    const store = (await createTestInstance()).stores;
    const conversationId = await createConversationWithMessages(store, {
      clientInstanceId,
      messages: []
    });
    const inputMessage = await store.conversations.appendMessage({
      clientInstanceId,
      conversationId,
      role: "user",
      text: "hello"
    });
    const providerConfig: ModelProviderConfig = {
      id: "test-provider",
      type: "deterministic",
      model: "test-model"
    };
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              skillNames: [],
              name: "terminal_order_agent",
              displayName: "Terminal Order Agent",
              instructions: "Help the user.",
              modelProviderId: "test-provider",
              toolNames: [],
              initialPrompts: []
            }
          ]
        }),
        modelProviders: [providerConfig],
        defaultModelProvider: providerConfig,
        conversationHistory: store.conversations,
        // A store that takes its time, as a loaded database does.
        agentRunStore: {
          ...store.agentRuns,
          async updateAgentRunStatus(input) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return store.agentRuns.updateAgentRunStatus(input);
          }
        },
        runObservationStore: store.agentRuns,
        modelProvider: {
          id: "test-provider",
          async complete() {
            return {
              text: "Done.",
              toolCalls: [],
              usage: noReportedUsage()
            };
          }
        },
        toolRegistry: new ToolRegistry({ tools: [] }),
        runTool: createUnusedToolRunner(),
        usageGovernance: new ModelUsageGovernance({
          store: store.usage,
          budget: {},
          safeguards: {}
        })
      })
    );

    const run = await runtime.start(
      {
        agentName: "terminal_order_agent",
        conversationId,
        inputMessageId: inputMessage.id,
        message: {
          text: "hello"
        }
      },
      context
    );

    // What an observer reads back at the moment it hears the run has ended.
    const recordedWhenAnnounced: Array<string | undefined> = [];
    for await (const event of runtime.observe(run.runId, context)) {
      if (event.type === "run_completed") {
        const recorded = await store.agentRuns.getAgentRun({ clientInstanceId, runId: run.runId });
        recordedWhenAnnounced.push(recorded?.status);
      }
    }

    expect(recordedWhenAnnounced).toEqual(["completed"]);
  });
});
