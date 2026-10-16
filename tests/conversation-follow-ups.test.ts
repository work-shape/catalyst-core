import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  createPlatformId,
  defineProvider,
  type ConversationFollowUp,
  type AgentRunStatus
} from "@work-shape/catalyst-core";
import {
  DETERMINISTIC_CAPABILITIES,
  type ModelAdapterFactory,
  type ModelCompletion
} from "@work-shape/catalyst-model-provider";
import { createTestInstance, getTestConfig, getTestJobs } from "./support/test-instance";
import { createTestConfig } from "./support/fixtures";
import { deferred, required, waitUntil } from "./support/assertions";
import { injectStartConversationRun } from "./support/chat-server-run-harness";
import { withTestSql } from "./support/test-sql";

const objectRoots: string[] = [];
afterAll(async () => {
  await Promise.all(objectRoots.map((root) => rm(root, { recursive: true, force: true })));
});

const releaseOnCleanup: Array<() => void> = [];
afterEach(() => {
  for (const release of releaseOnCleanup.splice(0)) release();
});

/** One gate per actual model turn, so dispatch cannot finish a second turn in the assertions. */
async function fixture(
  separate = false,
  selection: { defaultEffortOnly?: boolean; attachments?: boolean; streaming?: boolean } = {}
) {
  const gates: Array<ReturnType<typeof deferred<void>>> = [];
  let cleaningUp = false;
  const deltaGates: Array<ReturnType<typeof deferred<void>>> = [];
  const completion: ModelCompletion = {
    text: "Done",
    toolCalls: [],
    sources: [],
    citations: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      source: "not_reported",
      webSearchCallCount: 0
    }
  };
  const provider = defineProvider({
    port: "models",
    type: "follow-up-test",
    configSchema: z.object({}),
    external: false,
    create(): ModelAdapterFactory {
      return () => ({
        capabilities: () => ({
          ...DETERMINISTIC_CAPABILITIES,
          reasoningEfforts: [...DETERMINISTIC_CAPABILITIES.reasoningEfforts, "high" as const]
        }),
        complete: async () => completion,
        async *stream() {
          const gate = deferred<void>();
          gates.push(gate);
          yield { type: "text_delta", delta: "Working" };
          if (selection.streaming) {
            for (let batch = 0; batch < 4; batch++) {
              const next = deferred<void>();
              deltaGates.push(next);
              if (!cleaningUp) await next.promise;
              for (let delta = 0; delta < 16; delta++) yield { type: "text_delta", delta: " more" };
            }
          }
          await gate.promise;
          yield { type: "completed", completion };
        }
      });
    },
    check: async () => ({ ok: true }),
    describe: () => ({})
  });
  releaseOnCleanup.push(() => {
    cleaningUp = true;
    gates.forEach((gate) => gate.resolve());
    deltaGates.forEach((gate) => gate.resolve());
  });
  const objectRoot = selection.attachments
    ? await mkdtemp(join(tmpdir(), "fu-1a-attachments-"))
    : undefined;
  if (objectRoot) objectRoots.push(objectRoot);
  const config = createTestConfig({
    ...(objectRoot
      ? { executionWorkspaces: { enabled: true }, workspaceObjectRoot: objectRoot }
      : {}),
    developmentAuth: {
      enabled: true,
      defaultUserId: "author",
      users: ["author", "other"].map((id) => ({
        id,
        externalUserId: id,
        displayLabel: id,
        email: `${id}@example.test`,
        roles: id === "author" ? ["user", "admin", "superadmin"] : ["user"]
      }))
    },
    modelBindings: [
      { id: "first", providerId: "local", userSelectable: true },
      {
        id: "picked",
        providerId: "local",
        userSelectable: true,
        reasoningEffort: "high",
        userSelectableReasoningEfforts: selection.defaultEffortOnly ? [] : ["high"]
      }
    ],
    agentModelBindingId: "first",
    agentUserSelectableModelBindingIds: ["first", "picked"]
  });
  config.conversationTitles.enabled = false;
  config.infrastructure.models = { local: { provider: "follow-up-test", model: "local" } };
  const app = await createTestInstance({
    config,
    env: {},
    capabilities: [{ name: "follow-up-test", providers: [provider], create: () => ({}) }],
    tools: [],
    ...(separate ? { agentRunWorker: "separate" as const } : {})
  });
  const clientInstanceId = asClientInstanceId(getTestConfig(app).clientInstance.id);
  const author = (await app.call("me.get", {}, "author")).json<{ id: string }>();
  const other = (await app.call("me.get", {}, "other")).json<{ id: string }>();
  const workspace = (
    await app.call("workspaces.create", { payload: { name: "Follow-ups" } }, "author")
  ).json<{ id: string }>();
  const add = await app.call(
    "workspaces.members.add",
    {
      params: { collaborationWorkspaceId: workspace.id },
      payload: { email: "other@example.test" }
    },
    "author"
  );
  expect(add.statusCode, add.body).toBe(200);
  const created = await app.call(
    "conversations.create",
    { payload: { title: "Follow-ups", collaborationWorkspaceId: workspace.id } },
    "author"
  );
  expect(created.statusCode, created.body).toBe(200);
  const conversationId = asConversationId(created.json<{ id: string }>().id);
  const scope = { clientInstanceId, conversationId };
  const run = async (id: string) =>
    required(await app.stores.agentRuns.getAgentRun({ clientInstanceId, runId: asAgentRunId(id) }));
  const until = (id: string, status: AgentRunStatus) =>
    waitUntil(async () => (await run(id)).status === status, `run ${id} is ${status}`);
  const first = await injectStartConversationRun(app, conversationId, "First");
  if (!separate) await waitUntil(async () => gates.length === 1, "first model turn is held");
  return {
    app,
    scope,
    author,
    other,
    workspace,
    first,
    run,
    until,
    release: () => required(gates[0]).resolve(),
    advance: () => required(deltaGates.at(-1)).resolve(),
    pending: () => app.stores.followUps.listPending(scope),
    messages: () => app.stores.conversations.listMessages(scope),
    async queue(text: string, as = "author", key: string = createPlatformId("send")) {
      const response = await app.call(
        "conversations.runs.start",
        {
          params: { conversationId },
          payload: {
            followUp: "queue",
            idempotencyKey: key,
            modelBindingId: "picked",
            ...(selection.defaultEffortOnly ? {} : { reasoningEffort: "high" }),
            message: { text }
          }
        },
        as
      );
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ followUp: ConversationFollowUp }>().followUp;
    },
    async fail() {
      required(gates[0]).reject(new Error("Provider fixture failed"));
      await until(first.run.id, "failed");
    },
    async complete(id = first.run.id, turn = 0) {
      await waitUntil(async () => gates[turn] !== undefined, "model turn is held");
      required(gates[turn]).resolve();
      await until(id, "completed");
    },
    async dispatch() {
      await getTestJobs(app).runDue();
    },
    async attachment(recognized = false) {
      const file = await app.stores.files.createManagedFile({
        clientInstanceId,
        ownerUserId: author.id,
        filename: "queued.txt",
        mimeType: "text/plain",
        byteSize: 1,
        checksum: createPlatformId("checksum"),
        objectKey: createPlatformId("follow-up-test")
      });
      return app.stores.files.createConversationAttachment({
        ...scope,
        fileId: file.id,
        filename: file.filename,
        mimeType: file.mimeType,
        byteSize: file.byteSize,
        checksum: file.checksum,
        status: "ready",
        ...(recognized ? { processingMetadata: { source: "execution_workspace_source" } } : {})
      });
    }
  };
}

