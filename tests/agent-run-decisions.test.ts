import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DECISION_EXPIRED_REASON,
  createFileSetId,
  createPlatformId,
  asAgentRunId,
  asCollaborationWorkspaceId,
  asClientInstanceId,
  asConversationId,
  type AgentRunStatus,
  type CentralPolicySetting,
  type AppAudience,
  type OperationRun
} from "@work-shape/catalyst-core";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { required, waitUntil } from "./support/assertions";
import { injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import { createToolCallingModel, TOOL_CALLING_MODEL_PROVIDER } from "./support/held-model";
import { fileTestDatabaseUrl } from "./support/test-database";
import {
  createTestInstance,
  getTestConfig,
  getTestJobs,
  type TestInstance
} from "./support/test-instance";

// An agent's call that waits for its own person's confirmation (EW-2a): the run pauses on it
// and holds nothing, the person decides through `operations.decide`, and the run goes on in a
// worker, the same reply, with the call executed once or answered as declined.

const executed: string[] = [];
const change = defineTool({
  name: "demo.change",
  effect: "changing",
  permission: { mode: "allow" },
  description: "Changes something.",
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ changed: z.string() }),
  execute(input) {
    executed.push(input.text);
    return toolSuccess({ changed: input.text });
  }
});
const model = createToolCallingModel();
const confirmChange: CentralPolicySetting = { operation: change.name, value: "confirm" };

/** A person of the instance; both are admins, and only the run's owner decides its calls. */
function person(id: string) {
  return {
    id,
    externalUserId: id,
    displayLabel: id,
    roles: ["user", "admin", "superadmin"],
    permissionRefs: ["demo-tools"]
  };
}

async function startInstance(
  restarted: boolean,
  startAgentRunJobs = true,
  appPublish = false
): Promise<TestInstance> {
  const config = createTestConfig({
    tools: [{ name: change.name, enabled: true }],
    toolNames: appPublish ? [change.name, "assets.publish"] : [change.name],
    developmentAuth: {
      enabled: true,
      users: [person("user-1"), person("stranger")],
      defaultUserId: "user-1"
    }
  });
  let filesRoot: string | undefined;
  if (appPublish) {
    config.modules.apps = { enabled: true };
    config.modules.assetManagement = { enabled: true };
    config.guardrails["share-publish-review"] = {
      on: "app.before_publish",
      outcome: "require_approval",
      check: { kind: "pattern", fields: ["name"], pattern: ".+", reason: "Publish review" }
    };
    config.executionWorkspaces.enabled = true;

    config.administration.agentConfiguration.enabled = true;
    filesRoot = await mkdtemp(join(tmpdir(), "share-1-agent-"));
    config.infrastructure.objectStorage.files = { provider: "filesystem", root: filesRoot };
    config.infrastructure.objectStorage.workspaces = {
      provider: "filesystem",
      root: join(filesRoot, "workspaces")
    };
  }
  config.infrastructure.models = {
    local: { provider: TOOL_CALLING_MODEL_PROVIDER, model: "local" }
  };
  const instance = await createTestInstance({
    config,
    startAgentRunJobs,
    env: appPublish ? { CHAT_SESSION_TOKEN_SECRET: randomBytes(32).toString("hex") } : {},
    capabilities: [model.capability],
    tools: [change],
    // An admin set the call to its person's confirmation.
    operations: { centralPolicySettings: () => [confirmChange] },
    ...(restarted ? { seedAssets: false } : {})
  });
  const close = instance.close.bind(instance);
  instance.close = async () => {
    await close();
    if (filesRoot) await rm(filesRoot, { recursive: true, force: true });
  };
  return instance;
}

