import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ClientInstanceCapability } from "@work-shape/catalyst-capability-sdk";
import {
  ENDED_AGENT_RUN_STATUSES,
  asClientInstanceId,
  asAgentRunId,
  asCollaborationWorkspaceId,
  asUserId,
  createPlatformId,
  scheduleDedupeKey,
  getRuntimeSubjectUserId,
  type CentralPolicySetting
} from "@work-shape/catalyst-core";
import { expireConversationsJob } from "@work-shape/catalyst-server";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, getTestConfig, getTestJobs } from "./support/test-instance";
import { deferred, waitUntil } from "./support/assertions";
import { withTestSql } from "./support/test-sql";
import { applyAtCurrentRevisions } from "./support/asset-revisions";

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
  // Revalidation tests change rights after approval and before the resumed worker claims it.
  const resume = deferred<void>();
  const claim = app.stores.agentRuns.claimAgentRunForJob.bind(app.stores.agentRuns);
  app.stores.agentRuns.claimAgentRunForJob = async (input) => {
    const run = await app.stores.agentRuns.getAgentRun({ clientInstanceId, runId: input.runId });
    if (run?.status === "queued" && run.lastSequence > 0) await resume.promise;
    return claim(input);
  };
  /** One conversation with one message to the agent, and the run that answered or paused. */
  const say = async (text: string, inWorkspaceId?: string, locale = "en") => {
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
    const started = await injectStartConversationRun(app, conversationId, text, {
      headers: { "accept-language": locale }
    });
    await waitUntil(async () => {
      const run = await app.stores.agentRuns.getAgentRun({
        clientInstanceId,
        runId: asAgentRunId(started.run.id)
      });
      return (
        run?.status === "completed" ||
        run?.status === "waiting_for_decision" ||
        run?.status === "failed"
      );
    }, "the tool run answered or paused");
    const messages = await app.call("conversations.messages.list", { params: { conversationId } });
    const toolMessages = messages
      .json<{ items: { role: string; text: string }[] }>()
      .items.filter((message) => message.role === "tool")
      .map((message) => message.text);
    return { conversationId, workspaceId, agentRunId: started.run.id, toolMessages };
  };
  const runs = () => app.stores.operationRuns.list({ clientInstanceId });
  const runJobs = async () => {
    resume.resolve();
    await getTestJobs(app).runDue();
    await waitUntil(async () => {
      for (const call of await runs()) {
        if (call.status === "pending_approval" || call.status === "running") return false;
        if (call.origin.kind === "agent") {
          const run = await app.stores.agentRuns.getAgentRun({
            clientInstanceId,
            runId: call.origin.agentRunId
          });
          if (run && !ENDED_AGENT_RUN_STATUSES.some((status) => status === run.status))
            return false;
        }
      }
      return true;
    }, "the approved call and its agent ended");
  };
  return { app, clientInstanceId, say, runs, runJobs };
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
    expect(first.toolMessages).toEqual([expect.stringContaining('"changed":"one"')]);
    expect(second.toolMessages).toEqual([expect.stringContaining('"read":"two"')]);
    expect(calls).toEqual(["one"]);
    await f.app.close();
  });

  it.each(["en", "de"])(
    "records a denied call and names who can help the person (%s)",
    async (locale) => {
      const f = await fixture();
      vi.spyOn(f.app.stores.users, "getInstanceAdminName").mockResolvedValue("Mara");
      const said = await f.say("/tool demo.locked {}", undefined, locale);

      const [run] = await f.runs();
      expect(run).toMatchObject({
        operation: "demo.locked",
        status: "denied",
        denial: { kind: "forbidden", action: "ref:vault" },
        origin: { kind: "agent" }
      });
      expect(calls).toEqual([]);
      expect(said.toolMessages).toHaveLength(1);
      expect(said.toolMessages[0]).not.toContain("not_allowed");
      expect(said.toolMessages[0]).toContain(
        locale === "de" ? "Du hast hier nicht das nötige Recht" : "You do not have the right"
      );
      expect(said.toolMessages[0]).toContain("Mara");
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
    }
  );

  it("pauses a call an admin set to approval and executes it once approved", async () => {
    const f = await fixture([{ operation: "demo.change", value: "approval" }]);
    const said = await f.say('/tool demo.change {"text":"held"}');

    const [held] = await f.runs();
    expect(held).toMatchObject({ operation: "demo.change", status: "pending_approval" });
    expect(calls).toEqual([]);
    // The step waits without answering the call as successful.
    expect(said.toolMessages).toEqual([]);

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
    await f.runJobs();

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

    await f.runJobs();

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

  it("runs an approved call of a person who left the workspace and builds there (WS-BUILD-1)", async () => {
    const f = await fixture([{ operation: "demo.change", value: "approval" }]);
    const shared = await f.app.call("workspaces.create", { payload: { name: "Shared" } });
    const said = await f.say(
      '/tool demo.change {"text":"built"}',
      shared.json<{ id: string }>().id
    );
    const [held] = await f.runs();
    const actorId = held?.actor.id ?? "";
    await f.app.call("approval_requests.decide", {
      params: { requestId: held?.approvalRequestId ?? "" },
      payload: { decision: "approve" }
    });
    // A Builder of the workspace works there without being its member.
    await f.app.stores.access.createGrant({
      clientInstanceId: f.clientInstanceId,
      holderKind: "user",
      holderId: actorId,
      action: "builder",
      effect: "allow",
      scopeKind: "workspace",
      scopeId: said.workspaceId,
      grantedBy: asUserId(actorId)
    });
    await f.app.stores.workspaces.removeMembership({
      clientInstanceId: f.clientInstanceId,
      collaborationWorkspaceId: asCollaborationWorkspaceId(said.workspaceId),
      userId: asUserId(actorId)
    });

    await f.runJobs();

    expect(calls).toEqual(["built"]);
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
    await applyAtCurrentRevisions(f.app.stores.configAssets, {
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

    await f.runJobs();

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
    await applyAtCurrentRevisions(f.app.stores.configAssets, {
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

    await f.runJobs();

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

  it("deletes a held call and its request with their conversation", async () => {
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
    expect(request).toBeUndefined();
    const late = await f.app.call("approval_requests.decide", {
      params: { requestId },
      payload: { decision: "approve" }
    });
    expect(late.statusCode).toBe(404);
    expect(calls).toEqual([]);
    await f.app.close();
  });

  // An old decision can hold the request across deletion. Keep its run until the cleanup
  // retry can settle the request, then remove both without executing the call.
  it("ends a held call whose conversation was deleted while a decision on it failed", async () => {
    const f = await fixture([{ operation: "demo.change", value: "approval" }]);
    const said = await f.say('/tool demo.change {"text":"secret-orphan"}');
    const [held] = await f.runs();
    const requestId = held?.approvalRequestId ?? "";
    const holding = deferred<void>();
    const failing = deferred<void>();
    // A previous-release decision held only the request. Current decisions take the
    // conversation first, so simulate the old lock directly to retain orphan-cleanup coverage.
    const decision = withTestSql((sql) =>
      sql.begin(async (tx) => {
        await tx`select id from approval_requests where client_instance_id = ${f.clientInstanceId} and id = ${requestId} for update`;
        holding.resolve();
        await failing.promise;
        throw new Error("The decision could not be recorded");
      })
    ).catch(() => undefined);
    try {
      await holding.promise;
      const deleted = await f.app.call("conversations.delete", {
        params: { conversationId: said.conversationId }
      });
      expect(deleted.statusCode).toBeLessThan(300);
      failing.resolve();
      await decision;
      const stored = () =>
        f.app.stores.approvals.getApprovalRequest({
          clientInstanceId: f.clientInstanceId,
          requestId
        });
      // An unsettled request keeps its run, which makes the deleted conversation retryable.
      expect(await f.runs()).toMatchObject([{ id: held?.id, status: "pending_approval" }]);
      expect(await stored()).toMatchObject({ status: "pending" });
      await f.app.stores.jobs.enqueue(
        expireConversationsJob,
        {},
        {
          clientInstanceId: f.clientInstanceId,
          dedupeKey: scheduleDedupeKey(expireConversationsJob.kind)
        }
      );
      await f.runJobs();

      expect(await f.runs()).toEqual([]);
      expect(await stored()).toBeUndefined();
      expect(calls).toEqual([]);
    } finally {
      failing.resolve();
      await decision;
      await f.app.close();
    }
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
      target: "live",
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
