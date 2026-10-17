import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  createPlatformId,
  defineProvider,
  type AgentRun,
  type AgentRunStatus,
  type CentralPolicySetting
} from "@work-shape/catalyst-core";
import type { ClientInstanceCapability } from "@work-shape/catalyst-client-assembly";
import {
  DETERMINISTIC_CAPABILITIES,
  modelContentText,
  parseToolInput,
  type ModelAdapterFactory,
  type ModelAdapterRequest,
  type ModelCompletion
} from "@work-shape/catalyst-model-provider";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { deferred, required, waitUntil } from "./support/assertions";
import { injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig, personalConversationListInput } from "./support/fixtures";
import { createTestInstance, getTestConfig, type TestInstance } from "./support/test-instance";
import { withTestSql } from "./support/test-sql";

// CR-1: an agent hands sub-tasks to subagents with `run_agent`. Checks 90, 92, 93, 95, 97 and
// 98 of events-workflows-and-guardrails.md, through a running instance and its workers.

const SUBAGENT_MODEL_PROVIDER = "subagent-test";
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

const noUsage: ModelCompletion["usage"] = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  source: "not_reported",
  webSearchCallCount: 0
};

/**
 * The tool-calling model of the decision tests, with a hold: it makes every call a message
 * lists, one `/tool <name> <json>` per line, answers with the results once they follow, and
 * answers a message that says `/hold` only when the test releases it.
 */
function createSubagentModel() {
  const requests: ModelAdapterRequest[] = [];
  let hold = deferred<void>();
  const answerTo = (request: ModelAdapterRequest): ModelCompletion => {
    requests.push(request);
    const lastUser = request.messages.findLastIndex((message) => message.role === "user");
    const results = request.messages
      .slice(lastUser + 1)
      .filter((message) => message.role === "tool")
      .map((message) => modelContentText(message.content));
    const answer = { toolCalls: [], sources: [], citations: [], usage: noUsage };
    if (results.length > 0) {
      return { ...answer, text: `Tool work completed:\n\n${results.join("\n\n")}` };
    }
    const said = modelContentText(request.messages[lastUser]?.content ?? "");
    const toolCalls = said.split("\n").flatMap((line) => {
      const [, toolName, json = "{}"] = line.trim().match(/^\/tool\s+(\S+)\s*(.*)$/u) ?? [];
      return toolName
        ? [{ toolCallId: createPlatformId("toolcall"), toolName, ...parseToolInput(json) }]
        : [];
    });
    return toolCalls.length > 0
      ? { ...answer, text: "", toolCalls }
      : { ...answer, text: `I received: ${said}` };
  };
  const provider = defineProvider({
    port: "models",
    type: SUBAGENT_MODEL_PROVIDER,
    configSchema: z.object({}),
    external: false,
    create(): ModelAdapterFactory {
      return () => ({
        capabilities: () => DETERMINISTIC_CAPABILITIES,
        complete: async (request) => answerTo(request),
        async *stream(request) {
          const completion = answerTo(request);
          if (completion.text === "I received: /hold") await hold.promise;
          if (completion.text) yield { type: "text_delta", delta: completion.text };
          yield { type: "completed", completion };
        }
      });
    },
    check: async () => ({ ok: true }),
    describe() {
      return {};
    }
  });
  const capability: ClientInstanceCapability = {
    name: "subagent-model",
    providers: [provider],
    create: () => ({})
  };
  return {
    capability,
    requests,
    release() {
      hold.resolve();
    },
    reset() {
      requests.length = 0;
      hold = deferred<void>();
    }
  };
}

const model = createSubagentModel();

