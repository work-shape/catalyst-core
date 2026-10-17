import { describe, expect, it } from "vitest";
import type { ConversationId, PlatformStores } from "@work-shape/catalyst-core";
import { orderedStoreCalls } from "./support/postgres-concurrency-harness";
import { usePostgresSuite } from "./support/postgres-suite";
import { createSubagentFixture } from "./support/subagent-runs";

describe("Postgres run threads of a chat conversation", () => {
  const db = usePostgresSuite("threads");

  /** A conversation whose claimed run started two subagents, each in its own thread. */
  async function arrangeThreads(label: string, retainedUntil?: string) {
    const fixture = await createSubagentFixture(db, label);
    const root = await fixture.createConversation("split the report", { retainedUntil });
    const parent = await fixture.startParent(root);
    const first = await fixture.startChild(parent.run, "first half");
    const last = await fixture.startChild(parent.run, "second half");
    return { fixture, root, parent, first, last };
  }

  it("moves the threads with their root in the same statement", async () => {
    const { fixture, root, first, last } = await arrangeThreads("move");
    const shared = await fixture.createSharedWorkspace("Reports");

    await expect(
      db.store.conversations.moveConversation({
        ...fixture.scope,
        conversationId: root.id,
        fromCollaborationWorkspaceId: fixture.workspace.id,
        toCollaborationWorkspaceId: shared.id,
        visibility: "workspace"
      })
    ).resolves.toMatchObject({ id: root.id, collaborationWorkspaceId: shared.id });
    for (const thread of [first.threadId, last.threadId]) {
      await expect(
        db.store.conversations.getConversation(fixture.clientInstanceId, thread)
      ).resolves.toMatchObject({
        kind: "run_thread",
        parentConversationId: root.id,
        collaborationWorkspaceId: shared.id,
        visibility: "workspace"
      });
    }

    // A thread moves only with its root.
    await expect(
      db.store.conversations.moveConversation({
        ...fixture.scope,
        conversationId: first.threadId,
        fromCollaborationWorkspaceId: shared.id,
        toCollaborationWorkspaceId: fixture.workspace.id,
        visibility: "workspace"
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      db.store.conversations.getConversation(fixture.clientInstanceId, first.threadId)
    ).resolves.toMatchObject({ collaborationWorkspaceId: shared.id });
  });

  // A Move and a subagent's start both hold the root conversation first, so a thread is never
  // left in the workspace its root was moved away from.
  function ordered<A, B>(first: (stores: PlatformStores) => Promise<A>, second: () => Promise<B>) {
    return orderedStoreCalls(
      db.sql,
      { first: db.store, firstName: db.first, secondName: db.second },
      first,
      second
    );
  }

  it("moves a thread whose subagent started while the move waited for the root", async () => {
    const { fixture, root, parent } = await arrangeThreads("start_then_move");
    const shared = await fixture.createSharedWorkspace("Started first");

    const [started, moved] = await ordered(
      (stores) => fixture.startChild(parent.run, "third part", stores),
      () =>
        db.secondStore.conversations.moveConversation({
          ...fixture.scope,
          conversationId: root.id,
          fromCollaborationWorkspaceId: fixture.workspace.id,
          toCollaborationWorkspaceId: shared.id,
          visibility: "workspace"
        })
    );

    expect(moved).toMatchObject({ status: "fulfilled" });
    if (started.status !== "fulfilled") throw new Error("The subagent was not started");
    await expect(
      db.store.conversations.getConversation(fixture.clientInstanceId, started.value.threadId)
    ).resolves.toMatchObject({ collaborationWorkspaceId: shared.id, visibility: "workspace" });
  });

  it("starts a subagent in the workspace its root was moved to while it waited", async () => {
    const { fixture, root, parent } = await arrangeThreads("move_then_start");
    const shared = await fixture.createSharedWorkspace("Moved first");

    const [moved, started] = await ordered(
      (stores) =>
        stores.conversations.moveConversation({
          ...fixture.scope,
          conversationId: root.id,
          fromCollaborationWorkspaceId: fixture.workspace.id,
          toCollaborationWorkspaceId: shared.id,
          visibility: "workspace"
        }),
      () => fixture.startChild(parent.run, "third part", db.secondStore)
    );

    expect(moved).toMatchObject({ status: "fulfilled" });
    if (started.status !== "fulfilled") throw new Error("The subagent was not started");
    await expect(
      db.store.conversations.getConversation(fixture.clientInstanceId, started.value.threadId)
    ).resolves.toMatchObject({ collaborationWorkspaceId: shared.id, visibility: "workspace" });
  });

  it("refuses to delete a thread alone and deletes the threads with their root", async () => {
    const { fixture, root, first, last } = await arrangeThreads("delete");
    const deletedAt = new Date().toISOString();

    await expect(
      db.store.conversations.deleteConversation({
        ...fixture.scope,
        conversationId: first.threadId,
        deletedAt
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(fixture.conversationStatusOf(first.threadId)).resolves.toBe("active");

    await expect(
      db.store.conversations.deleteConversation({
        ...fixture.scope,
        conversationId: root.id,
        deletedAt
      })
    ).resolves.toMatchObject({ id: root.id, status: "deleted" });
    await expect(fixture.conversationStatusOf(root.id)).resolves.toBe("deleted");
    for (const thread of [first.threadId, last.threadId]) {
      await expect(fixture.conversationStatusOf(thread)).resolves.toBe("deleted");
      // The claim removed each thread's transcript, its task first of all.
      await expect(
        db.sql`select count(*)::int as count from messages where conversation_id = ${thread}`
      ).resolves.toEqual([{ count: 0 }]);
    }
    // The cleanup that follows still finds the threads of the deleted root.
    expect(
      sorted(
        await db.store.childAgentRuns.listRunThreadIds({
          ...fixture.scope,
          rootConversationId: root.id
        })
      )
    ).toEqual(sorted([first.threadId, last.threadId]));
  });

  it("never lists a thread in the conversations of a workspace", async () => {
    const { fixture, root, parent } = await arrangeThreads("lists");
    const list = (input: { lifecycle?: boolean; titleQuery?: string } = {}) =>
      db.store.conversations.listConversationsForWorkspace({
        ...fixture.scope,
        collaborationWorkspaceId: fixture.workspace.id,
        scope: input.lifecycle
          ? { kind: "lifecycle" }
          : { kind: "viewer", userId: fixture.user.id },
        ...(input.titleQuery === undefined ? {} : { titleQuery: input.titleQuery })
      });

    await expect(list()).resolves.toEqual([expect.objectContaining({ id: root.id })]);
    await expect(list({ lifecycle: true })).resolves.toEqual([
      expect.objectContaining({ id: root.id })
    ]);
    // A thread's title is its subagent's description; the title search does not find it.
    await expect(list({ titleQuery: "first half" })).resolves.toEqual([]);
    // The root's active run is the parent; a subagent runs in its thread.
    await expect(
      db.store.conversations.listConversationsWithActiveRun({
        ...fixture.scope,
        collaborationWorkspaceId: fixture.workspace.id,
        scope: { kind: "viewer", userId: fixture.user.id }
      })
    ).resolves.toEqual([
      expect.objectContaining({
        id: root.id,
        activeRun: expect.objectContaining({ id: parent.run.id })
      })
    ]);
  });

  it("never expires a thread alone and keeps the root while a thread's run is in progress", async () => {
    const { fixture, root, parent, first, last } = await arrangeThreads(
      "expiry",
      "2024-01-01T00:00:00.000Z"
    );
    const criteria = { now: new Date().toISOString() };
    const listExpired = () =>
      db.store.conversations.listExpiredConversations({ ...fixture.scope, ...criteria, limit: 10 });
    const expire = (target: ConversationId) =>
      db.store.conversations.expireConversation({
        ...fixture.scope,
        conversationId: target,
        expiredAt: criteria.now,
        ...criteria
      });
    // One subagent is running; the parent's end asks it to cancel and it is still in progress
    // until its worker stops. The other, never claimed, ends at once.
    const running = await fixture.claim(first.run);
    await fixture.end(db.store, parent.run, "completed");
    await expect(fixture.statusOf(running.run)).resolves.toBe("cancelling");
    await expect(fixture.statusOf(last.run)).resolves.toBe("cancelled");

    await expect(listExpired()).resolves.toEqual([]);
    await expect(expire(root.id)).resolves.toEqual({ status: "not_expired" });
    await expect(expire(first.threadId)).resolves.toEqual({ status: "not_expired" });
    await expect(expire(last.threadId)).resolves.toEqual({ status: "not_expired" });

    await fixture.end(db.store, running.run, "cancelled");
    // The threads carry the root's retention date, and still only the root is due.
    await expect(listExpired()).resolves.toEqual([expect.objectContaining({ id: root.id })]);
    await expect(expire(last.threadId)).resolves.toEqual({ status: "not_expired" });
    await expect(fixture.conversationStatusOf(last.threadId)).resolves.toBe("active");
    await expect(expire(root.id)).resolves.toMatchObject({
      status: "expired",
      reason: "retention_due"
    });
    for (const target of [root.id, first.threadId, last.threadId]) {
      await expect(fixture.conversationStatusOf(target)).resolves.toBe("retention_expired");
    }
  });

  it("lists the threads of a root and its runs in progress parent first", async () => {
    const { fixture, root, parent, first, last } = await arrangeThreads("runs");
    // A run of another conversation is not one of them.
    const other = await fixture.createConversation("another");
    await fixture.startParent(other);

    expect(
      sorted(
        await db.store.childAgentRuns.listRunThreadIds({
          ...fixture.scope,
          rootConversationId: root.id
        })
      )
    ).toEqual(sorted([first.threadId, last.threadId]));
    await expect(
      db.store.childAgentRuns.listRunThreadIds({ ...fixture.scope, rootConversationId: other.id })
    ).resolves.toEqual([]);

    const runs = await db.store.agentRuns.listAgentRunsInProgress({
      ...fixture.scope,
      rootConversationId: root.id
    });
    expect(runs.map((run) => run.id)[0]).toBe(parent.run.id);
    expect(sorted(runs.slice(1).map((run) => run.id))).toEqual(sorted([first.run.id, last.run.id]));
  });
});

function sorted<T extends string>(values: readonly T[]): T[] {
  return [...values].sort();
}