async function fixture(appPublish = false) {
  executed.length = 0;
  let app = await startInstance(false, true, appPublish);
  const clientInstanceId = asClientInstanceId(getTestConfig(app).clientInstance.id);
  const agentRun = async (runId: string) =>
    required(
      await app.stores.agentRuns.getAgentRun({ clientInstanceId, runId: asAgentRunId(runId) })
    );
  const until = (runId: string, status: AgentRunStatus) =>
    waitUntil(async () => (await agentRun(runId)).status === status, `the run is ${status}`);
  const callsOf = async (runId: string) =>
    (await app.stores.operationRuns.list({ clientInstanceId })).filter(
      (run) => run.origin.kind === "agent" && run.origin.agentRunId === runId
    );
  return {
    get app() {
      return app;
    },
    clientInstanceId,
    agentRun,
    until,
    callsOf,
    /** A new conversation with one message to the agent. */
    async say(text: string) {
      const created = await app.call("conversations.create", { payload: { title: "Decide" } });
      const conversationId = created.json<{ id: string }>().id;
      const started = await injectStartConversationRun(app, conversationId, text);
      return { conversationId, runId: started.run.id };
    },
    /** The call the run waits on, once it paused on one that nobody decided. */
    async waitingCall(runId: string): Promise<OperationRun> {
      let waiting: OperationRun | undefined;
      await waitUntil(async () => {
        if ((await agentRun(runId)).status !== "waiting_for_decision") return false;
        waiting = (await callsOf(runId)).find(
          (run) => run.status === "pending_confirmation" && !run.decision
        );
        return waiting !== undefined;
      }, "the run waits for a decision");
      return required(waiting);
    },
    decide(
      operationRunId: string,
      decision: "confirm" | "decline",
      options: { reason?: string; as?: string; audience?: AppAudience } = {}
    ) {
      return app.call("operations.decide", {
        params: { runId: operationRunId },
        payload: {
          decision,
          ...(options.reason ? { reason: options.reason } : {}),
          ...(options.audience ? { audience: options.audience } : {})
        },
        ...(options.as ? { headers: { "x-dev-user-id": options.as } } : {})
      });
    },
    async events(runId: string) {
      const observations = await app.stores.agentRuns.listRunObservations({
        clientInstanceId,
        runId: asAgentRunId(runId)
      });
      return observations.map((observation) => observation.payload);
    },
    /** The last call the run asked its person to decide on. */
    async requested(runId: string) {
      const observations = await app.stores.agentRuns.listRunObservations({
        clientInstanceId,
        runId: asAgentRunId(runId)
      });
      return observations
        .map((observation) => observation.payload)
        .filter((event) => event.type === "tool_decision_requested")
        .at(-1);
    },
    messages: (conversationId: string) =>
      app.stores.conversations.listMessages({
        clientInstanceId,
        conversationId: asConversationId(conversationId)
      }),
    /** Stops the instance and starts it again on what it left in the database. */
    async restart(startAgentRunJobs = true) {
      await app.close();
      app = await startInstance(true, startAgentRunJobs, appPublish);
    }
  };
}

/** What the model was given the last time it was asked for this conversation's reply. */
function lastModelInput(): string[] {
  const request = required(model.requests.at(-1));
  return request.messages
    .filter((message) => message.role !== "system")
    .map((message) =>
      message.role === "assistant" && message.toolCalls?.length
        ? `assistant:${message.toolCalls.map((call) => call.toolName).join(",")}`
        : message.role
    );
}

