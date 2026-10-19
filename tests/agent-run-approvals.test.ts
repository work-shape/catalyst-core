import { inspect } from "node:util";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  type AgentRunError,
  type JobId,
  type AgentRunStatus,
  type CentralPolicySetting
} from "@work-shape/catalyst-core";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { deferred, required, waitUntil } from "./support/assertions";
import { injectStartConversationRun } from "./support/chat-server-run-harness";
import { withTestSql } from "./support/test-sql";
import { createTestConfig } from "./support/fixtures";
import { createToolCallingModel, TOOL_CALLING_MODEL_PROVIDER } from "./support/held-model";
import { fileTestDatabaseUrl } from "./support/test-database";
import { createTestInstance, getTestConfig, getTestJobs } from "./support/test-instance";

async function fixture(startAgentRunJobs = true) {
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
        person("approver-2", ["admin"]),
        person("stranger", ["user"])
      ],
      defaultUserId: "requester"
    }
  });
  config.infrastructure.models = {
    local: { provider: TOOL_CALLING_MODEL_PROVIDER, model: "local" }
  };
  const model = createToolCallingModel();
  const start = (seedAssets: boolean, startJobs = startAgentRunJobs) =>
    createTestInstance({
      config,
      env: {},
      tools: [change],
      capabilities: [model.capability],
      seedAssets,
      startAgentRunJobs: startJobs,
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
    async restart(startJobs = startAgentRunJobs) {
      await app.close();
      app = await start(false, startJobs);
    }
  };
}

