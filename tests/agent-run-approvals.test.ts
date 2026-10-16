import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  type AgentRunStatus,
  type CentralPolicySetting
} from "@work-shape/catalyst-core";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { deferred, required, waitUntil } from "./support/assertions";
import { injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import { createToolCallingModel, TOOL_CALLING_MODEL_PROVIDER } from "./support/held-model";
import { fileTestDatabaseUrl } from "./support/test-database";
import { createTestInstance, getTestConfig, getTestJobs } from "./support/test-instance";

async function fixture() {
  const executed: string[] = [];
  const change = defineTool({
    name: "demo.change",
    effect: "changing",
    permission: { mode: "allow" },
    description: "Changes the named item after approval.",
    inputSchema: z.object({ text: z.string().default("default") }),
    execute(input) {
      executed.push(input.text);
      return toolSuccess({ changed: input.text });
    }
  });
  const person = (id: string, roles: string[]) => ({
    id,
    externalUserId: id,
    displayLabel: id,
    roles,
    permissionRefs: ["demo-tools"]
  });
  const config = createTestConfig({
    tools: [{ name: change.name, enabled: true }],
    toolNames: [change.name],
    developmentAuth: {
      enabled: true,
      users: [
        person("requester", ["user"]),
        person("approver", ["admin"]),
        person("stranger", ["user"])
      ],
      defaultUserId: "requester"
    }
  });
  config.infrastructure.models = {
    local: { provider: TOOL_CALLING_MODEL_PROVIDER, model: "local" }
  };
  const model = createToolCallingModel();
  const start = (seedAssets: boolean) =>
    createTestInstance({
      config,
      env: {},
      tools: [change],
      capabilities: [model.capability],
      seedAssets,
      operations: {
        centralPolicySettings: (): CentralPolicySetting[] => [
          { operation: change.name, value: "approval" }
        ]
      }
    });
  let app = await start(true);
  const clientInstanceId = asClientInstanceId(getTestConfig(app).clientInstance.id);
  const run = async (runId: string) =>
    required(
      await app.stores.agentRuns.getAgentRun({ clientInstanceId, runId: asAgentRunId(runId) })
    );
  const until = (runId: string, status: AgentRunStatus) =>
    waitUntil(async () => (await run(runId)).status === status, `the run is ${status}`);
  const calls = async (runId: string) =>
    (await app.stores.operationRuns.list({ clientInstanceId })).filter(
      (call) => call.origin.kind === "agent" && call.origin.agentRunId === runId
    );
  const messages = (conversationId: string) =>
    app.stores.conversations.listMessages({
      clientInstanceId,
      conversationId: asConversationId(conversationId)
    });
  const startMessage = async (text: string) => {
    const created = await app.call("conversations.create", { payload: { title: "Approval" } });
    const conversationId = created.json<{ id: string }>().id;
    const started = await injectStartConversationRun(app, conversationId, text);
    return { conversationId, runId: started.run.id };
  };
  return {
    startMessage,
    get app() {
      return app;
    },
    clientInstanceId,
    executed,
    run,
    until,
    calls,
    messages,
    async say(text = '/tool demo.change {"text":"one"}') {
      const started = await startMessage(text);
      await until(started.runId, "waiting_for_decision");
      return { ...started, call: required((await calls(started.runId))[0]) };
    },
    decide(requestId: string, decision: "approve" | "reject", as = "approver", comment?: string) {
      return app.call("approval_requests.decide", {
        params: { requestId },
        headers: { "x-dev-user-id": as },
        payload: { decision, ...(comment ? { comment } : {}) }
      });
    },
    async events(runId: string) {
      return (
        await app.stores.agentRuns.listRunObservations({
          clientInstanceId,
          runId: asAgentRunId(runId)
        })
      ).map((event) => event.payload);
    },
    async restart() {
      await app.close();
      app = await start(false);
    }
  };
}

describe("agent approval pause (operations checks 4, 5 and 6)", () => {
  it("check 4: pauses and keeps the conversation busy, then resumes after restart and executes once on approval", async () => {
    const f = await fixture();
    const said = await f.say("/tool demo.change {}");
    const requestId = required(said.call.approvalRequestId);
    expect(f.executed).toEqual([]);
    expect(said.call.status).toBe("pending_approval");
    expect(await f.messages(said.conversationId)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "tool" })])
    );
    expect((await f.events(said.runId)).at(-1)).toMatchObject({
      type: "tool_decision_requested",
      mode: "approval",
      operationRunId: said.call.id,
      inputPreview: { text: "default" }
    });
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1 });
    try {
      const [row] =
        await sql`select lease_owner, lease_token from agent_runs where id = ${said.runId}`;
      expect(row).toMatchObject({ lease_owner: null, lease_token: null });
    } finally {
      await sql.end({ timeout: 5 });
    }
    const busy = await f.app.call("conversations.runs.start", {
      params: { conversationId: said.conversationId },
      payload: { idempotencyKey: "busy", message: { text: "another" } }
    });
    expect(busy.statusCode).toBe(409);
    for (const as of ["approver", "stranger"]) {
      const list = await f.app.call("approval_requests.list", {
        query: { status: "pending" },
        headers: { "x-dev-user-id": as }
      });
      if (as === "stranger") {
        expect(list.statusCode).toBe(403);
        expect(
          (
            await f.app.call("approval_requests.get", {
              params: { requestId },
              headers: { "x-dev-user-id": as }
            })
          ).statusCode
        ).toBe(404);
      } else {
        expect(list.statusCode).toBe(200);
        expect(
          list.json<{ items: { id: string }[] }>().items.some((item) => item.id === requestId)
        ).toBe(true);
      }
    }
    expect((await f.decide(requestId, "approve", "stranger")).statusCode).toBe(404);
    await f.restart();
    expect((await f.decide(requestId, "approve")).statusCode).toBe(200);
    await getTestJobs(f.app).runDue();
    await f.until(said.runId, "completed");
    expect(f.executed).toEqual(["default"]);
    expect(await f.calls(said.runId)).toMatchObject([
      { id: said.call.id, status: "done", decision: { mode: "approved", byLabel: "approver" } }
    ]);
    expect((await f.messages(said.conversationId)).at(-1)?.text).toContain('"changed": "default"');
    expect((await f.decide(requestId, "approve")).statusCode).toBe(409);
    await getTestJobs(f.app).runDue();
    expect(f.executed).toEqual(["default"]);
    expect(
      (await f.events(said.runId)).filter((event) => event.type === "tool_decision_recorded")
    ).toMatchObject([{ operationRunId: said.call.id, outcome: "confirmed" }]);
    await f.app.close();
  });

  it("check 4: an approval before the pause is stored resumes once and leaves later calls in order", async () => {
    const f = await fixture();
    const release = deferred<void>();
    let storingPause = false;
    const append = f.app.stores.agentRuns.appendClaimedAgentRunEnd.bind(f.app.stores.agentRuns);
    f.app.stores.agentRuns.appendClaimedAgentRunEnd = async (input) => {
      if (input.events.some((event) => event.type === "tool_decision_requested")) {
        storingPause = true;
        await release.promise;
      }
      return append(input);
    };
    try {
      const started = await f.startMessage(
        ['/tool demo.change {"text":"one"}', '/tool demo.change {"text":"two"}'].join("\n")
      );
      await waitUntil(
        () => Promise.resolve(storingPause),
        "the worker is about to store its pause"
      );
      const first = required((await f.calls(started.runId))[0]);
      expect(await f.calls(started.runId)).toHaveLength(1);
      expect(f.executed).toEqual([]);
      expect((await f.decide(required(first.approvalRequestId), "approve")).statusCode).toBe(200);
      release.resolve();
      await waitUntil(
        async () =>
          (await f.calls(started.runId)).some(
            (call) => call.id !== first.id && call.status === "pending_approval"
          ),
        "the second call waits after the first ran"
      );
      await f.until(started.runId, "waiting_for_decision");
      expect(f.executed).toEqual(["one"]);
      const second = required((await f.calls(started.runId)).find((call) => call.id !== first.id));
      expect((await f.decide(required(second.approvalRequestId), "reject")).statusCode).toBe(200);
      await f.until(started.runId, "completed");
      expect(f.executed).toEqual(["one"]);
      expect(
        (await f.messages(started.conversationId)).filter((message) => message.role === "tool")
      ).toHaveLength(2);
      expect(
        (await f.events(started.runId)).filter((event) => event.type === "tool_decision_recorded")
      ).toHaveLength(2);
    } finally {
      release.resolve();
      await f.app.close();
    }
  });

  it("executes an approval left by a completed turn from before approval pauses", async () => {
    const f = await fixture();
    const said = await f.say();
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1 });
    try {
      // The previous release returned success and ended the turn, retaining the request.
      await sql`update agent_runs set status = 'completed', completed_at = now(), resume_state = null where id = ${said.runId}`;
    } finally {
      await sql.end({ timeout: 5 });
    }
    expect((await f.decide(required(said.call.approvalRequestId), "approve")).statusCode).toBe(200);
    await getTestJobs(f.app).runDue();
    expect(f.executed).toEqual(["one"]);
    expect(await f.calls(said.runId)).toMatchObject([
      { id: said.call.id, status: "done", decision: { mode: "approved" } }
    ]);
    expect((await f.run(said.runId)).status).toBe("completed");
    await f.app.close();
  });

  it.each([undefined, "Not this one."])(
    "check 5: rejection resumes with a denied tool result and optional reason %s",
    async (comment) => {
      const f = await fixture();
      const said = await f.say();
      expect(
        (await f.decide(required(said.call.approvalRequestId), "reject", "approver", comment))
          .statusCode
      ).toBe(200);
      await f.until(said.runId, "completed");
      expect(f.executed).toEqual([]);
      expect(await f.calls(said.runId)).toMatchObject([
        {
          id: said.call.id,
          status: "denied",
          decision: { mode: "declined", ...(comment ? { comment } : {}) }
        }
      ]);
      const tool = (await f.messages(said.conversationId)).find(
        (message) => message.role === "tool"
      );
      expect(tool?.text).toContain("not_allowed");
      expect(tool?.text).toContain(comment ?? "The user declined this call. Nothing ran.");
      expect((await f.messages(said.conversationId)).at(-1)?.text).toContain(comment ?? "declined");
      await f.app.close();
    }
  );

  it("check 6: seven days expires the approval and resumes with expired without execution", async () => {
    const f = await fixture();
    const said = await f.say();
    const requestId = required(said.call.approvalRequestId);
    expect(
      Date.parse(required(said.call.expiresAt)) - Date.parse(said.call.createdAt)
    ).toBeGreaterThan(7 * 24 * 60 * 60 * 1000 - 60_000);
    expect(
      Date.parse(required(said.call.expiresAt)) - Date.parse(said.call.createdAt)
    ).toBeLessThan(7 * 24 * 60 * 60 * 1000 + 1000);
    // Move this test's deadline through the database clock; no worker timers or shared rows move.
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1 });
    try {
      await sql`update operation_runs set expires_at = now() - interval '1 second' where id = ${said.call.id}`;
      await sql`update platform_jobs set run_after = now() where kind = 'operation_runs.expire' and client_instance_id = ${f.clientInstanceId} and status = 'queued'`;
    } finally {
      await sql.end({ timeout: 5 });
    }
    await getTestJobs(f.app).runDue();
    await f.until(said.runId, "completed");
    expect(f.executed).toEqual([]);
    expect(await f.calls(said.runId)).toMatchObject([{ id: said.call.id, status: "expired" }]);
    expect(
      await f.app.stores.approvals.getApprovalRequest({
        clientInstanceId: f.clientInstanceId,
        requestId
      })
    ).toMatchObject({ status: "superseded", applyResult: { execution: "expired" } });
    const tool = (await f.messages(said.conversationId)).find((message) => message.role === "tool");
    expect(tool?.text).toContain("expired");
    expect((await f.messages(said.conversationId)).at(-1)?.text).toContain("Nothing ran");
    expect(
      (await f.events(said.runId)).filter((event) => event.type === "tool_decision_recorded")
    ).toMatchObject([{ outcome: "expired" }]);
    expect((await f.decide(requestId, "approve")).statusCode).toBe(409);
    await f.app.close();
  });
});