async function fixture(policies: CentralPolicySetting[] = [], unattended = false) {
  executed.length = 0;
  model.reset();
  const config = createTestConfig({
    tools: [{ name: change.name, enabled: true }],
    toolNames: ["run_agent", change.name]
  });
  config.infrastructure.models = { local: { provider: SUBAGENT_MODEL_PROVIDER, model: "local" } };
  const app: TestInstance = await createTestInstance({
    config,
    env: {},
    capabilities: [model.capability],
    tools: [change],
    operations: { centralPolicySettings: () => policies },
    // Nobody watches the runs, as for a scheduled start (EW-8): a subagent's run still is not.
    ...(unattended ? { unattendedRuns: () => true } : {})
  });
  const clientInstanceId = asClientInstanceId(getTestConfig(app).clientInstance.id);
  const agentRun = async (runId: string): Promise<AgentRun> =>
    required(
      await app.stores.agentRuns.getAgentRun({ clientInstanceId, runId: asAgentRunId(runId) })
    );
  const events = async (runId: string) =>
    (
      await app.stores.agentRuns.listRunObservations({
        clientInstanceId,
        runId: asAgentRunId(runId)
      })
    ).map((observation) => observation.payload);
  return {
    app,
    clientInstanceId,
    agentRun,
    events,
    until: (runId: string, status: AgentRunStatus) =>
      waitUntil(async () => (await agentRun(runId)).status === status, `the run is ${status}`),
    /** A new conversation with one message to the agent. */
    async say(text: string) {
      const created = await app.call("conversations.create", { payload: { title: "Split" } });
      const conversationId = created.json<{ id: string }>().id;
      const started = await injectStartConversationRun(app, conversationId, text);
      return { conversationId, runId: started.run.id };
    },
    async subagents(conversationId: string) {
      const listed = await app.call("conversations.subagents.list", {
        params: { conversationId }
      });
      expect(listed.statusCode, listed.body).toBe(200);
      return listed.json<{
        items: Array<{
          runId: string;
          threadId: string;
          toolCallId: string;
          agentName: string;
          description: string;
          status: AgentRunStatus;
        }>;
      }>().items;
    },
    /** The children a parent started, from its `subagent_started` events, in call order. */
    async children(parentRunId: string) {
      return (await events(parentRunId)).flatMap((event) =>
        event.type === "subagent_started" ? [event] : []
      );
    },
    /** Where a run stands in its tree, as stored: the domain run carries its parent only. */
    lineage: (runId: string) =>
      withTestSql(
        (sql) => sql<Array<{ rootRunId: string | null; depth: number }>>`
          select root_run_id as "rootRunId", depth from agent_runs where id = ${runId}`
      ).then((rows) => required(rows[0])),
    /** The `agent_run.execute` jobs of these runs that have not ended. */
    openJobs: (runIds: readonly string[]) =>
      withTestSql(
        (sql) => sql<Array<{ subject: string; status: string }>>`
          select subject, status from platform_jobs
          where kind = 'agent_run.execute' and subject = any(${[...runIds]})
            and status in ('queued', 'running')`
      ).then((rows) => rows.map((row) => ({ subject: row.subject, status: row.status }))),
    /** What the model was asked for a conversation whose first message is `text`. */
    requestsFor: (text: string) =>
      model.requests.filter(
        (request) =>
          modelContentText(
            request.messages.find((message) => message.role === "user")?.content ?? ""
          ) === text
      )
  };
}

const runAgent = (input: Record<string, unknown>) => `/tool run_agent ${JSON.stringify(input)}`;