describe("agent approval pause (operations checks 4, 5 and 6)", () => {
  it.each(["queued Stop", "waiting Stop", "approve", "reject"] as const)(
    "%s takes the conversation before the run during a concurrent queue withdrawal",
    async (action) => {
      const f = await fixture(action !== "queued Stop");
      const said = action === "queued Stop" ? await f.startMessage("First") : await f.say();
      const scope = {
        clientInstanceId: f.clientInstanceId,
        conversationId: asConversationId(said.conversationId)
      };
      const queued = await f.app.call("conversations.runs.start", {
        params: { conversationId: said.conversationId },
        payload: {
          idempotencyKey: "concurrent-queue-change",
          message: { text: "Next" },
          followUp: "queue"
        }
      });
      expect(queued.statusCode, queued.body).toBe(200);
      const item = required((await f.app.stores.followUps.listPending(scope))[0]);
      const before = await f.events(said.runId);
      const requestId = (await f.calls(said.runId))[0]?.approvalRequestId;
      let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await f.app.stores.transaction(async (stores) => {
          // Hold the same conversation lock as queue acceptance and withdrawal (#197).
          await stores.followUps.getOldestPending(scope);
          const change =
            action === "queued Stop" || action === "waiting Stop"
              ? f.app.stores.agentRuns.requestAgentRunCancellation({
                  clientInstanceId: f.clientInstanceId,
                  runId: asAgentRunId(said.runId),
                  requestedAt: new Date().toISOString()
                })
              : f.decide(required(requestId), action);
          // Attach the rejection handler now: either transaction can be the deadlock victim.
          pending = Promise.allSettled([change]);
          await waitUntil(
            async () =>
              (
                await withTestSql(
                  (sql) => sql`
                select pid from pg_stat_activity
                where datname = current_database() and wait_event_type = 'Lock'
                  and cardinality(pg_blocking_pids(pid)) > 0
                  and (query ilike '%conversations%' or query ilike '%agent_run_observations%')
              `
                )
              ).length > 0,
            "Stop or approval is visibly blocked on the held conversation"
          );
          // On main, the other transaction already owns the run: this causes 40P01.
          await stores.followUps.cancel({ ...scope, followUpId: item.id });
        });
        const [outcome] = await required(pending);
        expect(outcome).toMatchObject({ status: "fulfilled" });
        if (action === "approve" || action === "reject") {
          expect(outcome).toMatchObject({ value: { statusCode: 200 } });
          await f.until(said.runId, "completed");
          expect(f.executed).toEqual(action === "approve" ? ["one"] : []);
        } else {
          expect((await f.run(said.runId)).status).toBe("cancelled");
        }
        expect(await f.app.stores.followUps.get({ ...scope, followUpId: item.id })).toMatchObject({
          status: "cancelled"
        });
        const events = await f.events(said.runId);
        expect(events.length).toBeGreaterThan(before.length);
        expect(events.map((event) => event.sequence)).toEqual(events.map((_, i) => i + 1));
      } finally {
        if (pending) await pending;
        await f.app.close();
      }
    }
  );

  it.each([
    "expiry sweep",
    "queued-too-long sweep",
    "workerless sweep",
    "failLostAgentRun"
  ] as const)(
    "%s takes the conversation before the run during a concurrent queue withdrawal",
    async (action) => {
      const f = await fixture(action === "expiry sweep");
      let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        const said = action === "expiry sweep" ? await f.say() : await f.startMessage("First");
        const scope = {
          clientInstanceId: f.clientInstanceId,
          conversationId: asConversationId(said.conversationId)
        };
        const runId = asAgentRunId(said.runId);
        const queued = await f.app.call("conversations.runs.start", {
          params: { conversationId: said.conversationId },
          payload: {
            idempotencyKey: "sweep-queue-change",
            message: { text: "Next" },
            followUp: "queue"
          }
        });
        expect(queued.statusCode, queued.body).toBe(200);
        const item = required((await f.app.stores.followUps.listPending(scope))[0]);
        const call = (await f.calls(said.runId))[0];
        const jobId = await withTestSql(async (sql) => {
          // Make only this run eligible, without advancing a worker's clock or timers.
          if (action === "expiry sweep") {
            await sql`update operation_runs set expires_at = now() - interval '1 second' where id = ${required(call).id}`;
          } else if (action === "queued-too-long sweep") {
            await sql`update agent_runs set updated_at = now() - interval '1 minute' where id = ${runId}`;
          } else {
            await sql`update agent_runs set status = 'running', lease_owner = 'lost-worker',
              lease_token = 'lost-lease', lease_expires_at = now() - interval '1 second'
              where id = ${runId}`;
          }
          const [job] = await sql<{ id: JobId }[]>`select id from platform_jobs
            where client_instance_id = ${f.clientInstanceId} and kind = 'agent_run.execute'
              and dedupe_key = ${`agent_run.execute:${runId}`}`;
          return required(job).id;
        });
        const error: AgentRunError = {
          code: "AGENT_RUN_WORKER_LOST",
          message: "The worker is gone",
          category: "runtime_interrupted"
        };
        const input = { clientInstanceId: f.clientInstanceId, limit: 1, error };
        const before = await f.events(said.runId);
        await f.app.stores.transaction(async (stores) => {
          await stores.followUps.getOldestPending(scope);
          const change = (() => {
            switch (action) {
              case "expiry sweep":
                return f.app.stores.operationRuns.markExpired(input);
              case "queued-too-long sweep":
                return f.app.stores.agentRuns.failAgentRunsQueuedTooLong({
                  ...input,
                  queuedMs: 1000
                });
              case "workerless sweep":
                return f.app.stores.agentRuns.failAgentRunsWithoutWorker({
                  ...input,
                  jobKind: "agent_run.execute"
                });
              case "failLostAgentRun":
                return f.app.stores.agentRuns.failLostAgentRun({ ...input, runId, jobId });
            }
          })();
          // Either transaction can be the victim of a reversed lock order: handle both now.
          pending = Promise.allSettled([change]);
          await waitUntil(
            async () =>
              (
                await withTestSql(
                  (sql) => sql`
                select pid from pg_stat_activity
                where datname = current_database() and wait_event_type = 'Lock'
                  and cardinality(pg_blocking_pids(pid)) > 0
                  and (query ilike '%conversations%' or query ilike '%agent_run_observations%')
              `
                )
              ).length > 0,
            `${action} is visibly blocked on the held conversation`
          );
          // Withdrawal takes the run while holding the conversation. A sweep that already
          // owns the run deadlocks here (40P01); conversation -> run lets both commit.
          await stores.followUps.cancel({ ...scope, followUpId: item.id });
        });
        const [outcome] = await required(pending);
        expect(outcome, inspect(outcome, { depth: 5 })).toMatchObject({ status: "fulfilled" });
        if (action === "expiry sweep") {
          expect(outcome).toMatchObject({ value: [{ id: required(call).id, status: "expired" }] });
          await f.until(said.runId, "completed");
          expect(f.executed).toEqual([]);
        } else {
          expect(await f.run(said.runId)).toMatchObject({ status: "failed", error });
          expect(
            (await f.events(said.runId)).filter((event) => event.type === "run_failed")
          ).toHaveLength(1);
        }
        expect(await f.app.stores.followUps.get({ ...scope, followUpId: item.id })).toMatchObject({
          status: "cancelled"
        });
        const events = await f.events(said.runId);
        expect(events.length).toBeGreaterThan(before.length);
        expect(events.map((event) => event.sequence)).toEqual(events.map((_, i) => i + 1));
      } finally {
        if (pending) await pending;
        await f.app.close();
      }
    }
  );

  it.each(["Stop first", "Approve first"])(
    "%s withdraws the unexecuted approval atomically and expiry cannot revive it",
    async (order) => {
      const f = await fixture();
      try {
        const said = await f.say();
        const requestId = required(said.call.approvalRequestId);
        await f.restart(false);
        if (order === "Approve first") {
          expect((await f.decide(requestId, "approve")).statusCode).toBe(200);
          expect((await f.run(said.runId)).status).toBe("queued");
        }
        const stop = () =>
          f.app.stores.agentRuns.requestAgentRunCancellation({
            clientInstanceId: f.clientInstanceId,
            runId: asAgentRunId(said.runId),
            requestedAt: new Date().toISOString()
          });
        await stop();
        await stop(); // Repeated Stop must not add a second withdrawal event.
        const request = await f.app.stores.approvals.getApprovalRequest({
          clientInstanceId: f.clientInstanceId,
          requestId
        });
        expect(request).toMatchObject({
          status: "withdrawn",
          applyResult: { execution: "refused", error: { message: "run stopped" } },
          payload: { inputRemoved: true }
        });
        expect(request?.payload).not.toHaveProperty("input");
        expect(request?.payload).not.toHaveProperty("heldInput");
        expect(request?.payload.actor).not.toHaveProperty("authSource");
        expect(await f.calls(said.runId)).toMatchObject([
          { id: said.call.id, status: "denied", error: { reason: "cancelled" } }
        ]);
        expect((await f.run(said.runId)).status).toBe("cancelled");
        for (const as of ["approver", "approver-2"]) {
          const list = await f.app.call("approval_requests.list", {
            query: { status: "pending" },
            headers: { "x-dev-user-id": as }
          });
          expect(list.statusCode, list.body).toBe(200);
          expect(
            list.json<{ items: { id: string }[] }>().items.map((item) => item.id)
          ).not.toContain(requestId);
        }
        const audit = (
          await f.app.stores.audit.listAuditEvents({
            clientInstanceId: f.clientInstanceId,
            type: "approval_request.withdrawn"
          })
        ).filter((event) => event.metadata?.requestId === requestId);
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({
          reason: "run stopped",
          metadata: {
            requestId,
            kind: "operation_call",
            status: "withdrawn"
          }
        });
        expect(audit[0]?.metadata).toEqual({
          requestId,
          kind: "operation_call",
          status: "withdrawn"
        });
        for (const decision of ["approve", "reject"] as const) {
          const refused = await f.decide(requestId, decision);
          expect(refused.statusCode, refused.body).toBe(409);
          expect(refused.body).toContain("withdrawn");
        }
        await withTestSql(async (sql) => {
          await sql`update operation_runs set expires_at = now() - interval '1 second' where id = ${said.call.id}`;
          await sql`update platform_jobs set run_after = now() where kind = 'operation_runs.expire' and client_instance_id = ${f.clientInstanceId} and status = 'queued'`;
        });
        const before = await f.events(said.runId);
        await getTestJobs(f.app).runDue();
        expect(await f.events(said.runId)).toEqual(before);
        expect(
          await f.app.stores.approvals.getApprovalRequest({
            clientInstanceId: f.clientInstanceId,
            requestId
          })
        ).toEqual(request);
        expect(f.executed).toEqual([]);
      } finally {
        await f.app.close();
      }
    }
  );

  it("Stop and Approve serialize behind the conversation without a request/run deadlock", async () => {
    const f = await fixture();
    let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const said = await f.say();
      const requestId = required(said.call.approvalRequestId);
      await f.restart(false);
      await f.app.stores.transaction(async (stores) => {
        // Cancellation holds the conversation and run until the outer transaction commits.
        await stores.agentRuns.requestAgentRunCancellation({
          clientInstanceId: f.clientInstanceId,
          runId: asAgentRunId(said.runId),
          requestedAt: new Date().toISOString()
        });
        pending = Promise.allSettled([f.decide(requestId, "approve")]);
        await waitUntil(
          async () =>
            (
              await withTestSql(
                (sql) => sql`
          select pid from pg_stat_activity where datname = current_database()
            and wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0
            and query ilike '%conversations%'
        `
              )
            ).length > 0,
          "the approval waits for Stop's conversation, not its request"
        );
        // It must not wait holding another connection for the same decision.
        const competing = await f.decide(requestId, "approve");
        expect(competing.statusCode, competing.body).toBe(409);
        expect(competing.body).toContain("being decided right now");
      });
      expect(await required(pending)).toMatchObject([
        { status: "fulfilled", value: { statusCode: 409 } }
      ]);
      expect(
        await f.app.stores.approvals.getApprovalRequest({
          clientInstanceId: f.clientInstanceId,
          requestId
        })
      ).toMatchObject({ status: "withdrawn" });
      expect(f.executed).toEqual([]);
    } finally {
      if (pending) await pending;
      await f.app.close();
    }
  });

  it("rolls back Stop, withdrawal, conversation note and governance event together", async () => {
    const f = await fixture();
    try {
      const said = await f.say();
      const requestId = required(said.call.approvalRequestId);
      const messages = await f.messages(said.conversationId);
      await expect(
        f.app.stores.transaction(async (stores) => {
          await stores.agentRuns.requestAgentRunCancellation({
            clientInstanceId: f.clientInstanceId,
            runId: asAgentRunId(said.runId),
            requestedAt: new Date().toISOString()
          });
          expect(
            await stores.approvals.getApprovalRequest({
              clientInstanceId: f.clientInstanceId,
              requestId
            })
          ).toMatchObject({ status: "withdrawn" });
          throw new Error("rollback Stop");
        })
      ).rejects.toThrow("rollback Stop");
      expect((await f.run(said.runId)).status).toBe("waiting_for_decision");
      expect(await f.calls(said.runId)).toMatchObject([{ status: "pending_approval" }]);
      expect(
        await f.app.stores.approvals.getApprovalRequest({
          clientInstanceId: f.clientInstanceId,
          requestId
        })
      ).toMatchObject({ status: "pending" });
      expect(await f.messages(said.conversationId)).toEqual(messages);
      expect(
        (
          await f.app.stores.audit.listAuditEvents({
            clientInstanceId: f.clientInstanceId,
            type: "approval_request.withdrawn"
          })
        ).filter((event) => event.metadata?.requestId === requestId)
      ).toEqual([]);
    } finally {
      await f.app.close();
    }
  });

  it("Stop withdraws an approved call after the worker claims the run but before execution", async () => {
    const f = await fixture();
    const release = deferred<void>();
    const entering = deferred<void>();
    const resume = f.app.stores.operationRuns.resume.bind(f.app.stores.operationRuns);
    f.app.stores.operationRuns.resume = async (input) => {
      entering.resolve();
      await release.promise;
      return resume(input);
    };
    try {
      const said = await f.say();
      const requestId = required(said.call.approvalRequestId);
      expect((await f.decide(requestId, "approve")).statusCode).toBe(200);
      await entering.promise;
      expect((await f.run(said.runId)).status).toBe("running");
      await f.app.stores.agentRuns.requestAgentRunCancellation({
        clientInstanceId: f.clientInstanceId,
        runId: asAgentRunId(said.runId),
        requestedAt: new Date().toISOString()
      });
      expect(
        await f.app.stores.approvals.getApprovalRequest({
          clientInstanceId: f.clientInstanceId,
          requestId
        })
      ).toMatchObject({ status: "withdrawn", applyResult: { error: { message: "run stopped" } } });
      release.resolve();
      await f.until(said.runId, "cancelled");
      expect(await f.calls(said.runId)).toMatchObject([
        { status: "denied", error: { reason: "cancelled" } }
      ]);
      expect(f.executed).toEqual([]);
    } finally {
      release.resolve();
      await f.app.close();
    }
  });

  it("Stop preserves the approval of an executed call while withdrawing the next wait", async () => {
    const f = await fixture();
    try {
      const said = await f.say(
        ['/tool demo.change {"text":"one"}', '/tool demo.change {"text":"two"}'].join("\n")
      );
      const requestId = required(said.call.approvalRequestId);
      expect((await f.decide(requestId, "approve")).statusCode).toBe(200);
      await waitUntil(async () => (await f.calls(said.runId)).length === 2, "the next call waits");
      await f.until(said.runId, "waiting_for_decision");
      const approved = await f.app.stores.approvals.getApprovalRequest({
        clientInstanceId: f.clientInstanceId,
        requestId
      });
      expect(approved).toMatchObject({ status: "approved", applyResult: { execution: "done" } });
      await f.app.stores.agentRuns.requestAgentRunCancellation({
        clientInstanceId: f.clientInstanceId,
        runId: asAgentRunId(said.runId),
        requestedAt: new Date().toISOString()
      });
      expect(
        await f.app.stores.approvals.getApprovalRequest({
          clientInstanceId: f.clientInstanceId,
          requestId
        })
      ).toEqual(approved);
      const second = required((await f.calls(said.runId)).find((call) => call.id !== said.call.id));
      expect(
        await f.app.stores.approvals.getApprovalRequest({
          clientInstanceId: f.clientInstanceId,
          requestId: required(second.approvalRequestId)
        })
      ).toMatchObject({ status: "withdrawn" });
      expect(f.executed).toEqual(["one"]);
    } finally {
      await f.app.close();
    }
  });

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
      expect(tool?.text).not.toContain("not_allowed");
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
