import { describe, expect, it } from "vitest";
import {
  ConversationRetentionWorkflow,
  ExecutionWorkspaceCleanupWorkflow
} from "@vivd-catalyst/chat-server";
import { asUserId, type AuthenticatedUser, type Conversation } from "@vivd-catalyst/core";
import { createConversationCleanupFixture } from "./support/conversation-cleanup-fixture";
import { usePostgresSuite } from "./support/postgres-suite";
import { getTestJobs } from "./support/test-instance";

describe("Postgres hard deletes while conversation cleanup is pending", () => {
  const db = usePostgresSuite("cleanupguard");
  /** One attempt of the queued deletion jobs of a client instance, without their backoff. */
  const runDeletionJobs = async (
    api: Parameters<typeof getTestJobs>[0],
    clientInstanceId: string
  ) => {
    await db.sql`
      update platform_jobs set run_after = now()
      where client_instance_id = ${clientInstanceId} and status = 'queued'
        and kind in ('account.delete', 'workspace.delete')`;
    await getTestJobs(api).runDue();
  };

  it("keeps a shared workspace in deletion while its conversations' data is still there", async () => {
    const fixture = await createConversationCleanupFixture(db, "workspace_deletion");
    const owner = await fixture.createUser("owner");
    const workspace = await fixture.createSharedWorkspace(owner, "Shared");
    const first = await fixture.createConversation(owner, "first", { workspace });
    const second = await fixture.createConversation(owner, "second", { workspace });
    const firstObjects = await fixture.createObjects(first);
    await fixture.createObjects(second);
    await fixture.createWorkspaceData(first);
    const api = await fixture.api();
    const deleteWorkspace = () =>
      api.call(
        "workspaces.delete",
        {
          params: { collaborationWorkspaceId: workspace.id },
          payload: { confirmName: workspace.name }
        },
        owner.id
      );

    fixture.byteStore.failDeletes = true;
    const accepted = await deleteWorkspace();
    expect(accepted.statusCode).toBe(202);
    // The Conversations are deleted, and every row that leads to their data is still there.
    await expect(fixture.statusOf(first)).resolves.toBe("deleted");
    await expect(fixture.statusOf(second)).resolves.toBe("deleted");
    await expect(fixture.rowsOf(workspace)).resolves.toEqual({
      workspaces: 1,
      conversations: 2,
      artifacts: 2,
      executionWorkspaces: 1
    });
    expect(fixture.byteStore.has(firstObjects.artifact.objectKey)).toBe(true);
    await expect(fixture.eventsOfType("collaboration_workspace.deleted")).resolves.toEqual([]);
    await runDeletionJobs(api, fixture.clientInstanceId);
    await expect(fixture.rowsOf(workspace)).resolves.toMatchObject({
      workspaces: 1,
      conversations: 2
    });

    fixture.byteStore.failDeletes = false;
    await runDeletionJobs(api, fixture.clientInstanceId);

    await expect(fixture.rowsOf(workspace)).resolves.toEqual({
      workspaces: 0,
      conversations: 0,
      artifacts: 0,
      executionWorkspaces: 0
    });
    expect(fixture.byteStore.keys()).toEqual([]);
    await expect(fixture.eventsOfType("collaboration_workspace.deleted")).resolves.toHaveLength(1);
  });

  it("keeps the row of an account in deletion while its conversations' data is still there", async () => {
    const fixture = await createConversationCleanupFixture(db, "account_deletion");
    const superadmin = await fixture.createUser("superadmin", ["user", "admin", "superadmin"]);
    const removedUser = await fixture.createUser("removed-user");
    const leavingUser = await fixture.createUser("leaving-user");
    const joined = await fixture.createSharedWorkspace(superadmin, "Joined");
    const requested = await fixture.createSharedWorkspace(superadmin, "Requested");
    const accounts: Array<{
      user: AuthenticatedUser;
      conversation: Conversation;
      data: Awaited<ReturnType<typeof fixture.createData>>;
    }> = [];
    for (const user of [removedUser, leavingUser]) {
      const userId = asUserId(user.id);
      await db.store.workspaces.addMembership({
        ...fixture.scope,
        collaborationWorkspaceId: joined.id,
        userId,
        role: "member"
      });
      await db.store.workspaces.createAccessRequest({
        ...fixture.scope,
        collaborationWorkspaceId: requested.id,
        userId
      });
      const conversation = await fixture.createConversation(user, `of ${user.displayLabel}`);
      accounts.push({ user, conversation, data: await fixture.createData(conversation) });
    }
    // The status of the Conversation an object belongs to, at the moment its deletion is asked for.
    const statusAtDeletion = new Map<string, string | undefined>();
    fixture.byteStore.onDeleteAttempt = async (key) => {
      const owner = accounts.find((account) => key.includes(account.conversation.id));
      statusAtDeletion.set(key, owner && (await fixture.statusOf(owner.conversation)));
    };
    const api = await fixture.api();
    const deleteAccounts = async () => [
      await api.call("users.delete", { params: { userId: removedUser.id } }, superadmin.id),
      await api.call("me.delete", {}, leavingUser.id)
    ];
    const memberIds = async () =>
      (
        await db.store.workspaces.listMemberships({
          ...fixture.scope,
          collaborationWorkspaceId: joined.id
        })
      )
        .map((membership) => membership.userId)
        .sort();
    const requesterIds = async () =>
      (
        await db.store.workspaces.listAccessRequestsForWorkspace({
          ...fixture.scope,
          collaborationWorkspaceId: requested.id
        })
      )
        .map((request) => request.userId)
        .sort();
    const userIds = async () =>
      (await db.store.users.listUsers(fixture.scope)).map((user) => user.id).sort();
    const everyone = [superadmin.id, removedUser.id, leavingUser.id].sort();

    fixture.byteStore.failDeletes = true;
    for (const accepted of await deleteAccounts()) {
      expect(accepted.statusCode).toBe(202);
    }
    // The claim came before the first object was touched.
    expect(statusAtDeletion.size).toBeGreaterThanOrEqual(2);
    expect([...new Set(statusAtDeletion.values())]).toEqual(["deleted"]);
    // Each account still has its row and its Personal Workspace. Its Conversations are deleted
    // and not removed, and it is no longer a member or a requester anywhere.
    await expect(userIds()).resolves.toEqual(everyone);
    await expect(memberIds()).resolves.toEqual([superadmin.id]);
    await expect(requesterIds()).resolves.toEqual([]);
    for (const { user, conversation, data } of accounts) {
      await expect(fixture.statusOf(conversation)).resolves.toBe("deleted");
      await fixture.expectDataLeft(conversation, data);
      await expect(fixture.rowsOf(await fixture.personalWorkspaceOf(user))).resolves.toEqual({
        workspaces: 1,
        conversations: 1,
        artifacts: 1,
        executionWorkspaces: 0
      });
      await expect(
        fixture.auditEvents("conversation.cleanup_failed", conversation)
      ).resolves.toHaveLength(1);
    }
    await expect(fixture.eventsOfType("user.deleted")).resolves.toEqual([]);
    await runDeletionJobs(api, fixture.clientInstanceId);
    await expect(userIds()).resolves.toEqual(everyone);

    fixture.byteStore.failDeletes = false;
    await runDeletionJobs(api, fixture.clientInstanceId);

    await expect(userIds()).resolves.toEqual([superadmin.id]);
    await expect(memberIds()).resolves.toEqual([superadmin.id]);
    await expect(requesterIds()).resolves.toEqual([]);
    expect(fixture.byteStore.keys()).toEqual([]);
    for (const { conversation } of accounts) {
      await expect(fixture.statusOf(conversation)).resolves.toBeUndefined();
    }
    await expect(fixture.eventsOfType("user.deleted")).resolves.toHaveLength(2);
  });

  it("keeps a workspace whose expired conversation still waits for its cleanup", async () => {
    const fixture = await createConversationCleanupFixture(db, "expired_blocks");
    const owner = await fixture.createUser("owner");
    const workspace = await fixture.createSharedWorkspace(owner, "Shared");
    const conversation = await fixture.createConversation(owner, "due", {
      workspace,
      retainedUntil: "2024-01-01T00:00:00.000Z"
    });
    await fixture.createData(conversation);
    const workflow = new ConversationRetentionWorkflow(fixture.options);
    const deleteWorkspace = () =>
      db.store.workspaces.deleteWorkspace({
        ...fixture.scope,
        collaborationWorkspaceId: workspace.id
      });

    fixture.byteStore.failDeletes = true;
    await expect(workflow.expireDueConversations()).resolves.toMatchObject({
      expiredCount: 1,
      cleanupPendingCount: 1
    });
    fixture.byteStore.failDeletes = false;

    // Nothing fails in this request. The workspace holds no active Conversation.
    await expect(deleteWorkspace()).rejects.toMatchObject({
      code: "CONFLICT",
      details: { pendingCleanupCount: 1 }
    });
    await expect(fixture.rowsOf(workspace)).resolves.toEqual({
      workspaces: 1,
      conversations: 1,
      artifacts: 1,
      executionWorkspaces: 0
    });

    await expect(workflow.cleanUpPendingConversations()).resolves.toEqual({
      completedCount: 1,
      cleanupPendingCount: 0
    });
    await expect(deleteWorkspace()).resolves.toMatchObject({ id: workspace.id });
    await expect(fixture.rowsOf(workspace)).resolves.toMatchObject({
      workspaces: 0,
      conversations: 0
    });
    expect(fixture.byteStore.keys()).toEqual([]);
  });

  it("keeps a personal workspace while execution workspace data alone is left", async () => {
    const fixture = await createConversationCleanupFixture(db, "workspace_data_blocks");
    const author = await fixture.createUser("author");
    const conversation = await fixture.createConversation(author, "with a workspace");
    const workspaceData = await fixture.createWorkspaceData(conversation);
    const personalWorkspace = await fixture.personalWorkspaceOf(author);
    const deletePersonalWorkspace = () =>
      db.store.workspaces.deletePersonalWorkspaceForUser({
        ...fixture.scope,
        userId: asUserId(author.id)
      });
    const api = await fixture.api();

    // The Conversation has no file or artifact, so only the workspace cleanup can fail.
    fixture.byteStore.failNextDeleteFor(workspaceData.objectKey);
    const deletion = await api.call(
      "conversations.delete",
      { params: { conversationId: conversation.id } },
      author.id
    );
    expect(deletion.statusCode).toBe(200);
    await expect(fixture.auditEvents("conversation.deleted", conversation)).resolves.toEqual([
      expect.objectContaining({ metadata: { cleanup: "pending" } })
    ]);
    await expect(fixture.pending()).resolves.toEqual([]);

    await expect(deletePersonalWorkspace()).rejects.toMatchObject({
      code: "CONFLICT",
      details: { pendingCleanupCount: 1 }
    });
    await expect(fixture.rowsOf(personalWorkspace)).resolves.toEqual({
      workspaces: 1,
      conversations: 1,
      artifacts: 0,
      executionWorkspaces: 1
    });
    expect(fixture.byteStore.has(workspaceData.objectKey)).toBe(true);

    await expect(
      new ExecutionWorkspaceCleanupWorkflow(fixture.options).cleanupDeletedConversationWorkspaces()
    ).resolves.toEqual({ cleanedCount: 1, failedCount: 0 });
    await expect(deletePersonalWorkspace()).resolves.toMatchObject({ id: personalWorkspace.id });
    await expect(fixture.rowsOf(personalWorkspace)).resolves.toMatchObject({
      workspaces: 0,
      conversations: 0
    });
    expect(fixture.byteStore.keys()).toEqual([]);
  });

  it("deletes an account in one request while a workspace command of it is still queued", async () => {
    const fixture = await createConversationCleanupFixture(db, "queued_command");
    const leavingUser = await fixture.createUser("leaving-user");
    const conversation = await fixture.createConversation(leavingUser, "with a queued command");
    const workspaceData = await fixture.createWorkspaceData(conversation);
    const personalWorkspace = await fixture.personalWorkspaceOf(leavingUser);
    // The workspace cleanup cancels a queued command and keeps its row for one more pass. The
    // row names no stored object, so it must not hold the account back.
    const command = await db.store.executionWorkspaces.enqueueWorkspaceCommand({
      ...fixture.scope,
      workspaceId: workspaceData.workspaceId,
      ownerUserId: leavingUser.id,
      command: "sleep 60",
      limits: {
        timeoutSeconds: 120,
        idleTimeoutSeconds: 120,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
        maxWorkspaceBytes: 1024 * 1024
      }
    });
    const api = await fixture.api();

    const deletion = await api.call("me.delete", {}, leavingUser.id);
    expect(deletion.statusCode).toBe(200);

    await expect(fixture.eventsOfType("user.deleted")).resolves.toHaveLength(1);
    await expect(fixture.rowsOf(personalWorkspace)).resolves.toMatchObject({
      workspaces: 0,
      conversations: 0
    });
    expect(fixture.byteStore.has(workspaceData.objectKey)).toBe(false);
    await expect(
      db.sql`select status from workspace_commands where id = ${command.id}`
    ).resolves.toEqual([]);
  });
});
