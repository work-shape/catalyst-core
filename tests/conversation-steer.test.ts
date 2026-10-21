import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  createPlatformId,
  defineProvider,
  readUserMessageMetadata,
  type AgentRunStatus,
  type CentralPolicySetting,
  type ConversationFollowUp
} from "@work-shape/catalyst-core";
import {
  DETERMINISTIC_CAPABILITIES,
  modelContentText,
  type ModelAdapterFactory,
  type ModelAdapterRequest,
  type ModelCompletion
} from "@work-shape/catalyst-model-provider";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { deferred, required, waitUntil } from "./support/assertions";
import { injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import { withTestSql } from "./support/test-sql";
import { createTestInstance, getTestConfig, getTestJobs } from "./support/test-instance";

// FU-2: a message the run's own person sends with `steer` is taken in by the running turn
// after all results of a step and before the next model call. A steer the turn did not read
// before it answered becomes the next turn; someone else's steer is queued (checks 85, 86, 88).

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  source: "not_reported" as const,
  webSearchCallCount: 0
};
const answer: ModelCompletion = { text: "", toolCalls: [], sources: [], citations: [], usage };

let close: (() => Promise<void>) | undefined;
let releaseAll: (() => void) | undefined;
afterEach(async () => {
  releaseAll?.();
  await close?.();
  close = undefined;
});

async function fixture() {
  // The first request of a run calls the waiting tool; every later one waits for its gate,
  // then says what the last user message was.
  const requests: ModelAdapterRequest[] = [];
  const gates: Array<ReturnType<typeof deferred<void>>> = [];
  const toolGate = deferred<void>();
  const wait = defineTool({
    name: "demo.wait",
    effect: "reading",
    permission: { mode: "allow" },
    description: "Waits until the test lets it finish.",
    inputSchema: z.object({}),
    async execute() {
      await toolGate.promise;
      return toolSuccess({ waited: true });
    }
  });
  // A call that waits for its person's confirmation, asked for by the steer "Change it".
  const change = defineTool({
    name: "demo.change",
    effect: "changing",
    permission: { mode: "allow" },
    description: "Changes something.",
    inputSchema: z.object({}),
    execute: () => toolSuccess({ changed: true })
  });
  const confirmChange: CentralPolicySetting = { operation: change.name, value: "confirm" };
  const reply = async (request: ModelAdapterRequest): Promise<ModelCompletion> => {
    const index = requests.length;
    requests.push(request);
    const lastUser = request.messages.findLastIndex((message) => message.role === "user");
    const said = modelContentText(request.messages[lastUser]?.content ?? "");
    const call = (toolName: string) => ({
      ...answer,
      toolCalls: [{ toolCallId: createPlatformId("toolcall"), toolName, input: {} }]
    });
    if (said === "Go" && !request.messages.some((message) => message.role === "tool"))
      return call(wait.name);
    if (said === "Change it" && request.messages.at(-1)?.role === "user") return call(change.name);
    const gate = deferred<void>();
    gates[index] = gate;
    await gate.promise;
    return { ...answer, text: `I read: ${said}` };
  };
  const provider = defineProvider({
    port: "models",
    type: "steer-test",
    configSchema: z.object({}),
    external: false,
    create(): ModelAdapterFactory {
      return () => ({
        capabilities: () => DETERMINISTIC_CAPABILITIES,
        complete: reply,
        async *stream(request) {
          const completion = await reply(request);
          if (completion.text) yield { type: "text_delta", delta: completion.text };
          yield { type: "completed", completion };
        }
      });
    },
    check: async () => ({ ok: true }),
    describe: () => ({})
  });
  releaseAll = () => {
    toolGate.resolve();
    gates.forEach((gate) => gate?.resolve());
  };
  const config = createTestConfig({
    tools: [
      { name: wait.name, enabled: true },
      { name: change.name, enabled: true }
    ],
    toolNames: [wait.name, change.name],
    developmentAuth: {
      enabled: true,
      defaultUserId: "author",
      users: ["author", "other"].map((id) => ({
        id,
        externalUserId: id,
        displayLabel: id,
        email: `${id}@example.test`,
        roles: ["user", "admin", "superadmin"]
      }))
    }
  });
  config.conversationTitles.enabled = false;
  config.infrastructure.models = { local: { provider: "steer-test", model: "local" } };
  const app = await createTestInstance({
    config,
    env: {},
    capabilities: [{ name: "steer-test", providers: [provider], create: () => ({}) }],
    tools: [wait, change],
    operations: { centralPolicySettings: () => [confirmChange] }
  });
  close = () => app.close();
  const clientInstanceId = asClientInstanceId(getTestConfig(app).clientInstance.id);
  // Each person signs in once, so the other can be added to the workspace.
  for (const id of ["author", "other"]) await app.call("me.get", {}, id);
  const workspace = (
    await app.call("workspaces.create", { payload: { name: "Steer" } }, "author")
  ).json<{ id: string }>();
  const added = await app.call(
    "workspaces.members.add",
    {
      params: { collaborationWorkspaceId: workspace.id },
      payload: { email: "other@example.test" }
    },
    "author"
  );
  expect(added.statusCode, added.body).toBe(200);
  const created = await app.call(
    "conversations.create",
    { payload: { title: "Steer", collaborationWorkspaceId: workspace.id } },
    "author"
  );
  expect(created.statusCode, created.body).toBe(200);
  const conversationId = asConversationId(created.json<{ id: string }>().id);
  const scope = { clientInstanceId, conversationId };
  const run = async (id: string) =>
    required(await app.stores.agentRuns.getAgentRun({ clientInstanceId, runId: asAgentRunId(id) }));
  return {
    app,
    scope,
    requests,
    run,
    until: (id: string, status: AgentRunStatus) =>
      waitUntil(async () => (await run(id)).status === status, `run ${id} is ${status}`),
    releaseTool: () => toolGate.resolve(),
    release: async (index: number) => {
      await waitUntil(async () => gates[index] !== undefined, `model request ${index} is held`);
      required(gates[index]).resolve();
    },
    start: () => injectStartConversationRun(app, conversationId, "Go"),
    async send(text: string, followUp: "queue" | "steer", as = "author") {
      const response = await app.call(
        "conversations.runs.start",
        {
          params: { conversationId },
          payload: { followUp, idempotencyKey: createPlatformId("send"), message: { text } }
        },
        as
      );
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ followUp: ConversationFollowUp }>().followUp;
    },
    followUp: (followUpId: string) => app.stores.followUps.get({ ...scope, followUpId }),
    async confirmCallOf(runId: string) {
      const [waiting] = (await app.stores.operationRuns.list({ clientInstanceId })).filter(
        (operation) => operation.origin.kind === "agent" && operation.origin.agentRunId === runId
      );
      const decided = await app.call(
        "operations.decide",
        { params: { runId: required(waiting).id }, payload: { decision: "confirm" } },
        "author"
      );
      expect(decided.statusCode, decided.body).toBe(200);
    },
    async cancel(runId: string) {
      const response = await app.call(
        "conversations.runs.cancel",
        { params: { conversationId, runId }, payload: {} },
        "author"
      );
      expect(response.statusCode, response.body).toBe(200);
    },
    messages: () => app.stores.conversations.listMessages(scope),
    dispatch: () => getTestJobs(app).runDue()
  };
}