describe("server follow-up queue on Postgres", () => {
  // Repeat with fresh instances to exercise both queue/worker scheduling orders.
  it.each([1, 2, 3, 4, 5, 6])(
    "streams 64 deltas through concurrent queue edits, withdrawal and completion without sequence gaps or deadlocks (repetition %i)",
    async () => {
      const f = await fixture(false, { streaming: true });
      const observations = (id = f.first.run.id) =>
        f.app.stores.agentRuns.listRunObservations({
          clientInstanceId: f.scope.clientInstanceId,
          runId: asAgentRunId(id)
        });
      const streamed = async (count: number) =>
        waitUntil(
          async () =>
            (await observations()).filter((event) => event.type === "message_delta").length >=
            count,
          `${count} deltas reached observers`
        );
      await streamed(1);
      const [original] = await Promise.all([
        f.queue("Original"),
        Promise.resolve().then(() => f.advance())
      ]);
      await streamed(17);
      const withdraw = () =>
        f.app.call("conversations.follow_ups.withdraw", {
          params: { conversationId: f.scope.conversationId, followUpId: original.id },
          payload: {}
        });
      const [edited, withdrawn] = await Promise.all([
        f.queue("Edited"),
        withdraw(),
        Promise.resolve().then(() => f.advance())
      ]);
      expect(withdrawn.statusCode, withdrawn.body).toBe(200);
      await streamed(33);
      const disposable = await f.queue("Withdraw during a write");
      await f.app.stores.transaction(async (stores) => {
        // Hold exactly the conversation lock that queue acceptance/editing holds.
        await stores.followUps.getOldestPending(f.scope);
        f.advance();
        await waitUntil(
          async () =>
            (
              await withTestSql(
                (sql) => sql`
          select pid from pg_stat_activity where datname = current_database()
            and wait_event_type = 'Lock'
            and (query ilike '%conversations%' or query ilike '%agent_run_observations%')
        `
              )
            ).length > 0,
          "worker waits on the held conversation"
        );
        // With the old order the worker already owns the run row: this write causes 40P01.
        await stores.followUps.cancel({
          ...f.scope,
          followUpId: disposable.id,
          authorUserId: f.author.id
        });
      });
      await streamed(49);
      f.advance();
      await streamed(65);
      f.release();
      await f.until(f.first.run.id, "completed");
      await f.dispatch();
      const dispatched = required(
        await f.app.stores.followUps.get({ ...f.scope, followUpId: edited.id })
      );
      expect(dispatched.status).toBe("dispatched");
      const nextId = required(dispatched.dispatchedRunId);
      // Finish the dispatched turn too; its first observation may be follow_up_changed.
      await waitUntil(
        async () => (await observations(nextId)).some((event) => event.type === "message_delta"),
        "follow-up streams"
      );
      for (let batch = 0; batch < 4; batch++) {
        f.advance();
        await waitUntil(
          async () =>
            (await observations(nextId)).filter((event) => event.type === "message_delta").length >=
            1 + (batch + 1) * 16,
          "follow-up batch persisted"
        );
      }
      await f.complete(nextId, 1);
      for (const id of [f.first.run.id, nextId]) {
        const events = await observations(id);
        expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
        expect(events.map((event) => event.payload.sequence)).toEqual(
          events.map((event) => event.sequence)
        );
        expect(events.at(-1)?.type).toBe("run_completed");
      }
      expect(
        (await observations())
          .filter((event) => event.type === "follow_up_changed")
          .map((event) => event.payload)
      ).toEqual(
        expect.arrayContaining(
          [
            { followUp: { id: original.id, status: "pending" } },
            { followUp: { id: edited.id, status: "pending" } },
            { followUp: { id: original.id, status: "cancelled" } },
            { followUp: { id: disposable.id, status: "pending" } },
            { followUp: { id: disposable.id, status: "cancelled" } }
          ].map((event) =>
            expect.objectContaining({ followUp: expect.objectContaining(event.followUp) })
          )
        )
      );
      expect(
        (await f.messages())
          .filter((message) => message.role === "user")
          .map((message) => message.text)
      ).toEqual(["First", "Edited"]);
    }
  );

  it("FU-1 stores a follow-up outside the transcript and dispatches its saved agent and model as its author", async () => {
    const f = await fixture();
    const item = await f.queue("Next", "other");
    expect(item).toMatchObject({
      status: "pending",
      agentName: "test_agent",
      modelBindingId: "picked",
      reasoningEffort: "high",
      authorUserId: f.other.id
    });
    expect((await f.messages()).map((message) => message.text)).toEqual(["First"]);
    const snapshot = await f.app.call("conversations.thread.get", {
      params: { conversationId: f.scope.conversationId }
    });
    expect(snapshot.statusCode, snapshot.body).toBe(200);
    expect(snapshot.json()).toMatchObject({ followUps: [{ id: item.id }] });
    await f.complete();
    await f.dispatch();
    const dispatched = required(
      await f.app.stores.followUps.get({ ...f.scope, followUpId: item.id })
    );
    expect(dispatched.status).toBe("dispatched");
    expect(await f.run(required(dispatched.dispatchedRunId))).toMatchObject({
      agentName: item.agentName,
      modelBindingId: "picked",
      reasoningEffort: "high",
      ownerUserId: f.other.id
    });
    expect(
      (await f.messages())
        .filter((message) => message.role === "user")
        .map((message) => message.text)
    ).toEqual(["First", "Next"]);
  });

  it("FU-1 preserves the configured reasoning effort when the author has no effort picker", async () => {
    const f = await fixture(false, { defaultEffortOnly: true });
    const item = await f.queue("Keep the default effort");
    expect(item.reasoningEffort).toBe("high");
    await f.complete();
    await f.dispatch();
    const dispatched = required(
      await f.app.stores.followUps.get({ ...f.scope, followUpId: item.id })
    );
    expect(dispatched.status).toBe("dispatched");
    expect(await f.run(required(dispatched.dispatchedRunId))).toMatchObject({
      reasoningEffort: "high",
      modelBindingId: "picked"
    });
  });

  it("FU-2 dispatches only the first of three pending messages per completed run, then starts three turns in order", async () => {
    const f = await fixture();
    const items = [await f.queue("One"), await f.queue("Two"), await f.queue("Three")];
    await f.complete();
    for (let index = 0; index < items.length; index++) {
      await f.dispatch();
      expect((await f.pending()).map((item) => item.id)).toEqual(
        items.slice(index + 1).map((item) => item.id)
      );
      const dispatched = required(
        await f.app.stores.followUps.get({ ...f.scope, followUpId: required(items[index]).id })
      );
      const runId = required(dispatched.dispatchedRunId);
      await waitUntil(
        async () => (await f.run(runId)).status === "running",
        "dispatched turn is running"
      );
      // A duplicate dispatch while this turn runs cannot consume the next item.
      await f.dispatch();
      expect((await f.pending()).length).toBe(items.length - index - 1);
      await f.complete(runId, index + 1);
    }
    expect(
      (await f.messages())
        .filter((message) => message.role === "user")
        .map((message) => message.text)
    ).toEqual(["First", "One", "Two", "Three"]);
  });

  it("FU-3 keeps CONFLICT without followUp and queues behind waiting_for_decision", async () => {
    const f = await fixture(true);
    const response = await f.app.call("conversations.runs.start", {
      params: { conversationId: f.scope.conversationId },
      payload: { idempotencyKey: "old-client", message: { text: "Legacy" } }
    });
    expect(response.statusCode).toBe(409);
    await withTestSql(
      (sql) =>
        sql`update agent_runs set status = 'waiting_for_decision' where id = ${f.first.run.id}`
    );
    const item = await f.queue("Wait for the decision");
    await f.dispatch();
    expect(await f.pending()).toMatchObject([{ id: item.id }]);
    expect(await f.run(f.first.run.id)).toMatchObject({ status: "waiting_for_decision" });
  });

  it.each(["failed", "cancelled"] as const)(
    "FU-4 pauses after a %s run and Send now restarts the oldest pending message",
    async (status) => {
      const f = await fixture();
      const item = await f.queue("Resume");
      if (status === "cancelled") {
        const response = await f.app.call("conversations.runs.cancel", {
          params: { conversationId: f.scope.conversationId, runId: f.first.run.id },
          payload: {}
        });
        expect(response.statusCode, response.body).toBe(200);
        await f.until(f.first.run.id, "cancelled");
      } else {
        await f.fail();
      }
      await f.dispatch();
      expect(await f.pending()).toMatchObject([{ id: item.id }]);
      const send = await f.app.call("conversations.follow_ups.dispatch", {
        params: { conversationId: f.scope.conversationId },
        payload: {}
      });
      expect(send.statusCode, send.body).toBe(200);
      await f.dispatch();
      expect((await f.pending()).length).toBe(0);
      expect(await f.app.stores.followUps.get({ ...f.scope, followUpId: item.id })).toMatchObject({
        status: "dispatched"
      });
    }
  );

  it("FU-5 claims queued attachments immediately, isolates the next draft, and transfers them only to their dispatched message", async () => {
    const f = await fixture();
    const attached = await f.attachment();
    const item = await f.queue("With attachment");
    expect(await f.app.stores.files.listDraftAttachments(f.scope)).toEqual([]);
    expect(
      await f.app.stores.followUps.listAttachments({ ...f.scope, followUpId: item.id })
    ).toMatchObject([{ id: attached.id }]);
    const next = await f.attachment();
    await f.complete();
    await f.dispatch();
    expect(await f.app.stores.files.listDraftAttachments(f.scope)).toMatchObject([{ id: next.id }]);
    const sent = required(
      (await f.messages()).find((message) => message.text === "With attachment")
    );
    expect(
      await f.app.stores.files.getConversationAttachment({
        clientInstanceId: f.scope.clientInstanceId,
        attachmentId: attached.id
      })
    ).toMatchObject({ messageId: sent.id });
  });

  it("FU-5 retains recognized attachment references in the dispatched message manifest", async () => {
    const f = await fixture(false, { attachments: true });
    const attachment = await f.attachment(true);
    await f.queue("Recognized source");
    await f.complete();
    await f.dispatch();
    const message = required(
      (await f.messages()).find((message) => message.text === "Recognized source")
    );
    expect(JSON.stringify(message.metadata)).toContain(attachment.id);
  });

  it("FU-6 permits author-only withdrawal and cancels a follow-up whose author lost workspace access before dispatch", async () => {
    const f = await fixture();
    const own = await f.queue("Withdraw");
    const refused = await f.app.call(
      "conversations.follow_ups.withdraw",
      { params: { conversationId: f.scope.conversationId, followUpId: own.id }, payload: {} },
      "other"
    );
    expect(refused.statusCode).toBe(403);
    const withdrawn = await f.app.call("conversations.follow_ups.withdraw", {
      params: { conversationId: f.scope.conversationId, followUpId: own.id },
      payload: {}
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect(withdrawn.json()).toMatchObject({ followUp: { id: own.id, status: "cancelled" } });
    const lost = await f.queue("No longer allowed", "other");
    await withTestSql(
      (sql) =>
        sql`delete from collaboration_workspace_memberships where collaboration_workspace_id = ${f.workspace.id} and user_id = ${f.other.id}`
    );
    await f.complete();
    await f.dispatch();
    expect(await f.app.stores.followUps.get({ ...f.scope, followUpId: lost.id })).toMatchObject({
      status: "cancelled"
    });
    expect(
      (await f.messages())
        .filter((message) => message.role === "user")
        .map((message) => message.text)
    ).toEqual(["First"]);
  });

  it("FU-7 audits message.created with queued delivery only when the message enters the transcript", async () => {
    const f = await fixture();
    const before = await withTestSql(
      (sql) =>
        sql`select subject from audit_events where client_instance_id = ${f.scope.clientInstanceId} and type = 'message.created'`
    );
    await f.queue("Never audit this text");
    const queued = await withTestSql(
      (sql) =>
        sql`select subject from audit_events where client_instance_id = ${f.scope.clientInstanceId} and type = 'message.created'`
    );
    expect(queued).toEqual(before);
    await f.complete();
    await f.dispatch();
    const sent = required(
      (await f.messages()).find((message) => message.text === "Never audit this text")
    );
    const audit = await withTestSql(
      (sql) =>
        sql`select metadata from audit_events where subject = ${sent.id} and type = 'message.created'`
    );
    expect(audit).toMatchObject([
      { metadata: { delivery: "queued", conversationId: f.scope.conversationId } }
    ]);
    expect(JSON.stringify(audit)).not.toContain("Never audit this text");
    // A background start uses the same completion audit as a turn started through the route.
    const latest = required(await f.app.stores.agentRuns.getLatestConversationAgentRun(f.scope));
    await f.complete(latest.id, 1);
    await waitUntil(
      async () =>
        (
          await withTestSql(
            (sql) =>
              sql`select id from audit_events where subject = ${f.scope.conversationId} and type = 'message.completed' and metadata->>'runId' = ${latest.id}`
          )
        ).length === 1,
      "follow-up completion is audited"
    );
  });

  it("queues two concurrent authors in position order, replays both idempotent outcomes and emits consecutive observations without stopping the worker", async () => {
    const f = await fixture();
    const items = await Promise.all([
      f.queue("A", "author", "concurrent-a"),
      f.queue("B", "other", "concurrent-b")
    ]);
    const ordered = [...items].sort((a, b) => a.position - b.position);
    expect(ordered.map((item) => item.position)).toEqual([1, 2]);
    expect((await f.pending()).map((item) => item.id)).toEqual(ordered.map((item) => item.id));
    expect(await f.queue("A", "author", "concurrent-a")).toEqual(items[0]);
    expect(await f.queue("B", "other", "concurrent-b")).toEqual(items[1]);
    await f.complete();
    const events = await f.app.stores.agentRuns.listRunObservations({
      clientInstanceId: f.scope.clientInstanceId,
      runId: asAgentRunId(f.first.run.id)
    });
    expect(events.filter((event) => event.type === "follow_up_changed")).toHaveLength(2);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, i) => i + 1));
    expect(events.at(-1)?.type).toBe("run_completed");
  });

  it("dispatch preserves the accepting caller's credential scope bounds without exposing authorization in queue observations", async () => {
    const f = await fixture();
    const original = required((await f.run(f.first.run.id)).authorization);
    const scopes = ["conversation:read", "conversation:write", "run:start"];
    const messageId = createPlatformId<"MessageId">("msg");
    const result = await f.app.stores.agentRuns.prepareConversationRunStart({
      ...f.scope,
      ownerUserId: f.author.id,
      followUp: "queue",
      userMessage: { id: messageId, text: "Keep the credential bounds" },
      run: {
        ...f.scope,
        id: createPlatformId<"AgentRunId">("run"),
        ownerUserId: f.author.id,
        inputMessageId: messageId,
        agentName: "test_agent",
        correlationId: "queue-scopes-test",
        authorization: { ...original, scopes }
      }
    });
    if (!("followUp" in result)) throw new Error("Expected a pending follow-up");
    expect(result.followUp).not.toHaveProperty("authorizationContext");
    const events = await f.app.stores.agentRuns.listRunObservations({
      clientInstanceId: f.scope.clientInstanceId,
      runId: asAgentRunId(f.first.run.id)
    });
    expect(
      events.filter((event) => event.type === "follow_up_changed").map((event) => event.payload)
    ).not.toEqual([]);
    expect(JSON.stringify(events)).not.toContain("authorizationContext");
    await f.complete();
    await f.dispatch();
    const dispatched = required(
      await f.app.stores.followUps.get({ ...f.scope, followUpId: result.followUp.id })
    );
    const run = await f.run(required(dispatched.dispatchedRunId));
    expect(run.authorization).toMatchObject({
      principal: original.principal,
      subjectUserId: f.author.id,
      scopes
    });
  });

  it("the oldest-item read waits for in-flight queue acceptance instead of losing a completion wake-up", async () => {
    const f = await fixture(true);
    let read: Promise<ConversationFollowUp | undefined> | undefined;
    let queuedId: string | undefined;
    await f.app.stores.transaction(async (stores) => {
      const messageId = createPlatformId<"MessageId">("msg");
      const result = await stores.agentRuns.prepareConversationRunStart({
        ...f.scope,
        ownerUserId: f.author.id,
        followUp: "queue",
        userMessage: { id: messageId, text: "Accepted but not committed" },
        run: {
          ...f.scope,
          id: createPlatformId<"AgentRunId">("run"),
          ownerUserId: f.author.id,
          inputMessageId: messageId,
          agentName: "test_agent",
          correlationId: "queue-lock-test"
        }
      });
      if (!("followUp" in result)) throw new Error("Expected a pending follow-up");
      queuedId = result.followUp.id;
      let settled = false;
      read = f.app.stores.followUps.getOldestPending(f.scope).finally(() => {
        settled = true;
      });
      await waitUntil(
        async () =>
          settled ||
          (
            await withTestSql(
              (sql) => sql`
        select pid from pg_stat_activity where datname = current_database()
          and wait_event_type = 'Lock' and query ilike '%conversations%'
      `
            )
          ).length > 0,
        "the oldest-item read is waiting on acceptance"
      );
      expect(settled).toBe(false);
    });
    expect(await required(read)).toMatchObject({ id: required(queuedId), status: "pending" });
  });

  it("uses the pending index to find one queued message among 10,000 follow-ups within one second", async () => {
    const f = await fixture(true);
    const pending = await f.queue("Only pending");
    await withTestSql(async (sql) => {
      await sql`insert into conversation_follow_ups
        (id, client_instance_id, conversation_id, author_user_id, text, mode, status, position, agent_name, created_at, updated_at)
        select ${createPlatformId("capacity")} || '-' || n, ${f.scope.clientInstanceId}, ${f.scope.conversationId}, ${f.author.id}, 'Ended', 'queue', 'dispatched', n, 'test_agent', now(), now()
        from generate_series(2, 10000) n`;
      await sql`analyze conversation_follow_ups`;
      const plan = await sql`explain (analyze, format json) select * from conversation_follow_ups
        where client_instance_id = ${f.scope.clientInstanceId} and conversation_id = ${f.scope.conversationId} and status = 'pending'
        order by position limit 1`;
      expect(JSON.stringify(plan)).toContain("conversation_follow_ups_pending_idx");
    });
    const started = performance.now();
    expect(await f.app.stores.followUps.getOldestPending(f.scope)).toMatchObject({
      id: pending.id
    });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("rejects malformed queue requests and a withdrawal scoped to another conversation", async () => {
    const f = await fixture(true);
    for (const payload of [
      { followUp: "steer", message: { text: "Wrong mode" } },
      { followUp: "queue", message: { text: "" } },
      { followUp: "queue", message: { text: null } }
    ]) {
      const response = await f.app.call("conversations.runs.start", {
        params: { conversationId: f.scope.conversationId },
        payload: { idempotencyKey: createPlatformId("invalid"), ...payload }
      });
      expect(response.statusCode).toBe(422);
    }
    expect(await f.pending()).toEqual([]);
    const item = await f.queue("Keep in its conversation");
    const other = (
      await f.app.call("conversations.create", {
        payload: { title: "Other", collaborationWorkspaceId: f.workspace.id }
      })
    ).json<{ id: string }>();
    const withdrawal = await f.app.call("conversations.follow_ups.withdraw", {
      params: { conversationId: other.id, followUpId: item.id },
      payload: {}
    });
    expect(withdrawal.statusCode).toBe(404);
    expect(await f.pending()).toMatchObject([{ id: item.id }]);
  });

  it("the conversation deletion claim removes follow-ups and marks their attachments deleted before cleanup", async () => {
    const f = await fixture(true);
    const attachment = await f.attachment();
    await f.queue("Delete with conversation");
    await f.app.stores.conversations.deleteConversation({
      ...f.scope,
      deletedAt: new Date().toISOString()
    });
    expect(await f.pending()).toEqual([]);
    const rows = await withTestSql(
      (sql) =>
        sql`select status, follow_up_id from conversation_attachments where id = ${attachment.id}`
    );
    expect(rows).toEqual([{ status: "deleted", follow_up_id: null }]);
    const late = await f.app.call("conversations.runs.start", {
      params: { conversationId: f.scope.conversationId },
      payload: { followUp: "queue", idempotencyKey: "after-delete", message: { text: "Late" } }
    });
    expect(late.statusCode).toBe(404);
  });
});
