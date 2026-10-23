import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asAgentRunId,
  asClientInstanceId,
  type AgentRunStatus,
  type CentralPolicySetting,
  type OperationRun
} from "@work-shape/catalyst-core";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { required, waitUntil } from "./support/assertions";
import { injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import { createToolCallingModel, TOOL_CALLING_MODEL_PROVIDER } from "./support/held-model";
import { createTestInstance, getTestConfig, type TestInstance } from "./support/test-instance";

// OP-6: a person's own confirmation settings. "Always allow" set from a confirmation lets
// that person's next call of the operation run; it is offered only where it has an effect,
// a lock or a floor wins over it, "Never" refuses before anything runs, and the setting is
// the person's alone.

const executed: string[] = [];
const tool = (
  name: string,
  extra: Partial<Pick<Parameters<typeof defineTool>[0], "changeClass" | "policyFloor">>
) =>
  defineTool({
    name,
    effect: "changing",
    permission: { mode: "allow" },
    description: `Changes ${name}.`,
    inputSchema: z.object({ text: z.string() }),
    ...extra,
    execute(input) {
      // Stands for everything the call does once admitted, its credential included.
      executed.push(`${name}:${input.text}`);
      return toolSuccess({ changed: input.text });
    }
  });
const insert = tool("demo.insert", { changeClass: "reversible" });
const remove = tool("demo.remove", {});
const locked = tool("demo.locked", { changeClass: "reversible" });
const floored = tool("demo.floored", { changeClass: "reversible", policyFloor: () => "confirm" });
const tools = [insert, remove, locked, floored];
const model = createToolCallingModel();
const confirmAll: CentralPolicySetting[] = tools.map((entry) => ({
  operation: entry.name,
  value: "confirm"
}));

function person(id: string) {
  return {
    id,
    externalUserId: id,
    displayLabel: id,
    roles: ["user", "admin", "superadmin"],
    permissionRefs: ["demo-tools"]
  };
}

const settingsSchema = z.object({
  items: z.array(
    z.looseObject({
      operation: z.string(),
      value: z.string().optional(),
      mayAlwaysAllow: z.boolean()
    })
  )
});

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function fixture(options: { unattended?: boolean } = {}) {
  executed.length = 0;
  const config = createTestConfig({
    tools: tools.map((entry) => ({ name: entry.name, enabled: true })),
    toolNames: tools.map((entry) => entry.name),
    developmentAuth: {
      enabled: true,
      users: [person("user-1"), person("user-2")],
      defaultUserId: "user-1"
    }
  });
  config.infrastructure.models = {
    local: { provider: TOOL_CALLING_MODEL_PROVIDER, model: "local" }
  };
  config.policy.alwaysAllow = { locked: ["demo.locked"] };
  const app: TestInstance = await createTestInstance({
    config,
    env: {},
    capabilities: [model.capability],
    tools,
    operations: { centralPolicySettings: () => confirmAll },
    ...(options.unattended ? { unattendedRuns: () => true } : {})
  });
  close = () => app.close();
  const clientInstanceId = asClientInstanceId(getTestConfig(app).clientInstance.id);
  const as = (userId: string) => ({ "x-dev-user-id": userId });
  const agentRun = async (runId: string) =>
    required(
      await app.stores.agentRuns.getAgentRun({ clientInstanceId, runId: asAgentRunId(runId) })
    );
  const callsOf = async (runId: string) =>
    (await app.stores.operationRuns.list({ clientInstanceId })).filter(
      (run) => run.origin.kind === "agent" && run.origin.agentRunId === runId
    );
  const settled = (runId: string) =>
    waitUntil(async () => {
      const status: AgentRunStatus = (await agentRun(runId)).status;
      return status === "completed" || status === "waiting_for_decision" || status === "failed";
    }, "the run completes or waits");
  return {
    app,
    clientInstanceId,
    callsOf,
    agentRun,
    /** The person's agent calls `name` once; the run completes or waits on the call. */
    async call(name: string, text: string, userId = "user-1") {
      const created = await app.call("conversations.create", {
        payload: { title: "Always allow" },
        headers: as(userId)
      });
      const conversationId = created.json<{ id: string }>().id;
      const started = await injectStartConversationRun(
        app,
        conversationId,
        `/tool ${name} ${JSON.stringify({ text })}`,
        { headers: as(userId) }
      );
      await settled(started.run.id);
      const calls = await callsOf(started.run.id);
      const waiting: OperationRun | undefined = calls.find(
        (run) => run.status === "pending_confirmation" && !run.decision
      );
      const requested = (
        await app.stores.agentRuns.listRunObservations({
          clientInstanceId,
          runId: asAgentRunId(started.run.id)
        })
      )
        .map((observation) => observation.payload)
        .filter((event) => event.type === "tool_decision_requested")
        .at(-1);
      return { runId: started.run.id, calls, waiting, requested };
    },
    decide: (runId: string, payload: Record<string, unknown>, userId = "user-1") =>
      app.call("operations.decide", { params: { runId }, payload, headers: as(userId) }),
    settings: async (userId = "user-1") => {
      const listed = await app.call("me.operation_settings.list", { headers: as(userId) });
      expect(listed.statusCode, listed.body).toBe(200);
      return settingsSchema.parse(listed.json()).items;
    },
    set: (operation: string, value: string | null, userId = "user-1") =>
      app.call("me.operation_settings.set", {
        payload: { operation, value },
        headers: as(userId)
      }),
    /** What the store holds for the person signed in as `as`. */
    stored: async (as_ = "user-1") => {
      const me = await app.call("me.get", { headers: as(as_) });
      const userId = z.object({ id: z.string() }).parse(me.json()).id;
      return app.stores.userOperationSettings.list({ clientInstanceId, userId });
    },
    userId: async (as_ = "user-1") =>
      z.object({ id: z.string() }).parse((await app.call("me.get", { headers: as(as_) })).json())
        .id,
    auditOf: async () =>
      (await app.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 })).filter(
        (event) => event.type === "user.operation_setting_changed"
      ),
    until: (runId: string, status: AgentRunStatus) =>
      waitUntil(async () => (await agentRun(runId)).status === status, `the run is ${status}`)
  };
}