describe("subagents of a chat agent", () => {
  it("starts three in one step, waits for them without a job and answers with all three", async () => {
    const f = await fixture();
    const message = [
      runAgent({ description: "Markt", task: "Research the market." }),
      runAgent({ description: "Kosten", task: "Research the costs." }),
      runAgent({ description: "Recht", task: "Research the law." })
    ].join("\n");
    const said = await f.say(message);
    await f.until(said.runId, "completed");

    const children = await f.children(said.runId);
    expect(children.map((child) => child.description)).toEqual(["Markt", "Kosten", "Recht"]);
    for (const child of children) {
      expect(await f.agentRun(child.subagentRunId)).toMatchObject({
        status: "completed",
        parentRunId: said.runId,
        conversationId: child.threadId
      });
      expect(await f.lineage(child.subagentRunId)).toEqual({ rootRunId: said.runId, depth: 1 });
    }
    // One wake: the model was asked once for the step that started them and once after.
    expect(f.requestsFor(message)).toHaveLength(2);
    const parentEvents = await f.events(said.runId);
    expect(parentEvents.filter((event) => event.type === "run_completed")).toHaveLength(1);
    const answer = required(
      parentEvents.filter((event) => event.type === "message_completed").at(-1)
    );
    for (const task of ["Research the market.", "Research the costs.", "Research the law."]) {
      expect(JSON.stringify(answer)).toContain(`I received: ${task}`);
    }
    await waitUntil(
      async () =>
        (await f.openJobs([said.runId, ...children.map((child) => child.subagentRunId)])).length ===
        0,
      "no job of the parent or its children is left"
    );

    // The panel lists them; the conversation list shows the root alone.
    const listed = await f.subagents(said.conversationId);
    expect(listed.map((item) => item.description).sort()).toEqual(["Kosten", "Markt", "Recht"]);
    expect(listed.every((item) => item.status === "completed")).toBe(true);
    expect(listed.every((item) => item.agentName === "test_agent")).toBe(true);
    const conversations = await f.app.call(
      "conversations.list",
      await personalConversationListInput(f.app)
    );
    const listedIds = conversations
      .json<{ items: Array<{ id: string }> }>()
      .items.map((item) => item.id);
    expect(listedIds).toContain(said.conversationId);
    for (const child of children) expect(listedIds).not.toContain(child.threadId);

    // A thread reads through its root: the task is its first message.
    const thread = await f.app.call("conversations.thread.get", {
      params: { conversationId: required(children[0]).threadId }
    });
    expect(thread.statusCode, thread.body).toBe(200);
    const snapshot = thread.json<{
      conversation: { title: string };
      messages: Array<{ role: string; text: string }>;
    }>();
    expect(snapshot.conversation.title).toBe("Markt");
    expect(snapshot.messages[0]).toMatchObject({ role: "user", text: "Research the market." });
    await f.app.close();
  });

  it("refuses every write of the conversation routes on a thread", async () => {
    const f = await fixture();
    const said = await f.say(runAgent({ description: "Eins", task: "Do one thing." }));
    await f.until(said.runId, "completed");
    const threadId = required((await f.children(said.runId))[0]).threadId;
    const params = { conversationId: threadId };
    const writes = await Promise.all([
      f.app.call("conversations.runs.start", {
        params,
        payload: { idempotencyKey: "thread-start", message: { text: "More" } }
      }),
      f.app.call("conversations.rename", { params, payload: { title: "Other" } }),
      f.app.call("conversations.delete", { params }),
      f.app.call("conversations.move", {
        params,
        payload: { collaborationWorkspaceId: "anywhere" }
      })
    ]);
    for (const write of writes) {
      expect(write.statusCode, write.body).toBe(409);
      expect(write.body).toContain("run_thread");
    }
    await f.app.close();
  });

  it.each([
    ["", false],
    [" with the runtime marked unattended (operations check 38)", true]
  ] as const)(
    "answers a call needing a confirmation in a child as confirmation_required%s",
    async (_, unattended) => {
      const f = await fixture([{ operation: change.name, value: "confirm" }], unattended);
      const task = `/tool demo.change ${JSON.stringify({ text: "one" })}`;
      const said = await f.say(runAgent({ description: "Ändern", task }));
      await f.until(said.runId, "completed");

      const child = required((await f.children(said.runId))[0]);
      expect(await f.agentRun(child.subagentRunId)).toMatchObject({ status: "completed" });
      expect(executed).toEqual([]);
      // No card and no decision: the child read the refusal and went on.
      const childEvents = await f.events(child.subagentRunId);
      expect(childEvents.some((event) => event.type === "tool_decision_requested")).toBe(false);
      const refused = required(
        childEvents.find(
          (event) => event.type === "tool_call_failed" || event.type === "tool_call_completed"
        )
      );
      expect(JSON.stringify(refused)).toContain("confirmation_required");
      expect(JSON.stringify(refused)).toContain(change.name);
      const pending = (
        await f.app.stores.operationRuns.list({ clientInstanceId: f.clientInstanceId })
      )
        .filter(
          (run) => run.origin.kind === "agent" && run.origin.agentRunId === child.subagentRunId
        )
        .filter((run) => run.status === "pending_confirmation");
      expect(pending).toEqual([]);
      await f.app.close();
    }
  );

  it("starts a subagent once its person confirmed the run_agent call", async () => {
    const f = await fixture([{ operation: "agents.run", value: "confirm" }]);
    const said = await f.say(runAgent({ description: "Bestätigt", task: "Research once." }));
    const calls = () =>
      f.app.stores.operationRuns
        .list({ clientInstanceId: f.clientInstanceId })
        .then((runs) =>
          runs.filter((run) => run.origin.kind === "agent" && run.origin.agentRunId === said.runId)
        );
    await waitUntil(
      async () => (await calls()).some((run) => run.status === "pending_confirmation"),
      "the run_agent call waits for a confirmation"
    );
    const waiting = required((await calls()).find((run) => run.status === "pending_confirmation"));
    expect(waiting.operation).toBe("agents.run");
    expect(await f.children(said.runId)).toEqual([]);

    const decided = await f.app.call("operations.decide", {
      params: { runId: waiting.id },
      payload: { decision: "confirm" }
    });
    expect(decided.statusCode, decided.body).toBe(200);
    await f.until(said.runId, "completed");

    const child = required((await f.children(said.runId))[0]);
    expect(await f.agentRun(child.subagentRunId)).toMatchObject({
      status: "completed",
      parentRunId: said.runId
    });
    expect(
      (await calls()).find((run) => run.id === waiting.id)?.status,
      "the confirmed call ran"
    ).toBe("done");
    const answer = required(
      (await f.events(said.runId)).filter((event) => event.type === "message_completed").at(-1)
    );
    expect(JSON.stringify(answer)).toContain("I received: Research once.");
    await f.app.close();
  });

  it("refuses an agent outside the list, a fifth call in a step and a reserved field", async () => {
    const f = await fixture();
    // The refused calls come first: they start nothing, so the step's limit is not yet reached.
    const message = [
      runAgent({ description: "F", task: "Task F.", agent: "nobody" }),
      runAgent({ description: "G", task: "Task G.", background: true }),
      ...["A", "B", "C", "D", "E"].map((name) =>
        runAgent({ description: name, task: `Task ${name}.` })
      )
    ].join("\n");
    const said = await f.say(message);
    await f.until(said.runId, "completed");

    const children = await f.children(said.runId);
    expect(children.map((child) => child.description)).toEqual(["A", "B", "C", "D"]);
    const failures = (await f.events(said.runId)).flatMap((event) =>
      event.type === "tool_call_failed" ? [JSON.stringify(event)] : []
    );
    expect(failures.some((failure) => failure.includes("subagent_limit"))).toBe(true);
    expect(failures.some((failure) => failure.includes("agent_not_available"))).toBe(true);
    expect(failures.some((failure) => failure.includes("background"))).toBe(true);
    // A subagent is never offered run_agent.
    const childRequest = required(f.requestsFor("Task A.")[0]);
    const offered = childRequest.tools.map((tool) => tool.name);
    expect(offered).toContain(change.name);
    expect(offered).not.toContain("run_agent");
    await f.app.close();
  });

  it("counts a child's model calls to the person and the root's workspace", async () => {
    const f = await fixture();
    const said = await f.say(runAgent({ description: "Zählen", task: "Count this." }));
    await f.until(said.runId, "completed");
    const child = required((await f.children(said.runId))[0]);
    const root = required(
      await f.app.stores.conversations.getConversation(
        f.clientInstanceId,
        asConversationId(said.conversationId)
      )
    );
    const events = await f.app.stores.usage.listModelUsageEvents({
      clientInstanceId: f.clientInstanceId
    });
    const ofChild = events.filter((event) => event.agentRunId === child.subagentRunId);
    expect(ofChild.length).toBeGreaterThan(0);
    for (const event of ofChild) {
      expect(event).toMatchObject({
        conversationId: child.threadId,
        userId: (await f.agentRun(said.runId)).ownerUserId,
        collaborationWorkspaceId: root.collaborationWorkspaceId
      });
    }
    await f.app.close();
  });
});

