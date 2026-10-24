import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@work-shape/catalyst-client-assembly";
import {
  asAgentRunId,
  createPlatformId,
  type ConversationFollowUp
} from "@work-shape/catalyst-core";
import { required, waitUntil } from "./support/assertions";
import { followUpFixture as fixture } from "./support/follow-up-fixture";
import { drainRunEvents } from "./support/chat-server-run-harness";
import { withTestSql } from "./support/test-sql";
import { applyAtCurrentRevisions } from "./support/asset-revisions";

// Count only statements of this read, excluding concurrent worker activity on the pool.
const counted = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return new AsyncLocalStorage<string[]>();
});
vi.mock("postgres", async (importOriginal) => {
  type Connect = (url: string, options?: postgres.Options<Record<string, never>>) => postgres.Sql;
  const actual = await importOriginal<{ default: Connect }>();
  const connect: Connect = (url, options) =>
    actual.default(url, {
      ...options,
      debug: (_connection, statement) => {
        counted.getStore()?.push(statement);
      }
    });
  return { ...actual, default: Object.assign(connect, actual.default) };
});

describe("server follow-up queue on Postgres", () => {
  // One race proof here; five further scheduling repetitions run in the scale suite.
  it.each([1])(
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
      authorUserId: f.other.id,
      authorDisplayLabel: "other"
    });
    expect((await f.messages()).map((message) => message.text)).toEqual(["First"]);
    const snapshot = await f.app.call("conversations.thread.get", {
      params: { conversationId: f.scope.conversationId }
    });
    expect(snapshot.statusCode, snapshot.body).toBe(200);
    expect(snapshot.json()).toMatchObject({
      followUps: [{ id: item.id, authorUserId: f.other.id, authorDisplayLabel: "other" }]
    });
    const observations = await f.app.stores.agentRuns.listRunObservations({
      clientInstanceId: f.scope.clientInstanceId,
      runId: asAgentRunId(f.first.run.id)
    });
    expect(observations.find((event) => event.type === "follow_up_changed")?.payload).toMatchObject(
      { followUp: { id: item.id, authorDisplayLabel: "other" } }
    );
    const stored = await withTestSql(
      (sql) => sql<{ payload: { followUp: ConversationFollowUp } }[]>`
      select payload from agent_run_observations
      where run_id = ${f.first.run.id} and type = 'follow_up_changed'
    `
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.payload.followUp).toMatchObject({ id: item.id, authorUserId: f.other.id });
    expect(stored[0]?.payload.followUp).not.toHaveProperty("authorDisplayLabel");
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

  it("resolves current names in one query per observation batch, preserving historical queue state", async () => {
    const f = await fixture(true);
    const item = await f.queue("Original", "other");
    const read = async (limit: number, afterSequence = 0) => {
      const statements: string[] = [];
      const observations = await counted.run(statements, () =>
        f.app.stores.agentRuns.listRunObservations({
          clientInstanceId: f.scope.clientInstanceId,
          runId: asAgentRunId(f.first.run.id),
          limit,
          afterSequence
        })
      );
      return {
        observations,
        count: statements.filter((sql) => !sql.includes("pg_catalog.pg_type")).length
      };
    };
    expect((await read(1)).count).toBe(2);
    await f.app.stores.followUps.cancel({ ...f.scope, followUpId: item.id });
    for (let index = 0; index < 10; index++) await f.queue(`Queued ${index}`, "other");
    await withTestSql(
      (sql) =>
        sql`update product_users set display_label = 'Renamed member' where id = ${f.other.id}`
    );
    const batch = await read(12);
    expect(batch.count).toBe(2);
    expect(batch.observations).toHaveLength(12);
    expect(batch.observations[0]?.payload).toMatchObject({
      followUp: { id: item.id, status: "pending", authorDisplayLabel: "Renamed member" }
    });
    expect(batch.observations[1]?.payload).toMatchObject({
      followUp: { id: item.id, status: "cancelled", authorDisplayLabel: "Renamed member" }
    });
    expect((await read(12, required(batch.observations.at(-1)).sequence)).count).toBe(1);
  });

  it.each(["disabled", "deleting", "missing", "removed", "private"])(
    "omits the %s author's label from the queue and completed run replay",
    async (status) => {
      const f = await fixture();
      const item = await f.queue("Keep this queued", "other");
      await f.complete();
      const before = await drainRunEvents(f.app, f.scope.conversationId, f.first.run.id);
      expect(before).toContain('"authorDisplayLabel":"other"');
      await withTestSql(async (sql) => {
        if (status === "missing") {
          await sql`delete from collaboration_workspace_memberships where user_id = ${f.other.id}`;
          await sql`delete from collaboration_workspaces where personal_user_id = ${f.other.id}`;
          await sql`delete from product_users where id = ${f.other.id}`;
        } else if (status === "private") {
          await sql`update conversations set visibility = 'private' where id = ${f.scope.conversationId}`;
        } else if (status === "removed") {
          await sql`delete from collaboration_workspace_memberships where collaboration_workspace_id = ${f.workspace.id} and user_id = ${f.other.id}`;
        } else if (status === "deleting") {
          await sql`update product_users set deletion_requested_at = now() where id = ${f.other.id}`;
        } else {
          await sql`update product_users set status = ${status} where id = ${f.other.id}`;
        }
      });
      const snapshot = await f.app.call("conversations.thread.get", {
        params: { conversationId: f.scope.conversationId }
      });
      expect(snapshot.statusCode, snapshot.body).toBe(200);
      const pending = snapshot.json<{ followUps: ConversationFollowUp[] }>().followUps;
      expect(pending).toMatchObject([{ id: item.id, authorUserId: f.other.id }]);
      expect(required(pending[0]).authorDisplayLabel).toBeUndefined();
      expect(required(pending[0])).not.toHaveProperty("email");
      const replay = await drainRunEvents(f.app, f.scope.conversationId, f.first.run.id);
      expect(replay).toContain('"type":"follow_up_changed"');
      expect(replay).toContain(item.id);
      expect(replay).not.toContain("authorDisplayLabel");
      expect(replay).not.toContain("other@example.test");
    }
  );

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

  it("FU-2 dispatches different authors as three turns in order", async () => {
    const f = await fixture();
    const items = [await f.queue("One"), await f.queue("Two", "other"), await f.queue("Three")];
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

  it("FU-4 refuses Send now by a non-author and leaves the paused queue unchanged", async () => {
    const f = await fixture();
    const item = await f.queue("Only my author may send me");
    await f.fail();
    await f.dispatch();
    const refused = await f.app.call(
      "conversations.follow_ups.dispatch",
      { params: { conversationId: f.scope.conversationId }, payload: {} },
      "other"
    );
    expect(refused.statusCode, refused.body).toBe(403);
    await f.dispatch();
    expect(await f.pending()).toMatchObject([{ id: item.id, status: "pending" }]);
    expect((await f.messages()).map((message) => message.text)).toEqual(["First"]);
  });

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
    // The process logger the instance writes to.
    const warn = vi.spyOn(createLogger(), "warn");
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
    // Never in silence: the withdrawal is logged with its code, and without the message.
    expect(warn).toHaveBeenCalledWith(
      {
        conversationId: f.scope.conversationId,
        followUpId: lost.id,
        errorCode: "NOT_FOUND",
        step: "access",
        outcome: "cancelled"
      },
      "Queued follow-up was refused at dispatch"
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("No longer allowed");
    warn.mockRestore();
  });

  it("FU-6 keeps a follow-up queued and logs the refusal when its start is refused", async () => {
    const f = await fixture();
    const kept = await f.queue("Agent went away", "other");
    // An admin withdraws the agent from this workspace. The default agent stays available
    // everywhere, so another agent becomes the default first.
    await applyAtCurrentRevisions(f.app.stores.configAssets, {
      clientInstanceId: f.scope.clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: "other_agent",
          config: {
            skillNames: [],
            name: "other_agent",
            displayName: "Other Agent",
            instructions: "Answer briefly.",
            modelProviderId: "local",
            toolNames: [],
            initialPrompts: []
          }
        },
        { type: "setDefaultAgent", agentName: "other_agent" }
      ]
    });
    await f.app.stores.configAssets.setAgentAvailability({
      clientInstanceId: f.scope.clientInstanceId,
      agentName: kept.agentName,
      availability: { mode: "selected", personalWorkspaces: true, collaborationWorkspaceIds: [] }
    });
    // The process logger the instance writes to.
    const warn = vi.spyOn(createLogger(), "warn");
    await f.complete();
    await f.dispatch();
    // Still in the queue that every member sees, paused, for its author to send or remove.
    expect(await f.pending()).toMatchObject([{ id: kept.id, status: "pending" }]);
    expect(
      (await f.messages())
        .filter((message) => message.role === "user")
        .map((message) => message.text)
    ).toEqual(["First"]);
    const thread = await f.app.call(
      "conversations.thread.get",
      { params: { conversationId: f.scope.conversationId } },
      "other"
    );
    expect(thread.json()).toMatchObject({ followUps: [{ id: kept.id }] });
    expect(warn).toHaveBeenCalledWith(
      {
        conversationId: f.scope.conversationId,
        followUpId: kept.id,
        errorCode: "NOT_FOUND",
        step: "start",
        outcome: "kept_pending"
      },
      "Queued follow-up was refused at dispatch"
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Agent went away");
    warn.mockRestore();
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
      { followUp: "interrupt", message: { text: "Wrong mode" } },
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