describe("Always allow from a confirmation card (OP-6)", () => {
  it("lets the person's next call run without asking, and only theirs", async () => {
    const f = await fixture();
    const first = await f.call("demo.insert", "one");
    const waiting = required(first.waiting);
    expect(waiting.offersAlwaysAllow).toBe(true);
    expect(first.requested).toMatchObject({ operationId: "demo.insert", alwaysAllow: true });

    const decided = await f.decide(waiting.id, { decision: "confirm", alwaysAllow: true });
    expect(decided.statusCode, decided.body).toBe(200);
    await f.until(first.runId, "completed");
    expect(executed).toEqual(["demo.insert:one"]);
    expect(await f.stored()).toMatchObject([{ operation: "demo.insert", value: "always_allow" }]);

    // The audit names who, which operation and which value; never the call's input.
    const audit = await f.auditOf();
    expect(audit).toHaveLength(1);
    // The decision's own run id is the only other field the recorder adds.
    expect(audit[0]?.metadata).toEqual({
      operation: "demo.insert",
      value: "always_allow",
      operationRunId: expect.any(String)
    });
    expect(JSON.stringify(audit[0])).not.toContain("one");

    const next = await f.call("demo.insert", "two");
    expect(next.waiting).toBeUndefined();
    expect(next.calls).toMatchObject([{ status: "done" }]);
    expect(executed).toEqual(["demo.insert:one", "demo.insert:two"]);

    // Another person's call of the same operation still asks them.
    const theirs = await f.call("demo.insert", "three", "user-2");
    expect(theirs.waiting).toBeDefined();
    expect(executed).not.toContain("demo.insert:three");
  });

  it("is not offered and is refused where it would have no effect", async () => {
    const f = await fixture();
    for (const name of ["demo.remove", "demo.locked", "demo.floored"]) {
      const said = await f.call(name, "x");
      const waiting = required(said.waiting, `${name} waits`);
      expect(waiting.offersAlwaysAllow, name).toBeUndefined();
      expect(said.requested, name).not.toHaveProperty("alwaysAllow");
      const refused = await f.decide(waiting.id, { decision: "confirm", alwaysAllow: true });
      expect(refused.statusCode, `${name}: ${refused.body}`).toBe(403);
      // A refused Always allow decides nothing: the call still waits.
      expect((await f.callsOf(said.runId))[0]).toMatchObject({
        status: "pending_confirmation",
        decision: undefined
      });
    }
    // Irreversible and locked operations refuse it in Settings too; nothing is stored.
    expect((await f.set("demo.remove", "always_allow")).statusCode).toBe(403);
    expect((await f.set("demo.locked", "always_allow")).statusCode).toBe(403);
    expect(await f.stored()).toEqual([]);
    expect((await f.settings()).filter((item) => item.operation.startsWith("demo."))).toMatchObject(
      [
        { operation: "demo.floored", mayAlwaysAllow: true },
        { operation: "demo.locked", mayAlwaysAllow: false },
        { operation: "demo.remove", mayAlwaysAllow: false }
      ]
    );
  });

  it("ignores a stored Always allow on a locked operation, and loses to a floor", async () => {
    const f = await fixture();
    // An Always allow from before the admin locked the operation.
    await f.app.stores.userOperationSettings.set({
      clientInstanceId: f.clientInstanceId,
      userId: await f.userId(),
      operation: "demo.locked",
      value: "always_allow",
      at: new Date().toISOString()
    });
    expect((await f.call("demo.locked", "a")).waiting).toBeDefined();
    // The floor keeps asking whatever the person set.
    expect((await f.set("demo.floored", "always_allow")).statusCode).toBe(200);
    expect((await f.call("demo.floored", "b")).waiting).toBeDefined();
    expect(executed).toEqual([]);
  });
});

