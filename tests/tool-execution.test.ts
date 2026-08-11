import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AuditRecorder } from "@vivd-catalyst/core";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asToolCallId,
  type AuditEvent,
  type ModelUsageEvent,
  type ModelUsageEventInput,
  type ToolExecutionContext
} from "@vivd-catalyst/core";
import { InProcessToolExecution, ToolRegistry } from "@vivd-catalyst/tool-execution";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";

describe("in-process tool execution", () => {
  it("authorizes, validates, and executes a registered tool through the product interface", async () => {
    const tool = defineTool({
      name: "demo.echo",
      description: "Echo text for tests.",
      inputSchema: z.object({ text: z.string().min(1) }),
      outputSchema: z.object({ echoed: z.string() }),
      permission: {
        mode: "allow",
        requiredPermissionRefs: ["demo-tools"]
      },
      async execute(input) {
        return toolSuccess(
          { echoed: input.text },
          {
            modelUsage: [
              {
                providerId: "document-provider",
                model: "document-model",
                inputTokens: 100,
                outputTokens: 20,
                totalTokens: 120,
                source: "provider_reported"
              }
            ]
          }
        );
      }
    });
    const context: ToolExecutionContext = {
      clientInstanceId: asClientInstanceId("demo-local"),
      correlationId: "corr_test",
      user: {
        id: "user-1",
        externalUserId: "user-1",
        displayLabel: "User",
        roles: ["user"],
        permissionRefs: ["demo-tools"],
        clientInstanceId: asClientInstanceId("demo-local"),
        authSource: "test"
      }
    };
    const auditEvents: Array<{ type: string; status: string; metadata?: unknown }> = [];
    const modelUsageEvents: ModelUsageEventInput[] = [];
    const auditRecorder: AuditRecorder = {
      async record(input) {
        auditEvents.push(input);
        return {
          ...input,
          id: "audit_1" as AuditEvent["id"],
          clientInstanceId: context.clientInstanceId,
          createdAt: new Date().toISOString()
        };
      }
    };
    const execution = new InProcessToolExecution({
      registry: new ToolRegistry({ tools: [tool] }),
      getAgentToolNames: () => ["demo.echo"],
      auditRecorder,
      usageRecorder: {
        async recordModelUsage(input) {
          modelUsageEvents.push(input);
          return {
            ...input,
            id: "usage_1",
            createdAt: new Date().toISOString(),
            webSearchCallCount: 0,
            customerBillableCost: {
              status: "unpriced",
              source: "rate_card",
              calculationVersion: 1,
              missingMeters: ["model_rate"]
            }
          } as ModelUsageEvent;
        }
      }
    });
    const request = {
      toolName: "demo.echo",
      toolCallId: asToolCallId("toolcall_1"),
      agentRunId: asAgentRunId("run_1"),
      conversationId: asConversationId("conv_1"),
      agentName: "test_agent",
      input: { text: "hello" }
    };

    const decision = await execution.authorize(request, context);
    expect(decision.status).toBe("allowed");
    if (decision.status !== "allowed") {
      throw new Error("Expected allowed decision");
    }

    const result = await execution.execute({ ...request, authorization: decision }, context);
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.output).toEqual({ echoed: "hello" });
      expect(result).not.toHaveProperty("modelUsage");
    }
    expect(modelUsageEvents).toEqual([
      expect.objectContaining({
        clientInstanceId: context.clientInstanceId,
        conversationId: request.conversationId,
        agentRunId: request.agentRunId,
        agentName: request.agentName,
        providerId: "document-provider",
        model: "document-model",
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        source: "provider_reported",
        correlationId: context.correlationId
      })
    ]);
    expect(auditEvents.map((event) => event.type)).toEqual([
      "tool.authorization_checked",
      "tool.started",
      "tool.completed"
    ]);
    expect(auditEvents[0]).toMatchObject({
      status: "success",
      metadata: {
        authorizationStatus: "allowed"
      }
    });
  });
});
