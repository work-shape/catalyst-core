import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ClientInstanceCapability } from "@vivd-catalyst/capability-sdk";
import {
  asClientInstanceId,
  asCollaborationWorkspaceId,
  asUserId,
  createPlatformId,
  getRuntimeSubjectUserId,
  type CentralPolicySetting
} from "@vivd-catalyst/core";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, getTestConfig, getTestJobs } from "./support/test-instance";

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
        // Named, because a changing tool without a mode takes the instance default.
        permission: { mode: "allow" },
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
  const say = async (text: string, inWorkspaceId?: string) => {
    const created = await app.call("conversations.create", {
      payload: {
        title: "Tools",
        ...(inWorkspaceId ? { collaborationWorkspaceId: inWorkspaceId } : {})
      }
    });
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
    // Every tool records every call, a reading one too. Fails without the mark the tool's
    // operation carries: the reading tool would leave no run and no audit row.
    const audited = await f.app.stores.audit.listAuditEvents({
      clientInstanceId: f.clientInstanceId
    });
    expect(
      audited
        .filter((event) => event.metadata?.operationRunId === reading?.id)
        .map((event) => `${event.type}:${event.status}`)
        .sort()
    ).toEqual([
      "operation.authorization_checked:success",
      "operation.completed:success",
      "operation.started:success"
    ]);
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
    // The approval is recorded; the job that executes the call runs the tool.
    expect(calls).toEqual([]);
    await getTestJobs(f.app).runDue();

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

  // Fails before the fix: nothing asked for the membership when the call ran, and the tool
  // ran as a person who had left the workspace.
  it("does not run an approved call of a person who left the workspace, and says why", async () => {
    const f = await fixture([{ operation: "demo.change", value: "approval" }]);
    const shared = await f.app.call("workspaces.create", { payload: { name: "Shared" } });
    expect(shared.statusCode).toBe(200);
    const said = await f.say('/tool demo.change {"text":"left"}', shared.json<{ id: string }>().id);
    const [held] = await f.runs();
    const requestId = held?.approvalRequestId ?? "";
    expect(held).toMatchObject({ status: "pending_approval", workspaceId: said.workspaceId });
    const approved = await f.app.call("approval_requests.decide", {
      params: { requestId },
      payload: { decision: "approve" }
    });
    expect(approved.json()).toMatchObject({ status: "approved" });
    // The person leaves the workspace before the call runs.
    const removed = await f.app.stores.workspaces.removeMembership({
      clientInstanceId: f.clientInstanceId,
      collaborationWorkspaceId: asCollaborationWorkspaceId(said.workspaceId),
      userId: asUserId(held?.actor.id ?? "")
    });
    expect(removed).toBeDefined();

    await getTestJobs(f.app).runDue();

    expect(calls).toEqual([]);
    const [run] = await f.runs();
    expect(run).toMatchObject({ id: held?.id, status: "denied", denial: { kind: "forbidden" } });
    const request = await f.app.stores.approvals.getApprovalRequest({
      clientInstanceId: f.clientInstanceId,
      requestId
    });
    expect(request).toMatchObject({
      status: "superseded",
      applyResult: {
        execution: "refused",
        error: {
          message: "The person who made this call is no longer a member of its workspace."
        }
      }
    });
    expect(JSON.stringify(request?.payload)).not.toContain("left");
    await f.app.close();
  });

  // Fails before the fix: the allowlist of the agent was read when the call was approved,
  // inside the approval, and never when it ran.
  it("does not run an approved call of a tool the agent no longer lists", async () => {
    const f = await fixture([{ operation: "demo.change", value: "approval" }]);
    await f.say('/tool demo.change {"text":"unlisted"}');
    const [held] = await f.runs();
    const requestId = held?.approvalRequestId ?? "";
    await f.app.call("approval_requests.decide", {
      params: { requestId },
      payload: { decision: "approve" }
    });
    // The tool is taken off the agent's list before the call runs.
    await f.app.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId: f.clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: "test_agent",
          config: {
            skillNames: [],
            name: "test_agent",
            displayName: "Test Agent",
            instructions: "Use configured tools only.",
            modelProviderId: "local",
            toolNames: [read.name],
            initialPrompts: []
          }
        }
      ]
    });

    await getTestJobs(f.app).runDue();

    expect(calls).toEqual([]);
    const [run] = await f.runs();
    expect(run).toMatchObject({
      status: "denied",
      denial: { kind: "forbidden", action: "agent_tool:demo.change" }
    });
    const request = await f.app.stores.approvals.getApprovalRequest({
      clientInstanceId: f.clientInstanceId,
      requestId
    });
    expect(request).toMatchObject({ status: "superseded", applyResult: { execution: "refused" } });
    await f.app.close();
  });

  // Fails before the fix: the availability of the agent in the workspace was asked when its
  // run started and never when the call it left behind ran.
  it("does not run an approved call of an agent that was withdrawn from the workspace", async () => {
    const f = await fixture([{ operation: "demo.change", value: "approval" }]);
    const shared = await f.app.call("workspaces.create", { payload: { name: "Shared" } });
    const said = await f.say(
      '/tool demo.change {"text":"withdrawn"}',
      shared.json<{ id: string }>().id
    );
    const [held] = await f.runs();
    const requestId = held?.approvalRequestId ?? "";
    expect(held).toMatchObject({ status: "pending_approval", workspaceId: said.workspaceId });
    const approved = await f.app.call("approval_requests.decide", {
      params: { requestId },
      payload: { decision: "approve" }
    });
    expect(approved.json()).toMatchObject({ status: "approved" });
    // An admin withdraws the agent from this workspace before the call runs. The default
    // agent stays available everywhere, so another agent becomes the default first.
    await f.app.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId: f.clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: "other_agent",
          config: {
            skillNames: [],
            name: "other_agent",
            displayName: "Other Agent",
            instructions: "Use configured tools only.",
            modelProviderId: "local",
            toolNames: [],
            initialPrompts: []
          }
        },
        { type: "setDefaultAgent", agentName: "other_agent" }
      ]
    });
    await f.app.stores.configAssets.setAgentAvailability({
      clientInstanceId: f.clientInstanceId,
      agentName: "test_agent",
      availability: { mode: "selected", personalWorkspaces: true, collaborationWorkspaceIds: [] }
    });

    await getTestJobs(f.app).runDue();

    expect(calls).toEqual([]);
    const [run] = await f.runs();
    expect(run).toMatchObject({
      id: held?.id,
      status: "denied",
      denial: { kind: "forbidden", action: "agent_tool:demo.change" }
    });
    const request = await f.app.stores.approvals.getApprovalRequest({
      clientInstanceId: f.clientInstanceId,
      requestId
    });
    expect(request).toMatchObject({
      status: "superseded",
      applyResult: {
        execution: "refused",
        error: { message: "The agent that made this call is no longer available in its workspace." }
      }
    });
    expect(JSON.stringify(request?.payload)).not.toContain("withdrawn");
    await f.app.close();
  });

  // Was not tested before; it passes without the fix of this round.
  it("ends the held call of a deleted conversation and removes its input", async () => {
    const f = await fixture([{ operation: "demo.change", value: "approval" }]);
    const said = await f.say('/tool demo.change {"text":"secret-conversation"}');
    const [held] = await f.runs();
    const requestId = held?.approvalRequestId ?? "";

    const deleted = await f.app.call("conversations.delete", {
      params: { conversationId: said.conversationId }
    });
    expect(deleted.statusCode).toBeLessThan(300);

    expect(await f.runs()).toEqual([]);
    const request = await f.app.stores.approvals.getApprovalRequest({
      clientInstanceId: f.clientInstanceId,
      requestId
    });
    expect(request).toMatchObject({
      status: "superseded",
      applyResult: {
        execution: "refused",
        error: { message: "The conversation of this call was deleted." }
      },
      payload: { inputRemoved: true }
    });
    expect(JSON.stringify(request)).not.toContain("secret-conversation");
    const late = await f.app.call("approval_requests.decide", {
      params: { requestId },
      payload: { decision: "approve" }
    });
    expect(late.statusCode).toBe(409);
    expect(calls).toEqual([]);
    await f.app.close();
  });

  // Fails before the fix: the deletion skipped the request somebody was deciding, deleted
  // its run, and nothing found the open request again. It kept its input for good.
  it("ends a held call whose conversation was deleted while a decision on it failed", async () => {
    const f = await fixture([{ operation: "demo.change", value: "approval" }]);
    const said = await f.say('/tool demo.change {"text":"secret-orphan"}');
    const [held] = await f.runs();
    const requestId = held?.approvalRequestId ?? "";
    let entered: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let fail: () => void = () => undefined;
    const failing = new Promise<void>((resolve) => {
      fail = resolve;
    });
    // A decision that holds the request and fails in the end, as one whose commit fails.
    const decision = f.app.stores.approvals
      .transitionPendingApprovalRequest({
        clientInstanceId: f.clientInstanceId,
        requestId,
        resolve: async () => {
          entered();
          await failing;
          throw new Error("The decision could not be recorded");
        }
      })
      .catch(() => undefined);
    await holding;
    const deleted = await f.app.call("conversations.delete", {
      params: { conversationId: said.conversationId }
    });
    expect(deleted.statusCode).toBeLessThan(300);
    fail();
    await decision;
    const stored = () =>
      f.app.stores.approvals.getApprovalRequest({
        clientInstanceId: f.clientInstanceId,
        requestId
      });
    // The run is gone and the request is open, with what the agent was given.
    expect(await f.runs()).toEqual([]);
    expect(await stored()).toMatchObject({ status: "pending" });

    await getTestJobs(f.app).runDue();

    const request = await stored();
    expect(request).toMatchObject({
      status: "superseded",
      applyResult: {
        execution: "refused",
        error: { message: "The call of this request no longer exists." }
      },
      payload: { inputRemoved: true }
    });
    expect(JSON.stringify(request)).not.toContain("secret-orphan");
    expect(calls).toEqual([]);
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
