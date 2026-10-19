import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  nextDueAfter,
  parseCron,
  type CentralPolicySetting
} from "@work-shape/catalyst-core";
import { scheduledStartSchema } from "@work-shape/catalyst-api-contract";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { createTestConfig } from "./support/fixtures";
import { createToolCallingModel, TOOL_CALLING_MODEL_PROVIDER } from "./support/held-model";
import { createTestInstance, getTestConfig, getTestJobs } from "./support/test-instance";
import { injectStartConversationRun } from "./support/chat-server-run-harness";
import { required, waitUntil } from "./support/assertions";
import { withTestSql } from "./support/test-sql";

const runPage = z.object({
  items: z.array(
    z.object({
      agentRunId: z.string().nullable(),
      conversationId: z.string().nullable(),
      status: z.string(),
      reason: z.string().nullable()
    })
  )
});

async function fixture() {
  const written: string[] = [];
  const change = defineTool({
    name: "demo.scheduled_change",
    effect: "changing",
    description: "Write a test value",
    inputSchema: z.object({ text: z.string() }),
    execute(input) {
      written.push(input.text);
      return toolSuccess({ changed: input.text });
    }
  });
  const model = createToolCallingModel();
  const config = createTestConfig({
    tools: [{ name: change.name, enabled: true }],
    toolNames: [change.name, "scheduled_starts.create", "scheduled_starts.list", "run_agent"],
    sessionToken: { issuer: "ew8-runtime", ttlSeconds: 900 },
    developmentAuth: {
      enabled: true,
      users: [
        {
          id: "owner",
          externalUserId: "owner",
          displayLabel: "Owner",
          roles: ["user", "admin", "superadmin"],
          permissionRefs: ["demo-tools"]
        },
        {
          id: "other",
          externalUserId: "other",
          displayLabel: "Other",
          roles: ["user", "admin", "superadmin"],
          permissionRefs: []
        }
      ],
      defaultUserId: "owner"
    }
  });
  config.clientInstance.timeZone = "Europe/Berlin";
  config.infrastructure.models = {
    local: { provider: TOOL_CALLING_MODEL_PROVIDER, model: "local" }
  };
  const policies: readonly CentralPolicySetting[] = [{operation:change.name,value:"confirm"},{operation:"scheduled_starts.create",value:"allow"}];
  const app = await createTestInstance({
    config,
    env: {
      CHAT_SESSION_TOKEN_SECRET: "ew8-test-session-signing-key-for-tests",
      CHAT_SERVER_CREDENTIAL: "ew8-test-server-credential"
    },
    capabilities: [model.capability],
    tools: [change],
    operations: {centralPolicySettings: () => policies}
  });
  const workspace = await app.call("conversations.create", {
    payload: { title: "Owner workspace" }
  });
  const workspaceId = z
    .object({ collaborationWorkspaceId: z.string() })
    .parse(workspace.json()).collaborationWorkspaceId;
  if (!workspaceId) throw new Error(`No owner workspace: ${workspace.body}`);
  const clientInstanceId = asClientInstanceId(getTestConfig(app).clientInstance.id);
  async function runs(id: string) {
    return runPage.parse(
      (await app.call("scheduled_starts.runs", { params: { scheduledStartId: id } })).json()
    ).items;
  }
  async function create(prompt = "Summarize today's work") {
    const response = await app.call("scheduled_starts.create", {
      payload: {
        collaborationWorkspaceId: workspaceId,
        agentName: "test_agent",
        prompt,
        cron: "0 6 * * *"
      }
    });
    expect(response.statusCode, response.body).toBe(200);
    return scheduledStartSchema.parse(response.json());
  }
  async function fire(id: string) {
    // Only this test's future tick is moved to the database's present. No wall-clock sleep.
    await withTestSql(async (sql) => {
      await sql`update platform_jobs set run_after = now() where client_instance_id = ${clientInstanceId} and kind = 'scheduled_prompt.fire' and subject = ${id} and status = 'queued'`;
    });
    await getTestJobs(app).runDue();
  }
  return { app, written, workspaceId, clientInstanceId, runs, create, fire };
}