describe("steering a running turn", () => {
  it("takes the person's steer in after the step's results, as a user row of that moment", async () => {
    const f = await fixture();
    const { run: started } = await f.start();
    await waitUntil(async () => f.requests.length === 1, "the step calls the waiting tool");
    const steer = await f.send("Also check the attic", "steer");
    expect(steer).toMatchObject({ mode: "steer", status: "pending", dispatchedRunId: started.id });

    f.releaseTool();
    await waitUntil(async () => f.requests.length === 2, "the next model call went out");
    // After the tool's result, never between two results of one step.
    const roles = required(f.requests[1]).messages.map((message) => message.role);
    expect(roles.slice(-3)).toEqual(["assistant", "tool", "user"]);
    expect(modelContentText(required(required(f.requests[1]).messages.at(-1)).content)).toBe(
      "Also check the attic"
    );
    expect(await f.followUp(steer.id)).toMatchObject({ status: "consumed" });

    await f.release(1);
    await f.until(started.id, "completed");
    const messages = await f.messages();
    const steered = required(messages.find((message) => message.text === "Also check the attic"));
    expect(steered.role).toBe("user");
    expect(readUserMessageMetadata(steered.metadata)?.steered).toEqual({
      runId: started.id,
      followUpId: steer.id,
      authorUserId: steer.authorUserId,
      typedAt: steer.createdAt
    });
    // History order is model order: the step, its result, the steer, the answer.
    const order = messages.map((message) => message.role);
    expect(order).toEqual(["user", "assistant", "tool", "user", "assistant"]);
    expect(steered.createdAt > steer.createdAt).toBe(true);
    expect(messages.at(-1)?.text).toBe("I read: Also check the attic");

    const events = await withTestSql(
      (sql) =>
        sql`select type, payload from agent_run_observations where run_id = ${started.id} order by sequence`
    );
    const shown = events.find((event) => event.type === "user_message_steered");
    expect(shown?.payload).toMatchObject({
      followUpId: steer.id,
      message: { id: steered.id, role: "user", text: "Also check the attic" }
    });
    const audits = await withTestSql(
      (sql) =>
        sql`select actor, metadata from audit_events where subject = ${steered.id} and type = 'message.created'`
    );
    expect(audits).toHaveLength(1);
    expect(required(audits[0]).metadata).toMatchObject({ delivery: "steered", runId: started.id });
    expect(JSON.stringify(audits)).not.toContain("attic");

    // Nothing is left to dispatch: the steer was part of the turn.
    await f.dispatch();
    expect(f.requests).toHaveLength(2);
  });

  it("starts the next turn with a steer the run did not read before it answered", async () => {
    const f = await fixture();
    const { run: started } = await f.start();
    await waitUntil(async () => f.requests.length === 1, "the step calls the waiting tool");
    f.releaseTool();
    // The last step's boundary has passed: its model call is held.
    await waitUntil(async () => f.requests.length === 2, "the answering call went out");
    const steer = await f.send("One more thing", "steer");
    await f.release(1);
    await f.until(started.id, "completed");
    expect(await f.followUp(steer.id)).toMatchObject({
      mode: "queue",
      status: "pending",
      dispatchedRunId: undefined
    });

    await f.dispatch();
    await waitUntil(async () => f.requests.length === 3, "the steer started the next turn");
    expect(modelContentText(required(required(f.requests[2]).messages.at(-1)).content)).toBe(
      "One more thing"
    );
    const next = required((await f.followUp(steer.id))?.dispatchedRunId);
    await f.release(2);
    await f.until(next, "completed");
  });

  it("queues a steer into someone else's run, to run later with its author's rights", async () => {
    const f = await fixture();
    const { run: started } = await f.start();
    await waitUntil(async () => f.requests.length === 1, "the step calls the waiting tool");
    const theirs = await f.send("Steer from a colleague", "steer", "other");
    expect(theirs).toMatchObject({ mode: "queue", status: "pending" });
    expect(theirs.dispatchedRunId).toBeUndefined();

    f.releaseTool();
    await waitUntil(async () => f.requests.length === 2, "the next model call went out");
    expect(JSON.stringify(required(f.requests[1]).messages)).not.toContain("colleague");
    await f.release(1);
    await f.until(started.id, "completed");

    await f.dispatch();
    await waitUntil(async () => f.requests.length === 3, "the queued message ran");
    const next = required((await f.followUp(theirs.id))?.dispatchedRunId);
    expect((await f.run(next)).ownerUserId).toBe(theirs.authorUserId);
    await f.release(2);
    await f.until(next, "completed");
  });

  it("keeps a steer it took in when it goes on after a confirmation", async () => {
    const f = await fixture();
    const { run: started } = await f.start();
    await waitUntil(async () => f.requests.length === 1, "the step calls the waiting tool");
    await f.send("Change it", "steer");
    f.releaseTool();
    // The steer asks for a call that waits for its person's confirmation.
    await f.until(started.id, "waiting_for_decision");
    await f.confirmCallOf(started.id);
    await waitUntil(async () => f.requests.length === 3, "the resumed step went out");
    const resumed = required(f.requests[2]).messages.map((message) => ({
      role: message.role,
      text: message.role === "user" ? modelContentText(message.content) : undefined
    }));
    // The resumed input is the input the run had: the steer stands before the confirmed call.
    expect(resumed.slice(-5)).toEqual([
      { role: "assistant", text: undefined },
      { role: "tool", text: undefined },
      { role: "user", text: "Change it" },
      { role: "assistant", text: undefined },
      { role: "tool", text: undefined }
    ]);
    await f.release(2);
    await f.until(started.id, "completed");
  });

  it("takes no steer in once the run is asked to stop, and queues it when the run ends", async () => {
    const f = await fixture();
    const { run: started } = await f.start();
    await waitUntil(async () => f.requests.length === 1, "the step calls the waiting tool");
    const steer = await f.send("Never mind", "steer");
    await f.cancel(started.id);
    f.releaseTool();
    await f.until(started.id, "cancelled");
    expect(f.requests).toHaveLength(1);
    expect(await f.followUp(steer.id)).toMatchObject({ mode: "queue", status: "pending" });
    expect((await f.followUp(steer.id))?.dispatchedRunId).toBeUndefined();
    expect((await f.messages()).some((message) => message.text === "Never mind")).toBe(false);
  });
});