describe("Never and Ask me (OP-6)", () => {
  it("refuses a call the person never allows before anything of it runs", async () => {
    const f = await fixture();
    const set = await f.set("demo.insert", "never");
    expect(set.statusCode, set.body).toBe(200);
    const said = await f.call("demo.insert", "no");
    expect(said.waiting).toBeUndefined();
    expect(executed).toEqual([]);
    // The agent is not offered the tool at all.
    const offered = required(model.requests.at(-1)).tools.map((entry) => entry.name);
    expect(offered).not.toContain("demo.insert");
    expect(offered).toContain("demo.remove");

    // Another person is not affected.
    const theirs = await f.call("demo.insert", "yes", "user-2");
    expect(theirs.waiting).toBeDefined();
  });

  it("keeps settings the person's own: nobody else reads or changes them", async () => {
    const f = await fixture();
    expect((await f.set("demo.insert", "ask")).statusCode).toBe(200);
    expect((await f.set("demo.insert", "never", "user-2")).statusCode).toBe(200);
    expect(await f.stored()).toMatchObject([{ operation: "demo.insert", value: "ask" }]);
    expect(await f.stored("user-2")).toMatchObject([{ operation: "demo.insert", value: "never" }]);
    expect(
      (await f.settings("user-2")).find((item) => item.operation === "demo.insert")
    ).toMatchObject({ value: "never" });
    // Back to the default: the row goes, and the change is audited without a payload.
    expect((await f.set("demo.insert", null)).statusCode).toBe(200);
    expect(await f.stored()).toEqual([]);
    expect((await f.auditOf()).map((event) => event.metadata)).toEqual(
      expect.arrayContaining(
        ["ask", "never", "default"].map((value) =>
          expect.objectContaining({ operation: "demo.insert", value })
        )
      )
    );
    // A setting that does not change records nothing.
    const before = (await f.auditOf()).length;
    expect((await f.set("demo.insert", null)).statusCode).toBe(200);
    expect((await f.auditOf()).length).toBe(before);
  });
});

describe("Always allow from the Inbox (OP-6)", () => {
  it("sets it with allowing the person's own confirmation, which also covers unattended runs", async () => {
    const f = await fixture({ unattended: true });
    const first = await f.call("demo.insert", "one");
    const waiting = required(first.waiting);
    const requestId = required(waiting.approvalRequestId);
    expect(waiting.offersAlwaysAllow).toBe(true);
    const read = await f.app.call("approval_requests.get", { params: { requestId } });
    expect(read.json()).toMatchObject({ preview: { alwaysAllow: true } });

    // Another person cannot set it through this person's item.
    const stranger = await f.app.call("approval_requests.decide", {
      params: { requestId },
      headers: { "x-dev-user-id": "user-2" },
      payload: { decision: "approve", alwaysAllow: true }
    });
    expect(stranger.statusCode).toBe(403);
    expect(await f.stored("user-2")).toEqual([]);

    const allowed = await f.app.call("approval_requests.decide", {
      params: { requestId },
      payload: { decision: "approve", alwaysAllow: true }
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
    await f.until(first.runId, "completed");
    expect(await f.stored()).toMatchObject([{ operation: "demo.insert", value: "always_allow" }]);

    const next = await f.call("demo.insert", "two");
    expect(next.waiting).toBeUndefined();
    expect(executed).toEqual(["demo.insert:one", "demo.insert:two"]);
  });
});
