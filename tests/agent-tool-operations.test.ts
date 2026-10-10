import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ClientInstanceCapability } from "@vivd-catalyst/capability-sdk";
import {
  asClientInstanceId,
  createPlatformId,
  getRuntimeSubjectUserId,
  type CentralPolicySetting
} from "@vivd-catalyst/core";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, getTestConfig } from "./support/test-instance";

// A chat run on an assembled instance whose agent calls tools: each call is a call of the
// operation the tool is registered as, so it leaves an Operation Run, and what the person
// reads in the conversation is what it was.
//
// Every test here fails without the change: an agent's tool call went past `runOperation`
// and left no run, and a usage row could not name one.

const calls: string[] = [];
const EXTRACTION_BINDING = "extraction";
/**
 * A capability whose tool changes something and calls a model for it, the way a capability
 * does: through the instance's model gateway, naming the run its context gives it.
 */
const changeCapability: ClientInstanceCapability = {
  name: "test-changing",
  create: ({ models }) => ({
    tools: [
      defineTool({
        name: "demo.change",
        effect: "changing",
        description: "Changes something and calls a model for it.",
        inputSchema: z.object({ text: z.string() }),
        outputSchema: z.object({ changed: z.string() }),
        async execute(input, context) {
          calls.push(input.text);
          await models.complete({
            bindingId: EXTRACTION_BINDING,
            purpose: "document_extraction",
            content: [{ type: "text", text: input.text }],
            userId: getRuntimeSubjectUserId(context),
            conversationId: context.toolRequest?.conversationId,
            workspaceId: context.operationRun?.workspaceId,
            operationRunId: context.operationRun?.id,
            correlationId: context.correlationId
          });
          return toolSuccess({ changed: input.text });
        }
      })
    ]
  })
};
const read = defineTool({
  name: "demo.read",
  effect: "reading",
  description: "Reads something.",
  inputSchema: z.object({ text: z.string() }),
  execute: (input) => toolSuccess({ read: input.text })
});
const locked = defineTool({
  name: "demo.locked",
  effect: "changing",
  description: "Needs a right the person does not hold.",
  inputSchema: z.object({}),
  permission: { mode: "allow", requiredPermissionRefs: ["vault"] },
  execute() {
    calls.push("locked");
    return toolSuccess({});
  }
});

async function fixture(centralSettings: CentralPolicySetting[] = []) {
  calls.length = 0;
  const names = ["demo.change", read.name, locked.name];
  const app = await createTestInstance({
    config: createTestConfig({
      tools: names.map((name) => ({ name, enabled: true })),
      toolNames: names,
      modelBindings: [{ id: EXTRACTION_BINDING, providerId: "local", agentSelectable: false }]
    }),
    env: {},
    capabilities: [changeCapability],
    tools: [read, locked],
    operations: { centralPolicySettings: () => centralSettings }
  });
  const clientInstanceId = asClientInstanceId(getTestConfig(app).clientInstance.id);
  /** One conversation with one message to the agent, and the run that answered it. */
  const say = async (text: string) => {
    const created = await app.call("conversations.create", { payload: { title: "Tools" } });
    const { id: conversationId, collaborationWorkspaceId: workspaceId } = created.json<{
      id: string;
      collaborationWorkspaceId: string;
    }>();
    const started = await injectStartConversationRun(app, conversationId, text);
    await drainRunEvents(app, conversationId, started.run.id);
    const messages = await app.call("conversations.messages.list", { params: { conversationId } });
    const toolMessages = messages
      .json<{ items: { role: string; text: string }[] }>()
      .items.filter((message) => message.role === "tool")
      .map((message) => message.text);
    return { conversationId, workspaceId, agentRunId: started.run.id, toolMessages };
  };
  const runs = () => app.stores.operationRuns.list({ clientInstanceId });
  return { app, clientInstanceId, say, runs };
}