describe("an agent's call that waits for its person's decision", () => {
  it("check 80: an agent cannot widen an App before the person's click, and publishes the person's chosen audience", async () => {
    const f = await fixture(true);
    const createdWorkspace = await f.app.call("workspaces.create", {
      payload: { name: "Share agent", visibility: "private" }
    });
    expect(createdWorkspace.statusCode, createdWorkspace.body).toBe(200);
    const workspaceId = asCollaborationWorkspaceId(
      z.object({ id: z.string() }).parse(createdWorkspace.json()).id
    );
    const assetId = createPlatformId<"ConfigAssetId">("cfg");
    const fileSetId = createFileSetId();
    await f.app.stores.pages.createAssetFileSet({
      clientInstanceId: f.clientInstanceId,
      assetId,
      fileSet: {
        id: fileSetId,
        kitVersion: "1.0.0",
        manifest: { id: "agent-choice", entry: "index.html" },
        sourceFiles: [],
        builtFiles: [
          { path: "index.html", sha256: "a".repeat(64), bytes: 1, contentType: "text/html" }
        ],
        createdAt: new Date().toISOString()
      }
    });
    await applyAtCurrentRevisions(f.app.stores.configAssets, {
      clientInstanceId: f.clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "app",
          name: "agent-choice",
          assetId,
          fileSetId,
          draft: true,
          scope: { kind: "workspace", workspaceId },
          config: {
            name: "agent-choice",
            title: "Agent choice",
            manifest: {
              id: "agent-choice",
              name: "Agent choice",
              kit: "1.0.0",
              entry: "index.html"
            }
          }
        }
      ]
    });
    const stored = () =>
      f.app.stores.configAssets.getConfigAsset({
        clientInstanceId: f.clientInstanceId,
        kind: "app",
        name: "agent-choice"
      });
    const first = await f.app.call("assets.publish", {
      params: { kind: "app", name: "agent-choice" },
      payload: { revision: 1, audience: "self", workspaceId }
    });
    expect(first.statusCode, first.body).toBe(200);
    const before = await stored();
    const said = await f.say(
      `/tool assets.publish ${JSON.stringify({ kind: "app", name: "agent-choice", revision: 1, audience: "instance", workspaceId })}`
    );
    const waiting = await f.waitingCall(said.runId);
    expect((await stored())?.appAvailability).toEqual(before?.appAvailability);
    expect(await f.requested(said.runId)).toMatchObject({
      mode: "confirm",
      inputPreview: { audience: "instance" }
    });
    expect((await f.decide(waiting.id, "confirm", { audience: "workspace" })).statusCode).toBe(200);
    await f.until(said.runId, "completed");
    expect(await f.callsOf(said.runId)).toMatchObject([
      { status: "done", decision: { mode: "approved", edited: true } }
    ]);
    expect((await stored())?.appAvailability?.audience).toBe("workspace");
    await f.app.close();
  });

  it("pauses the run, survives a restart and executes the call once it is confirmed", async () => {
    const f = await fixture();
    const said = await f.say('/tool demo.change {"text":"one"}');
    const waiting = await f.waitingCall(said.runId);

    expect(waiting).toMatchObject({
      operation: "demo.change",
      status: "pending_confirmation",
      inputRef: `agent_run:${said.runId}`,
      origin: { kind: "agent", agentRunId: said.runId, toolName: "demo.change" }
    });
    expect(executed).toEqual([]);
    const paused = await f.events(said.runId);
    expect(paused.at(-1)).toMatchObject({
      type: "tool_decision_requested",
      operationRunId: waiting.id,
      operationId: "demo.change",
      mode: "confirm",
      inputPreview: { text: "one" },
      expiresAt: waiting.expiresAt
    });

    // The worker that paused it goes away; another one goes on.
    await f.restart();
    const confirmed = await f.decide(waiting.id, "confirm");
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json()).toMatchObject({
      run: { id: waiting.id, status: "pending_confirmation", decision: { mode: "confirmed" } },
      agentRun: { id: said.runId, status: "queued" }
    });
    await f.until(said.runId, "completed");

    expect(executed).toEqual(["one"]);
    expect(await f.callsOf(said.runId)).toMatchObject([
      { id: waiting.id, status: "done", decision: { mode: "confirmed" } }
    ]);
    // The same reply goes on: one run, its events one sequence, the decision among them.
    const events = await f.events(said.runId);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index + 1));
    const types = events.map((event) => event.type);
    expect(types.slice(paused.length - 1, paused.length + 1)).toEqual([
      "tool_decision_requested",
      "tool_decision_recorded"
    ]);
    expect(types.at(-1)).toBe("run_completed");
    expect(events.find((event) => event.type === "tool_decision_recorded")).toMatchObject({
      operationRunId: waiting.id,
      outcome: "confirmed"
    });
    const messages = await f.messages(said.conversationId);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant"
    ]);
    expect(messages.at(-1)?.text).toContain('"changed": "one"');
    // The model went on from the step it paused in: the message, its call and the result.
    expect(lastModelInput()).toEqual(["user", "assistant:demo.change", "tool"]);

    // The same decision again answers the same call; another one is refused.
    const again = await f.decide(waiting.id, "confirm");
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ run: { id: waiting.id, status: "done" } });
    expect((await f.decide(waiting.id, "decline")).statusCode).toBe(409);
    expect(executed).toEqual(["one"]);
    await f.app.close();
  });

  it("answers a declined call to the agent with the reason and executes nothing", async () => {
    const f = await fixture();
    const said = await f.say('/tool demo.change {"text":"one"}');
    const waiting = await f.waitingCall(said.runId);

    // Only the person the run works for decides.
    const stranger = await f.decide(waiting.id, "confirm", { as: "stranger" });
    expect(stranger.statusCode).toBe(403);
    expect(await f.agentRun(said.runId)).toMatchObject({ status: "waiting_for_decision" });

    const declined = await f.decide(waiting.id, "decline", { reason: "Not this one." });
    expect(declined.statusCode, declined.body).toBe(200);
    await f.until(said.runId, "completed");

    expect(executed).toEqual([]);
    expect(await f.callsOf(said.runId)).toMatchObject([
      {
        id: waiting.id,
        status: "denied",
        decision: { mode: "declined", comment: "Not this one." },
        denial: { kind: "declined" }
      }
    ]);
    expect(
      (await f.events(said.runId)).find((event) => event.type === "tool_decision_recorded")
    ).toMatchObject({ outcome: "declined", reason: "Not this one." });
    const tool = (await f.messages(said.conversationId)).find((message) => message.role === "tool");
    expect(tool?.text).toContain(
      "The user declined this call. Nothing ran. Their reason: Not this one."
    );
    // A different decision after it is refused.
    expect((await f.decide(waiting.id, "confirm")).statusCode).toBe(409);
    expect(executed).toEqual([]);
    await f.app.close();
  });

  it("asks for two calls of one step one after the other, in the order the model made them", async () => {
    const f = await fixture();
    const said = await f.say(
      ['/tool demo.change {"text":"one"}', '/tool demo.change {"text":"two"}'].join("\n")
    );
    const first = await f.waitingCall(said.runId);
    // The second call has not started: it is no Operation Run yet.
    expect(await f.callsOf(said.runId)).toHaveLength(1);
    expect(await f.requested(said.runId)).toMatchObject({
      operationRunId: first.id,
      inputPreview: { text: "one" }
    });

    expect((await f.decide(first.id, "confirm")).statusCode).toBe(200);
    const second = await f.waitingCall(said.runId);
    expect(second.id).not.toBe(first.id);
    expect(await f.requested(said.runId)).toMatchObject({
      operationRunId: second.id,
      inputPreview: { text: "two" }
    });
    expect(executed).toEqual(["one"]);

    expect((await f.decide(second.id, "decline")).statusCode).toBe(200);
    await f.until(said.runId, "completed");

    expect(executed).toEqual(["one"]);
    const messages = await f.messages(said.conversationId);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "assistant"
    ]);
    const tools = messages.filter((message) => message.role === "tool");
    expect(tools[0]?.text).toContain('"changed": "one"');
    expect(tools[1]?.text).toContain("The user declined this call. Nothing ran.");
    expect(lastModelInput()).toEqual(["user", "assistant:demo.change,demo.change", "tool", "tool"]);
    const types = (await f.events(said.runId)).map((event) => event.type);
    expect(types.filter((type) => type === "tool_decision_requested")).toHaveLength(2);
    expect(types.filter((type) => type === "tool_decision_recorded")).toHaveLength(2);
    await f.app.close();
  });

  it("W1-6: expires an idle 24-hour confirmation and resumes with an expired result after restart", async () => {
    const f = await fixture();
    const said = await f.say('/tool demo.change {"text":"expired"}');
    const waiting = await f.waitingCall(said.runId);
    const lifetime = Date.parse(required(waiting.expiresAt)) - Date.parse(waiting.updatedAt);
    expect(lifetime).toBeGreaterThan(24 * 60 * 60 * 1000 - 1000);
    expect(lifetime).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    await f.restart(false);
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1 });
    try {
      // Move the persisted deadline past the database clock, never fake the driver's timers.
      await sql`update operation_runs set expires_at = now() - interval '1 second'
        where id = ${waiting.id}`;
      // Before the sweep, the deadline alone refuses the answer, and says it expired.
      const late = await f.decide(waiting.id, "confirm");
      expect(late.statusCode, late.body).toBe(409);
      expect(late.json()).toMatchObject({
        error: { code: "CONFLICT", details: { reason: DECISION_EXPIRED_REASON } }
      });
      await getTestJobs(f.app).runDue();
      expect(await f.callsOf(said.runId)).toMatchObject([{ id: waiting.id, status: "expired" }]);
      expect(await f.agentRun(said.runId)).toMatchObject({ status: "queued" });
      const [queued] = await sql<{ count: number }[]>`select count(*)::int as count
        from platform_jobs where kind = 'agent_run.execute' and subject = ${said.runId}
        and status = 'queued'`;
      expect(queued?.count).toBe(1);
      // A replayed sweep neither repeats the event nor queues a second resume.
      expect(
        await f.app.stores.operationRuns.markExpired({
          clientInstanceId: f.clientInstanceId,
          limit: 10
        })
      ).toEqual([]);
      expect(
        (await f.events(said.runId)).filter((event) => event.type === "tool_decision_recorded")
      ).toMatchObject([{ operationRunId: waiting.id, outcome: "expired" }]);
      const expired = await f.decide(waiting.id, "confirm");
      expect(expired.statusCode, expired.body).toBe(409);
      expect(expired.json()).toMatchObject({
        error: { code: "CONFLICT", details: { reason: DECISION_EXPIRED_REASON } }
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
    await f.restart();
    await f.until(said.runId, "completed");
    expect(executed).toEqual([]);
    const messages = await f.messages(said.conversationId);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant"
    ]);
    expect(messages.find((message) => message.role === "tool")?.text).toContain(
      "expired. Nothing ran."
    );
    expect(messages.at(-1)?.text).toContain("expired. Nothing ran.");
    expect(await f.callsOf(said.runId)).toMatchObject([{ id: waiting.id, status: "expired" }]);
    await f.app.close();
  });

  it("W1-7: Stop settles a waiting run within one request without a worker and cannot resurrect it", async () => {
    const f = await fixture();
    const said = await f.say('/tool demo.change {"text":"cancelled"}');
    const waiting = await f.waitingCall(said.runId);
    await f.restart(false);
    const stop = () =>
      f.app.call("conversations.runs.cancel", {
        params: { conversationId: said.conversationId, runId: said.runId },
        payload: { reason: "Stop" }
      });
    const stopped = await stop();
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(stopped.json()).toMatchObject({ run: { id: said.runId, status: "cancelled" } });
    expect(await f.agentRun(said.runId)).toMatchObject({ status: "cancelled" });
    expect(await f.callsOf(said.runId)).toMatchObject([
      { id: waiting.id, status: "denied", error: { reason: "cancelled" } }
    ]);
    expect((await f.events(said.runId)).slice(-2)).toMatchObject([
      { type: "tool_decision_recorded", operationRunId: waiting.id, outcome: "cancelled" },
      { type: "run_cancelled" }
    ]);
    const events = await f.events(said.runId);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index + 1));
    expect((await stop()).statusCode).toBe(200);
    expect(await f.events(said.runId)).toEqual(events);
    expect((await f.decide(waiting.id, "confirm")).statusCode).toBe(409);
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1 });
    try {
      const [row] = await sql`select resume_state from agent_runs where id = ${said.runId}`;
      expect(row?.resume_state).toBeNull();
    } finally {
      await sql.end({ timeout: 5 });
    }
    await f.restart();
    expect(await f.agentRun(said.runId)).toMatchObject({ status: "cancelled" });
    expect(executed).toEqual([]);
    await f.app.close();
  });

  it("does not expire a confirmation decided before its deadline while its worker is offline", async () => {
    const f = await fixture();
    const said = await f.say('/tool demo.change {"text":"confirmed"}');
    const waiting = await f.waitingCall(said.runId);
    await f.restart(false);
    expect((await f.decide(waiting.id, "confirm")).statusCode).toBe(200);
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1 });
    try {
      await sql`update operation_runs set expires_at = now() - interval '1 second' where id = ${waiting.id}`;
      expect(
        await f.app.stores.operationRuns.markExpired({
          clientInstanceId: f.clientInstanceId,
          limit: 10
        })
      ).toEqual([]);
      // A decline from a stale tab after the deadline: the call was confirmed and may run,
      // so the refusal must not say it expired.
      const stale = await f.decide(waiting.id, "decline");
      expect(stale.statusCode, stale.body).toBe(409);
      expect(
        stale.json<{ error: { details?: { reason?: string } } }>().error.details?.reason
      ).not.toBe(DECISION_EXPIRED_REASON);
    } finally {
      await sql.end({ timeout: 5 });
    }
    await f.restart();
    await f.until(said.runId, "completed");
    expect(executed).toEqual(["confirmed"]);
    await f.app.close();
  });

  it("settles Stop racing expiry without a worker and never executes the held call", async () => {
    const f = await fixture();
    const said = await f.say('/tool demo.change {"text":"race"}');
    const waiting = await f.waitingCall(said.runId);
    await f.restart(false);
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1 });
    try {
      await sql`update operation_runs set expires_at = now() - interval '1 second' where id = ${waiting.id}`;
      const [stop] = await Promise.all([
        f.app.call("conversations.runs.cancel", {
          params: { conversationId: said.conversationId, runId: said.runId },
          payload: {}
        }),
        f.app.stores.operationRuns.markExpired({ clientInstanceId: f.clientInstanceId, limit: 10 })
      ]);
      expect(stop.statusCode, stop.body).toBe(200);
      expect(await f.agentRun(said.runId)).toMatchObject({ status: "cancelled" });
      const call = required((await f.callsOf(said.runId)).find((call) => call.id === waiting.id));
      expect(["denied", "expired"]).toContain(call.status);
      if (call.status === "denied") expect(call.error?.reason).toBe("cancelled");
      expect((await f.decide(waiting.id, "confirm")).statusCode).toBe(409);
      const events = await f.events(said.runId);
      expect(events.filter((event) => event.type === "tool_decision_recorded")).toHaveLength(1);
      expect(events.at(-1)?.type).toBe("run_cancelled");
      expect(events.map((event) => event.sequence)).toEqual(
        events.map((_event, index) => index + 1)
      );
    } finally {
      await sql.end({ timeout: 5 });
    }
    await f.restart();
    expect(executed).toEqual([]);
    await f.app.close();
  });

  it("Stop denies a confirmed call queued for an offline worker", async () => {
    const f = await fixture();
    const said = await f.say('/tool demo.change {"text":"stop-before-execute"}');
    const waiting = await f.waitingCall(said.runId);
    await f.restart(false);
    expect((await f.decide(waiting.id, "confirm")).statusCode).toBe(200);
    const stop = await f.app.call("conversations.runs.cancel", {
      params: { conversationId: said.conversationId, runId: said.runId },
      payload: {}
    });
    expect(stop.statusCode, stop.body).toBe(200);
    expect(await f.callsOf(said.runId)).toMatchObject([
      { id: waiting.id, status: "denied", error: { reason: "cancelled" } }
    ]);
    await f.restart();
    expect(await f.agentRun(said.runId)).toMatchObject({ status: "cancelled" });
    expect(executed).toEqual([]);
    await f.app.close();
  });

  it("executes a confirmed call once when the run has a second job", async () => {
    const f = await fixture();
    const said = await f.say('/tool demo.change {"text":"once"}');
    const waiting = await f.waitingCall(said.runId);
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1 });
    try {
      expect((await f.decide(waiting.id, "confirm")).statusCode).toBe(200);
      // A second job of the run, as a redelivered or duplicated one, beside the one the
      // decision queued.
      await sql`
        insert into platform_jobs (id, client_instance_id, kind, subject, payload, status,
          run_after, attempts, max_attempts, correlation_id, created_at)
        select id || '_duplicate', client_instance_id, kind, subject, payload, 'queued',
          now(), 0, max_attempts, correlation_id, now()
        from platform_jobs
        where kind = 'agent_run.execute' and subject = ${said.runId}
        order by created_at desc limit 1`;
      await f.until(said.runId, "completed");
      await waitUntil(async () => {
        const [open] = await sql<{ count: number }[]>`
          select count(*)::int as count from platform_jobs
          where subject = ${said.runId} and status in ('queued', 'running')`;
        return open?.count === 0;
      }, "both jobs of the run ended");
    } finally {
      await sql.end({ timeout: 5 });
    }

    expect(executed).toEqual(["once"]);
    expect(await f.callsOf(said.runId)).toMatchObject([{ id: waiting.id, status: "done" }]);
    const types = (await f.events(said.runId)).map((event) => event.type);
    expect(types.filter((type) => type === "run_completed")).toHaveLength(1);
    expect((await f.messages(said.conversationId)).map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant"
    ]);
    await f.app.close();
  });
});