describe("stopping subagents", () => {
  it("ends a parent waiting for its children within the request, and them with it", async () => {
    const f = await fixture();
    const said = await f.say(
      [
        runAgent({ description: "Lang", task: "/hold" }),
        runAgent({ description: "Länger", task: "/hold" })
      ].join("\n")
    );
    await f.until(said.runId, "waiting_for_subagents");
    const children = await f.children(said.runId);
    expect(children).toHaveLength(2);
    // It waits with no lease and no job.
    await waitUntil(
      async () => (await f.openJobs([said.runId])).length === 0,
      "the waiting parent holds no job"
    );

    const stopped = await f.app.call("conversations.runs.cancel", {
      params: { conversationId: said.conversationId, runId: said.runId },
      payload: { reason: "user_requested" }
    });
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect((await f.agentRun(said.runId)).status).toBe("cancelled");
    model.release();
    for (const child of children) await f.until(child.subagentRunId, "cancelled");
    // A worker ends a cancelled run's job just after the run, so this waits rather than reads.
    await waitUntil(
      async () =>
        (await f.openJobs([said.runId, ...children.map((child) => child.subagentRunId)])).length ===
        0,
      "no job of the parent or its children is left"
    );
    await f.app.close();
  });

  it("ends one child from its thread, and the parent goes on with the other", async () => {
    const f = await fixture();
    const said = await f.say(
      [
        runAgent({ description: "Stoppen", task: "/hold" }),
        runAgent({ description: "Weiter", task: "Keep going." })
      ].join("\n")
    );
    await waitUntil(async () => (await f.children(said.runId)).length === 2, "both started");
    const [held, other] = await f.children(said.runId);
    const stopped = await f.app.call("conversations.runs.cancel", {
      params: { conversationId: required(held).threadId, runId: required(held).subagentRunId },
      payload: { reason: "user_requested" }
    });
    expect(stopped.statusCode, stopped.body).toBe(200);
    model.release();
    await f.until(required(held).subagentRunId, "cancelled");
    await f.until(required(other).subagentRunId, "completed");
    await f.until(said.runId, "completed");

    const answer = required(
      (await f.events(said.runId)).filter((event) => event.type === "message_completed").at(-1)
    );
    expect(JSON.stringify(answer)).toContain("cancelled");
    expect(JSON.stringify(answer)).toContain("I received: Keep going.");
    await f.app.close();
  });
});