describe("scheduled prompts use the shared executor and the owner's unattended run", () => {
  it("stores the instance zone and queues its due instant, including both DST transitions", async () => {
    const f = await fixture();
    const start = await f.create();
    expect(start.timeZone).toBe("Europe/Berlin");
    const cron = required(parseCron("30 2 * * *"));
    expect(
      nextDueAfter([cron], new Date("2030-03-30T12:00:00Z"), "Europe/Berlin")?.toISOString()
    ).toBe("2030-03-31T01:00:00.000Z");
    const autumn = nextDueAfter([cron], new Date("2030-10-26T12:00:00Z"), "Europe/Berlin");
    expect(autumn?.toISOString()).toBe("2030-10-27T00:30:00.000Z");
    expect(nextDueAfter([cron], required(autumn), "Europe/Berlin")?.toISOString()).toBe(
      "2030-10-28T01:30:00.000Z"
    );
    await getTestJobs(f.app).runDue();
    expect(await f.runs(start.id)).toEqual([]);
    await f.fire(start.id);
    await waitUntil(
      async () => (await f.runs(start.id))[0]?.status === "completed",
      "scheduled result completes"
    );
    const result = required((await f.runs(start.id))[0]);
    const usage = (
      await f.app.stores.usage.listModelUsageEvents({ clientInstanceId: f.clientInstanceId })
    ).filter((event) => event.agentRunId === result.agentRunId);
    expect(usage.length).toBeGreaterThan(0);
    expect(
      usage.every((event) => event.userId === start.ownerUserId && event.unattended === true)
    ).toBe(true);

    const shared = await withTestSql(
      (sql) =>
        sql<
          { calls: number }[]
        >`select coalesce(sum(model_call_count),0)::int as calls from model_usage_counters where client_instance_id = ${f.clientInstanceId} and scope_kind = 'system' and scope_id = '' and period_kind = 'day'`
    );
    expect(shared[0]?.calls).toBe(1);

    const conversation = await f.app.call("conversations.thread.get", {
      params: { conversationId: required(result.conversationId) }
    });
    expect(conversation.json()).toMatchObject({
      conversation: {
        visibility: "private",
        createdByUserId: start.ownerUserId
      }
    });
    expect(
      (
        await f.app.call("conversations.thread.get", {
          params: { conversationId: required(result.conversationId) },
          headers: { "x-dev-user-id": "other" }
        })
      ).statusCode
    ).toBe(404);
  });

  it("puts a confirm call in only the owner's Inbox, skips the next tick, and resumes the same run", async () => {
    const f = await fixture();
    const start = await f.create('/tool demo.scheduled_change {"text":"scheduled value"}');
    await f.fire(start.id);
    await waitUntil(
      async () => (await f.runs(start.id))[0]?.status === "waiting_for_decision",
      "scheduled confirmation waits"
    );
    const before = required((await f.runs(start.id))[0]);
    const runId = asAgentRunId(required(before.agentRunId));
    const call = required(
      (await f.app.stores.operationRuns.list({ clientInstanceId: f.clientInstanceId })).find(
        (call) =>
          call.origin.kind === "agent" &&
          call.origin.agentRunId === runId &&
          call.status === "pending_confirmation"
      )
    );
    expect(f.written).toEqual([]);
    const requestId = required(call.approvalRequestId);
    expect(
      (
        await f.app.call("approval_requests.get", {
          params: { requestId },
          headers: { "x-dev-user-id": "other" }
        })
      ).statusCode
    ).toBe(404);
    await f.fire(start.id);
    expect(await f.runs(start.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "skipped", reason: "waiting_for_decision" })
      ])
    );
    expect((await f.runs(start.id)).filter((run) => run.agentRunId)).toHaveLength(1);
    const allowed = await f.app.call("approval_requests.decide", {
      params: { requestId },
      payload: { decision: "approve" }
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
    await waitUntil(
      async () =>
        (await f.app.stores.agentRuns.getAgentRun({ clientInstanceId: f.clientInstanceId, runId }))
          ?.status === "completed",
      "same scheduled run completes"
    );
    expect(f.written).toEqual(["scheduled value"]);
  });

  it("asks for confirmation before a chat tool creates a start", async () => {
    const f = await fixture();
    const conversation = await f.app.call("conversations.create", {
      payload: { title: "Schedule from conversation" }
    });
    const conversationId = z.object({ id: z.string() }).parse(conversation.json()).id;
    const args = {
      collaborationWorkspaceId: f.workspaceId,
      agentName: "test_agent",
      prompt: "Summarize my work",
      cron: "0 8 * * 1-5",
      timeZone: "Europe/Berlin"
    };
    const started = await injectStartConversationRun(
      f.app,
      conversationId,
      `/tool scheduled_starts.create ${JSON.stringify(args)}`
    );
    const accepted = required(
      await f.app.stores.agentRuns.getAgentRun({
        clientInstanceId: f.clientInstanceId,
        runId: asAgentRunId(started.run.id)
      })
    );

    let operationId: string | undefined;
    await waitUntil(async () => {
      operationId = (
        await f.app.stores.operationRuns.list({ clientInstanceId: f.clientInstanceId })
      ).find(
        (call) =>
          call.origin.kind === "agent" &&
          call.origin.agentRunId === started.run.id &&
          call.status === "pending_confirmation"
      )?.id;
      return Boolean(operationId);
    }, "schedule tool asks for confirmation");
    expect(
      await f.app.stores.scheduledStarts.list({
        clientInstanceId: f.clientInstanceId,
        ownerUserId: accepted.ownerUserId,
        page: { limit: 10 }
      })
    ).toEqual([]);
    const confirmed = await f.app.call("operations.decide", {
      params: { runId: required(operationId) },
      payload: { decision: "confirm" }
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    await waitUntil(
      async () =>
        (
          await f.app.stores.scheduledStarts.list({
            clientInstanceId: f.clientInstanceId,
            ownerUserId: accepted.ownerUserId,
            page: { limit: 10 }
          })
        ).length === 1,
      "confirmed schedule exists"
    );
    await waitUntil(
      async () =>
        (
          await f.app.stores.agentRuns.getAgentRun({
            clientInstanceId: f.clientInstanceId,
            runId: accepted.id
          })
        )?.status === "completed",
      "chat schedule response completes"
    );
  });
  it("keeps a scoped chat run from scheduling a broader unattended start", async () => {
    const f = await fixture();
    const issued = await f.app.call("session_tokens.issue", {
      headers: { "x-server-credential": "ew8-test-server-credential" },
      payload: {
        externalUserId: "limited-owner",
        displayLabel: "Limited owner",
        roles: ["user"],
        permissionRefs: [],
        scopes: [
          "conversation:read",
          "conversation:write",
          "run:start",
          "run:observe",
          "config:read",
          "me:read"
        ]
      }
    });
    expect(issued.statusCode).toBe(200);
    const token = z.object({ chatSessionToken: z.string() }).parse(issued.json()).chatSessionToken;
    const headers = { authorization: "Bearer " + token };
    const created = await f.app.call("conversations.create", {
      headers,
      payload: { title: "Scoped scheduling" }
    });
    expect(created.statusCode, created.body).toBe(200);
    const conversation = z
      .object({ id: z.string(), collaborationWorkspaceId: z.string(), createdByUserId: z.string() })
      .parse(created.json());
    const args = {
      collaborationWorkspaceId: conversation.collaborationWorkspaceId,
      agentName: "test_agent",
      prompt: "Do my work",
      cron: "0 8 * * *",
      timeZone: "Europe/Berlin"
    };
    const started = await injectStartConversationRun(
      f.app,
      conversation.id,
      "/tool scheduled_starts.create " + JSON.stringify(args),
      { headers }
    );
    const runId = asAgentRunId(started.run.id);
    await waitUntil(
      async () =>
        (await f.app.stores.agentRuns.getAgentRun({ clientInstanceId: f.clientInstanceId, runId }))
          ?.status === "completed",
      "scoped scheduling is refused"
    );
    const operation = required(
      (await f.app.stores.operationRuns.list({ clientInstanceId: f.clientInstanceId })).find(
        (call) =>
          call.origin.kind === "agent" &&
          call.origin.agentRunId === runId &&
          call.operation === "scheduled_starts.create"
      )
    );
    expect(operation.status).toBe("denied");
    expect(
      await f.app.stores.scheduledStarts.list({
        clientInstanceId: f.clientInstanceId,
        ownerUserId: conversation.createdByUserId,
        page: { limit: 10 }
      })
    ).toEqual([]);
  });
  it("refuses deferred subagent starts from an unattended prompt", async () => {
    const f = await fixture();
    const start = await f.create(
      '/tool run_agent {"description":"Separate task","task":"Echo the task"}'
    );
    await f.fire(start.id);
    await waitUntil(
      async () => (await f.runs(start.id))[0]?.status === "completed",
      "unattended parent completes its refused subagent call"
    );
    const result = required((await f.runs(start.id))[0]);
    expect(
      await f.app.stores.childAgentRuns.listSubagents({
        clientInstanceId: f.clientInstanceId,
        conversationId: asConversationId(required(result.conversationId))
      })
    ).toEqual([]);
  });
});
