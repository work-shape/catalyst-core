import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  type AgentRunStatus,
  type CentralPolicySetting,
  type OperationRun
} from "@work-shape/catalyst-core";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { required, waitUntil } from "./support/assertions";
import { injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import { createToolCallingModel, TOOL_CALLING_MODEL_PROVIDER } from "./support/held-model";
import { withTestSql } from "./support/test-sql";
import { createTestInstance, getTestConfig, getTestJobs } from "./support/test-instance";

// OP-4b: an agent's call at `confirm` in a run nobody watches, as a scheduled start's will be
// (EW-8), waits in its person's Inbox and nowhere else. The run pauses on it as it does in the
// conversation; the Inbox item is the only place to decide it (operations checks 34 to 37).

const executed: string[] = [];
const change = defineTool({
  name: "demo.change",
  effect: "changing",
  permission: { mode: "allow" },
  description: "Changes something.",
  inputSchema: z.object({ text: z.string() }),
  execute(input) {
    executed.push(input.text);
    return toolSuccess({ changed: input.text });
  }
});
const model = createToolCallingModel();
const confirmChange: CentralPolicySetting = { operation: change.name, value: "confirm" };

/** Both are admins: only the run's person decides its confirmation. */
function person(id: string) {
  return {
    id,
    externalUserId: id,
    displayLabel: id,
    roles: ["user", "admin", "superadmin"],
    permissionRefs: ["demo-tools"]
  };
}

const requestSchema = z.looseObject({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  addresseeUserId: z.string().optional(),
  canDecide: z.boolean(),
  payload: z.looseObject({}),
  applyResult: z.looseObject({}).optional()
});

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function fixture() {
  executed.length = 0;
  const config = createTestConfig({
    tools: [{ name: change.name, enabled: true }],
    toolNames: [change.name],
    developmentAuth: {
      enabled: true,
      users: [person("user-1"), person("stranger")],
      defaultUserId: "user-1"
    }
  });
  config.infrastructure.models = {
    local: { provider: TOOL_CALLING_MODEL_PROVIDER, model: "local" }
  };
  const app = await createTestInstance({
    config,
    env: {},
    capabilities: [model.capability],
    tools: [change],
    operations: { centralPolicySettings: () => [confirmChange] },
    unattendedRuns: () => true
  });
  close = () => app.close();
  const clientInstanceId = asClientInstanceId(getTestConfig(app).clientInstance.id);
  const agentRun = async (runId: string) =>
    required(
      await app.stores.agentRuns.getAgentRun({ clientInstanceId, runId: asAgentRunId(runId) })
    );
  const callsOf = async (runId: string) =>
    (await app.stores.operationRuns.list({ clientInstanceId })).filter(
      (run) => run.origin.kind === "agent" && run.origin.agentRunId === runId
    );
  const as = (userId: string) => ({ "x-dev-user-id": userId });
  return {
    app,
    clientInstanceId,
    agentRun,
    callsOf,
    until: (runId: string, status: AgentRunStatus) =>
      waitUntil(async () => (await agentRun(runId)).status === status, `the run is ${status}`),
    /** A run that asked for `text` and waits on its person's Inbox item. */
    async waiting(text: string) {
      const created = await app.call("conversations.create", { payload: { title: "Inbox" } });
      const conversationId = created.json<{ id: string }>().id;
      const started = await injectStartConversationRun(
        app,
        conversationId,
        `/tool demo.change ${JSON.stringify({ text })}`
      );
      const runId = started.run.id;
      let call: OperationRun | undefined;
      await waitUntil(async () => {
        if ((await agentRun(runId)).status !== "waiting_for_decision") return false;
        call = (await callsOf(runId)).find((run) => run.status === "pending_confirmation");
        return call !== undefined;
      }, "the run waits on its Inbox item");
      const waitingCall = required(call);
      return {
        conversationId,
        runId,
        call: waitingCall,
        requestId: required(waitingCall.approvalRequestId)
      };
    },
    get: (requestId: string, userId = "user-1") =>
      app.call("approval_requests.get", { params: { requestId }, headers: as(userId) }),
    decide: (requestId: string, decision: "approve" | "reject", userId = "user-1") =>
      app.call("approval_requests.decide", {
        params: { requestId },
        headers: as(userId),
        payload: { decision }
      }),
    list: async (userId: string) =>
      z
        .object({ items: z.array(z.object({ id: z.string() })) })
        .parse((await app.call("approval_requests.list", { headers: as(userId) })).json())
        .items.map((item) => item.id),
    events: async (runId: string) =>
      (
        await app.stores.agentRuns.listRunObservations({
          clientInstanceId,
          runId: asAgentRunId(runId)
        })
      ).map((observation) => observation.payload),
    messages: (conversationId: string) =>
      app.stores.conversations.listMessages({
        clientInstanceId,
        conversationId: asConversationId(conversationId)
      })
  };
}

describe("an unattended Agent Run's confirmation waits in its person's Inbox (OP-4b)", () => {
  it("files the item for the run's person alone, and runs the frozen call once on Allow", async () => {
    const f = await fixture();
    const said = await f.waiting("one");
    expect(said.call).toMatchObject({ status: "pending_confirmation", decision: undefined });
    expect(executed).toEqual([]);

    const read = await f.get(said.requestId);
    expect(read.statusCode, read.body).toBe(200);
    expect(requestSchema.parse(read.json())).toMatchObject({
      kind: "operation_call",
      status: "pending",
      addresseeUserId: (await f.agentRun(said.runId)).ownerUserId,
      canDecide: true,
      payload: { mode: "confirmation", operation: change.name }
    });
    // Another admin neither sees nor decides it (check 35).
    expect((await f.get(said.requestId, "stranger")).statusCode).toBe(404);
    expect((await f.decide(said.requestId, "approve", "stranger")).statusCode).toBe(404);
    expect(await f.list("stranger")).not.toContain(said.requestId);
    expect(await f.list("user-1")).toContain(said.requestId);

    // Check 37: the conversation reads the waiting call, which names its Inbox item, and its
    // own decision is refused with the item named.
    const waitingRun = await f.app.call("operations.get_run", { params: { runId: said.call.id } });
    expect(waitingRun.statusCode, waitingRun.body).toBe(200);
    expect(waitingRun.json()).toMatchObject({
      status: "pending_confirmation",
      approvalRequestId: said.requestId
    });
    const inChat = await f.app.call("operations.decide", {
      params: { runId: said.call.id },
      payload: { decision: "confirm" }
    });
    expect(inChat.statusCode, inChat.body).toBe(409);
    expect(inChat.json()).toMatchObject({
      error: { code: "CONFLICT", details: { approvalRequestId: said.requestId } }
    });
    expect(executed).toEqual([]);

    const allowed = await f.decide(said.requestId, "approve");
    expect(allowed.statusCode, allowed.body).toBe(200);
    await f.until(said.runId, "completed");
    expect(executed).toEqual(["one"]);
    expect(await f.callsOf(said.runId)).toMatchObject([
      {
        id: said.call.id,
        status: "done",
        decision: { mode: "confirmed", by: (await f.agentRun(said.runId)).ownerUserId }
      }
    ]);
    // Decided once: a second answer changes nothing.
    expect((await f.decide(said.requestId, "approve")).statusCode).toBe(409);
    await getTestJobs(f.app).runDue();
    expect(executed).toEqual(["one"]);
    expect(
      (await f.events(said.runId)).filter((event) => event.type === "tool_decision_recorded")
    ).toMatchObject([{ operationRunId: said.call.id, outcome: "confirmed" }]);
  });

  it("refuses the call on Deny and goes on in the same run", async () => {
    const f = await fixture();
    const said = await f.waiting("denied");
    expect((await f.decide(said.requestId, "reject")).statusCode).toBe(200);
    await f.until(said.runId, "completed");
    expect(executed).toEqual([]);
    expect(await f.callsOf(said.runId)).toMatchObject([{ id: said.call.id, status: "denied" }]);
    expect(
      (await f.events(said.runId)).filter((event) => event.type === "tool_decision_recorded")
    ).toMatchObject([{ operationRunId: said.call.id, outcome: "declined" }]);
  });

  it("check 34: expires after its deadline, and the run resumes with an expired result", async () => {
    const f = await fixture();
    const said = await f.waiting("expired");
    await withTestSql(async (sql) => {
      await sql`update operation_runs set expires_at = now() - interval '1 second' where id = ${said.call.id}`;
      await sql`update platform_jobs set run_after = now() where kind = 'operation_runs.expire' and client_instance_id = ${f.clientInstanceId} and status = 'queued'`;
    });
    await getTestJobs(f.app).runDue();
    await f.until(said.runId, "completed");
    expect(executed).toEqual([]);
    expect(await f.callsOf(said.runId)).toMatchObject([{ id: said.call.id, status: "expired" }]);
    expect(requestSchema.parse((await f.get(said.requestId)).json())).toMatchObject({
      status: "superseded",
      canDecide: false,
      applyResult: { execution: "expired" }
    });
    const messages = await f.messages(said.conversationId);
    expect(messages.find((message) => message.role === "tool")?.text).toContain("expired");
  });

  it("check 36: Stop cancels the run, denies the call as cancelled and withdraws the item", async () => {
    const f = await fixture();
    const said = await f.waiting("stopped");
    const stopped = await f.app.call("conversations.runs.cancel", {
      params: { conversationId: said.conversationId, runId: said.runId },
      payload: { reason: "Stop" }
    });
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(await f.agentRun(said.runId)).toMatchObject({ status: "cancelled" });
    expect(await f.callsOf(said.runId)).toMatchObject([
      { id: said.call.id, status: "denied", error: { reason: "cancelled" } }
    ]);
    const item = requestSchema.parse((await f.get(said.requestId)).json());
    expect(item).toMatchObject({ status: "withdrawn", canDecide: false });
    // The withdrawn item keeps what it was: a confirmation, addressed to the person.
    expect(item).toMatchObject({
      addresseeUserId: (await f.agentRun(said.runId)).ownerUserId,
      payload: { mode: "confirmation" }
    });
    expect((await f.decide(said.requestId, "approve")).statusCode).toBe(409);
    await getTestJobs(f.app).runDue();
    expect(executed).toEqual([]);
  });
});