describe("an agent's tool calls in a chat run", () => {
  it("leaves one Operation Run per tool call, for the person, with the usage of the call", async () => {
    const f = await fixture();
    const first = await f.say('/tool demo.change {"text":"one"}');
    const second = await f.say('/tool demo.read {"text":"two"}');

    const runs = await f.runs();
    expect(runs).toHaveLength(2);
    const me = (await f.app.call("me.get", {})).json<{ id: string }>();
    const [changing, reading] = [
      runs.find((run) => run.operation === "demo.change"),
      runs.find((run) => run.operation === "demo.read")
    ];
    expect(changing).toMatchObject({
      status: "done",
      effect: "changing",
      actor: { kind: "user", id: me.id },
      origin: {
        kind: "agent",
        conversationId: first.conversationId,
        agentRunId: first.agentRunId,
        toolName: "demo.change"
      }
    });
    expect(reading).toMatchObject({
      status: "done",
      effect: "reading",
      actor: { kind: "user", id: me.id },
      origin: {
        kind: "agent",
        conversationId: second.conversationId,
        agentRunId: second.agentRunId
      }
    });
    // The run is in the workspace of its conversation.
    expect(first.workspaceId).toEqual(expect.any(String));
    expect(changing?.workspaceId).toBe(first.workspaceId);

    // The model call the tool made is a usage row of the person, the workspace and the run.
    const usage = await f.app.stores.usage.listModelUsageEvents({
      clientInstanceId: f.clientInstanceId
    });
    const ofTool = usage.filter((event) => event.purpose === "document_extraction");
    expect(ofTool).toHaveLength(1);
    expect(ofTool[0]).toMatchObject({
      userId: me.id,
      collaborationWorkspaceId: changing?.workspaceId,
      operationRunId: changing?.id,
      bindingId: EXTRACTION_BINDING
    });
    // The agent's own model calls are no tool's and name no run.
    const ofAgent = usage.filter((event) => event.purpose === undefined);
    expect(ofAgent.length).toBeGreaterThan(0);
    expect(ofAgent.every((event) => event.operationRunId === undefined)).toBe(true);

    // The conversation reads as it did before tools were operations.
    expect(first.toolMessages).toEqual([expect.stringContaining('"changed": "one"')]);
    expect(second.toolMessages).toEqual([expect.stringContaining('"read": "two"')]);
    expect(calls).toEqual(["one"]);
    await f.app.close();
  });

  it("records a call the person has no right to as a denied run and tells the agent so", async () => {
    const f = await fixture();
    const said = await f.say("/tool demo.locked {}");

    const [run] = await f.runs();
    expect(run).toMatchObject({
      operation: "demo.locked",
      status: "denied",
      denial: { kind: "forbidden", action: "ref:vault" },
      origin: { kind: "agent" }
    });
    expect(calls).toEqual([]);
    expect(said.toolMessages).toHaveLength(1);
    expect(said.toolMessages[0]).toContain("not_allowed");
    const audit = await f.app.stores.audit.listAuditEvents({
      clientInstanceId: f.clientInstanceId
    });
    expect(
      audit
        .filter((event) => event.metadata?.operationRunId === run?.id)
        .map((event) => `${event.type}:${event.status}`)
        .sort()
    ).toEqual(["operation.authorization_checked:denied", "operation.denied:denied"]);
    await f.app.close();
  });

  it("holds a call an admin set to approval, tells the agent, and executes it once approved", async () => {
    const f = await fixture([{ operation: "demo.change", value: "approval" }]);
    const said = await f.say('/tool demo.change {"text":"held"}');

    const [held] = await f.runs();
    expect(held).toMatchObject({ operation: "demo.change", status: "pending_approval" });
    expect(calls).toEqual([]);
    // The agent reads that the call waits, and for what.
    expect(said.toolMessages).toHaveLength(1);
    expect(said.toolMessages[0]).toContain("This call has NOT run");
    expect(said.toolMessages[0]).toContain(held?.approvalRequestId);

    const requestId = held?.approvalRequestId ?? "";
    const request = await f.app.call("approval_requests.get", { params: { requestId } });
    expect(request.json()).toMatchObject({
      kind: "operation_call",
      origin: { conversationId: said.conversationId, agentRunId: said.agentRunId },
      preview: {
        operation: "demo.change",
        origin: { kind: "agent", toolName: "demo.change" },
        inputs: [{ key: "text", value: "held" }]
      }
    });
    const decide = () =>
      f.app.call("approval_requests.decide", {
        params: { requestId },
        payload: { decision: "approve" }
      });
    expect((await decide()).statusCode).toBe(200);
    expect((await decide()).statusCode).toBe(409);

    expect(calls).toEqual(["held"]);
    const [done] = await f.runs();
    expect(done).toMatchObject({
      id: held?.id,
      status: "done",
      decision: { mode: "approved" },
      origin: { kind: "agent", conversationId: said.conversationId }
    });
    // The model call the approved tool made is still a usage row of the run.
    const usage = await f.app.stores.usage.listModelUsageEvents({
      clientInstanceId: f.clientInstanceId
    });
    expect(usage.filter((event) => event.operationRunId === held?.id)).toHaveLength(1);
    await f.app.close();
  });

  it("deletes the runs of a conversation with it and leaves a run no conversation caused", async () => {
    const f = await fixture();
    const gone = await f.say('/tool demo.change {"text":"one"}');
    const kept = await f.say("/tool demo.locked {}");
    const ofApp = await f.app.stores.operationRuns.create({
      id: createPlatformId<"OperationRunId">("oprun"),
      clientInstanceId: f.clientInstanceId,
      operation: "items.create",
      effect: "changing",
      actor: { kind: "user", id: "usr_1", label: "One" },
      origin: { kind: "app", appRevisionId: "rev", actionName: "save", pageSessionId: "page" },
      inputHash: "a".repeat(64),
      correlationId: "corr_app",
      startedAt: new Date().toISOString()
    });
    expect(await f.runs()).toHaveLength(3);

    const deleted = await f.app.call("conversations.delete", {
      params: { conversationId: gone.conversationId }
    });
    expect(deleted.statusCode).toBeLessThan(300);

    const left = await f.runs();
    expect(left.map((run) => run.id).sort()).toEqual(
      [ofApp?.id, left.find((run) => run.operation === "demo.locked")?.id].sort()
    );
    expect(left).toHaveLength(2);
    expect(
      left.some(
        (run) => run.origin.kind === "agent" && run.origin.conversationId === kept.conversationId
      )
    ).toBe(true);
    await f.app.close();
  });
});
