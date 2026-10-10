import { describe, expect, it } from "vitest";
import { asUserId } from "@vivd-catalyst/core";
import { arrangeDeletion } from "./support/deletion-fixture";
import { usePostgresSuite } from "./support/postgres-suite";

describe("a subject in deletion stays closed and loses only what is its own", () => {
  const db = usePostgresSuite("deletioncloses");

  // Fails without the change: the Conversation was erased in the workspace it had moved to.
  it("leaves a conversation that was moved away between the check and the delete", async () => {
    const t = await arrangeDeletion(db, "moved");
    const owner = await t.createUser("owner");
    const workspace = await t.createSharedWorkspace(owner, "Shared");
    const other = await t.createSharedWorkspace(owner, "Other");
    const stays = await t.createConversation(owner, "stays", { workspace });
    const staysData = await t.createObjects(stays);
    const moved = await t.createConversation(owner, "moved", { workspace });
    const movedData = await t.createObjects(moved);
    const attachments = t.options.attachments;
    if (!attachments) throw new Error("The fixture has no attachment service");
    const listDraftAttachments = attachments.listDraftAttachments.bind(attachments);
    let checks = 0;
    // The deletion reads the Conversation, checks that it is idle, then deletes it. The idle
    // check asks for draft attachments: the first time before the mark, the second time in
    // the pass. The move lands there, after the read and before the delete.
    attachments.listDraftAttachments = async (conversationId) => {
      if (conversationId === moved.id && (checks += 1) === 2) {
        await db.store.conversations.moveConversation({
          ...t.scope,
          conversationId: moved.id,
          fromCollaborationWorkspaceId: workspace.id,
          toCollaborationWorkspaceId: other.id,
          visibility: "workspace"
        });
      }
      return listDraftAttachments(conversationId);
    };

    const deleted = await t.api.call(
      "workspaces.delete",
      {
        params: { collaborationWorkspaceId: workspace.id },
        payload: { confirmName: workspace.name }
      },
      owner.id
    );
    expect(deleted.statusCode).toBe(200);
    expect(checks).toBe(2);

    await expect(t.rowsOf(workspace)).resolves.toMatchObject({ workspaces: 0, conversations: 0 });
    expect(t.byteStore.has(staysData.artifact.objectKey)).toBe(false);
    await expect(t.statusOf(moved)).resolves.toBe("active");
    await expect(t.rowsOf(other)).resolves.toMatchObject({ conversations: 1, artifacts: 1 });
    expect(t.byteStore.has(movedData.file.objectKey)).toBe(true);
    expect(t.byteStore.has(movedData.artifact.objectKey)).toBe(true);
  });

  // Fails without the change: the runs went on and the worker's message was stored.
  it("stops the runs of a user being deleted and refuses what a worker writes back", async () => {
    const t = await arrangeDeletion(db, "account_runs");
    const superadmin = await t.createUser("superadmin", ["user", "admin", "superadmin"]);
    const leaving = await t.createUser("leaving");
    const workspace = await t.createSharedWorkspace(superadmin, "Shared");
    await db.store.workspaces.addMembership({
      ...t.scope,
      collaborationWorkspaceId: workspace.id,
      userId: asUserId(leaving.id),
      role: "member"
    });
    const running = await t.startRun(
      await t.createConversation(superadmin, "running", { workspace }),
      leaving
    );
    await t.claimRun("lease-running");
    const queued = await t.startRun(
      await t.createConversation(superadmin, "queued", { workspace }),
      leaving
    );
    await expect(t.workerMessage(running, "lease-running")).resolves.toMatchObject({
      text: "written back"
    });

    // A run that has not ended holds the user row, so the request cannot finish itself.
    const accepted = await t.api.call("me.delete", {}, leaving.id);
    expect(accepted.statusCode).toBe(202);
    await expect(t.runStatus(queued)).resolves.toBe("cancelled");
    await expect(t.runStatus(running)).resolves.toBe("cancelling");
    await expect(t.workerMessage(running, "lease-running")).rejects.toMatchObject({
      code: "CONFLICT"
    });
    await t.runDeletionJobs();
    await expect(t.userRow(leaving)).resolves.toEqual([{ marked: true }]);

    await t.endCancelledRun(running);
    await t.runDeletionJobs();
    await expect(t.userRow(leaving)).resolves.toEqual([]);
    const messages = await db.store.conversations.listMessages({
      ...t.scope,
      conversationId: running.conversationId
    });
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1);
  });

  // Fails without the change: the run was left alone and its message was stored.
  it("stops the runs in a workspace being deleted and refuses what a worker writes back", async () => {
    const t = await arrangeDeletion(db, "workspace_runs");
    const owner = await t.createUser("owner");
    const workspace = await t.createSharedWorkspace(owner, "Shared");
    const conversation = await t.createConversation(owner, "running", { workspace });
    const run = await t.startRun(conversation, owner);
    await t.claimRun("lease-workspace");
    const deleteWorkspace = () =>
      t.api.call(
        "workspaces.delete",
        {
          params: { collaborationWorkspaceId: workspace.id },
          payload: { confirmName: workspace.name }
        },
        owner.id
      );
    // A request refuses a workspace with a run in progress. This run began after that check.
    expect((await deleteWorkspace()).statusCode).toBe(409);
    await db.store.workspaces.markWorkspaceDeletionRequested({
      ...t.scope,
      collaborationWorkspaceId: workspace.id
    });
    await expect(t.workerMessage(run, "lease-workspace")).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Conversation no longer accepts messages"
    });

    expect((await deleteWorkspace()).statusCode).toBe(202);
    await t.runDeletionJobs();
    await expect(t.runStatus(run)).resolves.toBe("cancelling");
    await expect(t.rowsOf(workspace)).resolves.toMatchObject({ workspaces: 1 });

    await t.endCancelledRun(run);
    await t.runDeletionJobs();
    await expect(t.rowsOf(workspace)).resolves.toMatchObject({ workspaces: 0, conversations: 0 });
  });

  // Fails without the change: the message of the marked user's run was stored. The last
  // lines hold already: a deleted Conversation takes its runs with it, so the hold is gone.
  it("refuses a worker's message once the owner of the run is being deleted", async () => {
    const t = await arrangeDeletion(db, "marked_owner");
    const author = await t.createUser("author");
    const conversation = await t.createConversation(author, "open");
    const run = await t.startRun(conversation, author);
    await t.claimRun("lease-owner");
    await db.store.users.markUserDeletionRequested({ ...t.scope, userId: asUserId(author.id) });

    await expect(t.workerMessage(run, "lease-owner")).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Conversation no longer accepts messages"
    });
    await expect(t.runStatus(run)).resolves.toBe("running");

    await db.store.conversations.deleteConversation({
      ...t.scope,
      conversationId: conversation.id,
      deletedAt: new Date().toISOString()
    });
    await expect(t.runStatus(run)).resolves.toBeUndefined();
    await expect(t.workerMessage(run, "lease-owner")).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Agent run lease is no longer active"
    });
  });

  // Fails without the change: the update was accepted.
  it("refuses an administrator who changes a user being deleted", async () => {
    const t = await arrangeDeletion(db, "admin_update");
    const superadmin = await t.createUser("superadmin", ["user", "admin", "superadmin"]);
    const removed = await t.createUser("removed");
    await db.store.users.markUserDeletionRequested({ ...t.scope, userId: asUserId(removed.id) });

    const update = await t.api.call(
      "users.update",
      { params: { userId: removed.id }, payload: { displayLabel: "Back again", status: "active" } },
      superadmin.id
    );
    expect(update.statusCode).toBe(409);
    expect(update.json()).toMatchObject({
      error: { code: "CONFLICT", message: "User account is being deleted" }
    });
    const identity = await t.api.call(
      "users.identities.upsert",
      {
        params: { userId: removed.id },
        payload: { authSource: "development", externalUserId: "another", displayLabel: "Another" }
      },
      superadmin.id
    );
    expect(identity.statusCode).toBe(409);
    await expect(t.userRow(removed)).resolves.toEqual([{ marked: true }]);
    expect((await t.signedIn(removed)).statusCode).toBe(401);
  });

  // Fails without the change: the second pass removed the user while the objects were left.
  it("keeps the user until the data of their private conversation elsewhere is gone", async () => {
    const t = await arrangeDeletion(db, "private_elsewhere");
    const superadmin = await t.createUser("superadmin", ["user", "admin", "superadmin"]);
    const leaving = await t.createUser("leaving");
    const workspace = await t.createSharedWorkspace(superadmin, "Shared");
    await db.store.workspaces.addMembership({
      ...t.scope,
      collaborationWorkspaceId: workspace.id,
      userId: asUserId(leaving.id),
      role: "member"
    });
    const conversation = await db.store.conversations.createConversation({
      ...t.scope,
      visibility: "private",
      collaborationWorkspaceId: workspace.id,
      createdByUserId: leaving.id,
      createdByExternalUserId: leaving.externalUserId,
      title: "private in a shared workspace",
      retainedUntil: "2999-01-01T00:00:00.000Z"
    });
    const data = await t.createObjects(conversation);

    t.byteStore.failDeletes = true;
    expect((await t.api.call("me.delete", {}, leaving.id)).statusCode).toBe(202);
    for (let pass = 0; pass < 2; pass += 1) {
      await t.runDeletionJobs();
      await expect(t.userRow(leaving)).resolves.toEqual([{ marked: true }]);
      await expect(t.statusOf(conversation)).resolves.toBe("deleted");
      expect(t.byteStore.has(data.file.objectKey)).toBe(true);
      expect(t.byteStore.has(data.artifact.objectKey)).toBe(true);
    }
    await expect(t.jobs()).resolves.toEqual([
      { kind: "account.delete", status: "queued", attempts: 2 }
    ]);

    t.byteStore.failDeletes = false;
    await t.runDeletionJobs();
    await expect(t.userRow(leaving)).resolves.toEqual([]);
    expect(t.byteStore.keys()).toEqual([]);
  });

  // Fails without the change: the demotion never waited, and both were accepted.
  it("accepts one of a demotion and the deletion of the other owner at the same moment", async () => {
    const t = await arrangeDeletion(db, "demotion");
    const superadmin = await t.createUser("superadmin", ["user", "admin", "superadmin"]);
    const first = await t.createUser("first-owner");
    const second = await t.createUser("second-owner");
    const workspace = await t.createSharedWorkspace(first, "Shared");
    await db.store.workspaces.addMembership({
      ...t.scope,
      collaborationWorkspaceId: workspace.id,
      userId: asUserId(second.id),
      role: "owner"
    });
    // Both requests are held at the workspace, so neither has judged yet.
    const held = await db.hold(
      (tx) => tx`select id from collaboration_workspaces where id = ${workspace.id} for update`
    );
    const requests = [
      t.api.call("me.delete", {}, first.id),
      t.api.call(
        "workspaces.members.update_role",
        {
          params: { collaborationWorkspaceId: workspace.id, userId: second.id },
          payload: { role: "member" }
        },
        superadmin.id
      )
    ];
    await t.untilWaitingForLock(2);
    await held.commit();

    const answers = await Promise.all(requests);
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 409]);
    const users = await db.store.users.listUsers(t.scope);
    const activeIds = users.filter((user) => user.status === "active").map((user) => user.id);
    const memberships = await db.store.workspaces.listMemberships({
      ...t.scope,
      collaborationWorkspaceId: workspace.id
    });
    expect(
      memberships.filter(
        (membership) => membership.role === "owner" && activeIds.includes(membership.userId)
      )
    ).toHaveLength(1);
  });
});
