import { describe, expect, it } from "vitest";
import {
  CompositeAuthAdapter,
  HmacSessionTokenAuthAdapter,
  HmacSessionTokenIssuer,
  IdentityResolvingAuthAdapter,
  createStandaloneAuthRuntime,
  type AuthAdapter
} from "@vivd-catalyst/auth";
import { DELETION_MAX_ATTEMPTS } from "@vivd-catalyst/chat-server";
import { asUserId, type AuthenticatedUser, type UserRole } from "@vivd-catalyst/core";
import { createConversationCleanupFixture } from "./support/conversation-cleanup-fixture";
import { usePostgresSuite, type PostgresSuite } from "./support/postgres-suite";
import { createTestInstance, getTestJobs } from "./support/test-instance";

const DELETION_KINDS = ["account.delete", "workspace.delete"];

/**
 * The cleanup fixture with a server that resolves every request against the stored user, as an
 * instance does: a user who is closed in the database is refused whatever the request carries.
 */
async function arrange(db: PostgresSuite, label: string) {
  const fixture = await createConversationCleanupFixture(db, label);
  const known = new Map<string, AuthenticatedUser>();
  const headerAdapter: AuthAdapter = {
    id: "test-header",
    credentialMode: "ambient",
    async authenticate(request) {
      const header = request.headers["x-dev-user-id"];
      const user = known.get((Array.isArray(header) ? header[0] : header) ?? "");
      if (!user) throw new Error("The request names no known test user");
      return { ...user, scopes: ["*"] };
    }
  };
  const api = await createTestInstance({
    server: {
      ...fixture.options,
      authAdapter: new IdentityResolvingAuthAdapter(headerAdapter, db.store.users)
    }
  });
  const jobs = () =>
    db.sql<Array<{ kind: string; status: string; attempts: number }>>`
      select kind, status, attempts from platform_jobs
      where client_instance_id = ${fixture.clientInstanceId} and kind = any(${DELETION_KINDS})
      order by created_at, id`.then((rows) => rows.map((row) => ({ ...row })));
  return {
    ...fixture,
    api,
    jobs,
    async createUser(name: string, roles: UserRole[] = ["user"]) {
      const user = await fixture.createUser(name, roles);
      known.set(user.id, user);
      return user;
    },
    /** One attempt of every queued deletion job, without waiting for its backoff. */
    async runDeletionJobs() {
      await db.sql`
        update platform_jobs set run_after = now()
        where client_instance_id = ${fixture.clientInstanceId}
          and kind = any(${DELETION_KINDS}) and status = 'queued'`;
      await getTestJobs(api).runDue();
    },
    async userRow(user: AuthenticatedUser) {
      const rows = await db.sql<Array<{ marked: boolean }>>`
        select deletion_requested_at is not null as marked from product_users
        where id = ${user.id}`;
      return rows.map((row) => ({ ...row }));
    },
    signedIn: (user: AuthenticatedUser) => api.call("me.get", {}, user.id)
  };
}

describe("a deletion that finishes by itself", () => {
  const db = usePostgresSuite("deletionresumes");

  // Fails without the change: the request answered 409 and nothing took the deletion up.
  it("closes an account at once and removes it in its job when the object store fails", async () => {
    const t = await arrange(db, "account");
    const superadmin = await t.createUser("superadmin", ["user", "admin", "superadmin"]);
    const leaving = await t.createUser("leaving");
    const joined = await t.createSharedWorkspace(superadmin, "Joined");
    await db.store.workspaces.addMembership({
      ...t.scope,
      collaborationWorkspaceId: joined.id,
      userId: asUserId(leaving.id),
      role: "member"
    });
    const kept = await t.createConversation(superadmin, "kept", { workspace: joined });
    const keptData = await t.createData(kept);
    const conversation = await t.createConversation(leaving, "own");
    const data = await t.createData(conversation);
    const personalWorkspace = await t.personalWorkspaceOf(leaving);
    expect((await t.signedIn(leaving)).statusCode).toBe(200);

    t.byteStore.failDeletes = true;
    const accepted = await t.api.call("me.delete", {}, leaving.id);
    expect(accepted.statusCode).toBe(202);
    expect(accepted.body).toBe("");

    const refused = await t.signedIn(leaving);
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    await expect(t.userRow(leaving)).resolves.toEqual([{ marked: true }]);
    const listed = await t.api.call("users.list", {}, superadmin.id);
    expect(listed.json()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: leaving.id, status: "deleting" })
      ])
    });
    await t.expectDataLeft(conversation, data);
    // The request's own pass failed on the stored data. The person is listed nowhere already.
    await expect(
      db.store.workspaces.listMemberships({ ...t.scope, collaborationWorkspaceId: joined.id })
    ).resolves.toEqual([expect.objectContaining({ userId: superadmin.id })]);
    await expect(t.jobs()).resolves.toEqual([
      { kind: "account.delete", status: "queued", attempts: 0 }
    ]);
    await expect(t.eventsOfType("user.deletion_requested")).resolves.toEqual([
      expect.objectContaining({ subject: leaving.id, metadata: { requestedBy: "self" } })
    ]);

    await t.runDeletionJobs();
    await t.runDeletionJobs();
    await expect(t.jobs()).resolves.toEqual([
      { kind: "account.delete", status: "queued", attempts: 2 }
    ]);
    await expect(t.userRow(leaving)).resolves.toEqual([{ marked: true }]);

    t.byteStore.failDeletes = false;
    await t.runDeletionJobs();
    await expect(t.jobs()).resolves.toEqual([
      { kind: "account.delete", status: "succeeded", attempts: 3 }
    ]);
    await expect(t.userRow(leaving)).resolves.toEqual([]);
    await expect(t.rowsOf(personalWorkspace)).resolves.toEqual({
      workspaces: 0,
      conversations: 0,
      artifacts: 0,
      executionWorkspaces: 0
    });
    await t.expectDataRemoved(conversation, data);
    // What belongs to someone else stays.
    await t.expectDataLeft(kept, keptData);
    await expect(
      db.store.workspaces.listMemberships({ ...t.scope, collaborationWorkspaceId: joined.id })
    ).resolves.toEqual([expect.objectContaining({ userId: superadmin.id })]);
    await expect(t.eventsOfType("user.deleted")).resolves.toEqual([
      expect.objectContaining({ subject: leaving.id })
    ]);
    await expect(t.eventsOfType("user.deletion_stalled")).resolves.toEqual([]);
  });

  // Fails without the change: the request answered 409 and the workspace stayed open.
  it("closes a workspace at once and removes it in its job when the object store fails", async () => {
    const t = await arrange(db, "workspace");
    const owner = await t.createUser("owner");
    const workspace = await t.createSharedWorkspace(owner, "Shared");
    const other = await t.createSharedWorkspace(owner, "Other");
    const conversation = await t.createConversation(owner, "first", { workspace });
    const data = await t.createObjects(conversation);
    await t.createWorkspaceData(conversation);
    const kept = await t.createConversation(owner, "kept", { workspace: other });
    const keptData = await t.createObjects(kept);
    const deleteWorkspace = () =>
      t.api.call(
        "workspaces.delete",
        {
          params: { collaborationWorkspaceId: workspace.id },
          payload: { confirmName: workspace.name }
        },
        owner.id
      );

    t.byteStore.failDeletes = true;
    const accepted = await deleteWorkspace();
    expect(accepted.statusCode).toBe(202);
    expect(accepted.body).toBe("");

    const selector = await t.api.call("workspaces.list", {}, owner.id);
    expect(selector.statusCode).toBe(200);
    expect(selector.body).toContain(other.id);
    expect(selector.body).not.toContain(workspace.id);
    const read = await t.api.call(
      "workspaces.get",
      { params: { collaborationWorkspaceId: workspace.id } },
      owner.id
    );
    expect(read.statusCode).toBe(404);
    const thread = await t.api.call(
      "conversations.thread.get",
      { params: { conversationId: conversation.id } },
      owner.id
    );
    expect(thread.statusCode).toBe(404);
    await expect(t.rowsOf(workspace)).resolves.toMatchObject({ workspaces: 1 });

    await t.runDeletionJobs();
    await t.runDeletionJobs();
    await expect(t.jobs()).resolves.toEqual([
      { kind: "workspace.delete", status: "queued", attempts: 2 }
    ]);

    t.byteStore.failDeletes = false;
    await t.runDeletionJobs();
    await expect(t.jobs()).resolves.toEqual([
      { kind: "workspace.delete", status: "succeeded", attempts: 3 }
    ]);
    await expect(t.rowsOf(workspace)).resolves.toEqual({
      workspaces: 0,
      conversations: 0,
      artifacts: 0,
      executionWorkspaces: 0
    });
    expect(t.byteStore.has(data.file.objectKey)).toBe(false);
    expect(t.byteStore.has(data.artifact.objectKey)).toBe(false);
    // What belongs to another workspace stays.
    expect(t.byteStore.keys().sort()).toEqual(
      [keptData.file.objectKey, keptData.artifact.objectKey].sort()
    );
    await expect(t.rowsOf(other)).resolves.toMatchObject({ workspaces: 1, conversations: 1 });
    await expect(t.eventsOfType("collaboration_workspace.deletion_requested")).resolves.toEqual([
      expect.objectContaining({ subject: workspace.id })
    ]);
    await expect(t.eventsOfType("collaboration_workspace.deleted")).resolves.toEqual([
      expect.objectContaining({ subject: workspace.id })
    ]);
  });

  // Fails without the change: no request and deleted event pair, and no check for a job row.
  it("completes in the request and leaves no job when nothing is pending", async () => {
    const t = await arrange(db, "immediate");
    const owner = await t.createUser("owner");
    const leaving = await t.createUser("leaving");
    const workspace = await t.createSharedWorkspace(owner, "Shared");
    await t.createObjects(await t.createConversation(owner, "first", { workspace }));
    await t.createData(await t.createConversation(leaving, "own"));

    const account = await t.api.call("me.delete", {}, leaving.id);
    expect(account.statusCode).toBe(200);
    expect(account.json()).toEqual({ ok: true });
    const removed = await t.api.call(
      "workspaces.delete",
      {
        params: { collaborationWorkspaceId: workspace.id },
        payload: { confirmName: workspace.name }
      },
      owner.id
    );
    expect(removed.statusCode).toBe(200);

    await expect(t.jobs()).resolves.toEqual([]);
    await expect(t.userRow(leaving)).resolves.toEqual([]);
    await expect(t.rowsOf(workspace)).resolves.toMatchObject({ workspaces: 0, conversations: 0 });
    expect(t.byteStore.keys()).toEqual([]);
    for (const type of [
      "user.deletion_requested",
      "user.deleted",
      "collaboration_workspace.deletion_requested",
      "collaboration_workspace.deleted"
    ]) {
      await expect(t.eventsOfType(type)).resolves.toHaveLength(1);
    }
  });

  // Fails without the change: the repeated request answered 409 and there was no job.
  it("answers a repeated request the same way and enqueues nothing", async () => {
    const t = await arrange(db, "repeat");
    const superadmin = await t.createUser("superadmin", ["user", "admin", "superadmin"]);
    const removed = await t.createUser("removed");
    const workspace = await t.createSharedWorkspace(superadmin, "Shared");
    await t.createObjects(await t.createConversation(superadmin, "first", { workspace }));
    await t.createData(await t.createConversation(removed, "own"));
    const deleteUser = () =>
      t.api.call("users.delete", { params: { userId: removed.id } }, superadmin.id);
    const deleteWorkspace = () =>
      t.api.call(
        "workspaces.delete",
        {
          params: { collaborationWorkspaceId: workspace.id },
          payload: { confirmName: workspace.name }
        },
        superadmin.id
      );

    t.byteStore.failDeletes = true;
    for (const request of [deleteUser, deleteWorkspace, deleteUser, deleteWorkspace]) {
      const answer = await request();
      expect(answer.statusCode).toBe(202);
      expect(answer.body).toBe("");
    }
    await expect(t.jobs()).resolves.toEqual([
      { kind: "account.delete", status: "queued", attempts: 0 },
      { kind: "workspace.delete", status: "queued", attempts: 0 }
    ]);
    await expect(t.eventsOfType("user.deletion_requested")).resolves.toHaveLength(1);
    await expect(
      t.eventsOfType("collaboration_workspace.deletion_requested")
    ).resolves.toHaveLength(1);
  });

  // Fails without the change: there was no job to end, no stalled event and no closed user.
  it("ends dead after the last attempt, records it once and keeps the user closed", async () => {
    const t = await arrange(db, "stalled");
    const superadmin = await t.createUser("superadmin", ["user", "admin", "superadmin"]);
    const removed = await t.createUser("removed");
    const conversation = await t.createConversation(removed, "own");
    const data = await t.createData(conversation);
    const deleteUser = () =>
      t.api.call("users.delete", { params: { userId: removed.id } }, superadmin.id);

    t.byteStore.failDeletes = true;
    expect((await deleteUser()).statusCode).toBe(202);
    for (let attempt = 1; attempt < DELETION_MAX_ATTEMPTS; attempt += 1) {
      await t.runDeletionJobs();
    }
    await expect(t.jobs()).resolves.toEqual([
      { kind: "account.delete", status: "queued", attempts: DELETION_MAX_ATTEMPTS - 1 }
    ]);
    await expect(t.eventsOfType("user.deletion_stalled")).resolves.toEqual([]);

    await t.runDeletionJobs();
    await t.runDeletionJobs();
    await expect(t.jobs()).resolves.toEqual([
      { kind: "account.delete", status: "dead", attempts: DELETION_MAX_ATTEMPTS }
    ]);
    await expect(t.eventsOfType("user.deletion_stalled")).resolves.toEqual([
      expect.objectContaining({
        status: "failed",
        subject: removed.id,
        metadata: { requestedBy: "admin", pendingCleanupCount: 1 }
      })
    ]);
    expect((await t.signedIn(removed)).statusCode).toBe(401);
    await expect(t.userRow(removed)).resolves.toEqual([{ marked: true }]);
    await t.expectDataLeft(conversation, data);

    // What an operator does once the object store is back: ask again.
    t.byteStore.failDeletes = false;
    expect((await deleteUser()).statusCode).toBe(202);
    await expect(t.jobs()).resolves.toEqual([
      { kind: "account.delete", status: "dead", attempts: DELETION_MAX_ATTEMPTS },
      { kind: "account.delete", status: "queued", attempts: 0 }
    ]);
    await t.runDeletionJobs();
    await expect(t.userRow(removed)).resolves.toEqual([]);
    await t.expectDataRemoved(conversation, data);
    await expect(t.eventsOfType("user.deletion_stalled")).resolves.toHaveLength(1);
  });

  // Fails without the change: no request waited for the workspace, and both were accepted.
  it("accepts one of two owners who delete their accounts at the same moment", async () => {
    const t = await arrange(db, "two_owners");
    const first = await t.createUser("first-owner");
    const second = await t.createUser("second-owner");
    const workspace = await t.createSharedWorkspace(first, "Shared");
    await db.store.workspaces.addMembership({
      ...t.scope,
      collaborationWorkspaceId: workspace.id,
      userId: asUserId(second.id),
      role: "owner"
    });
    // Both requests are held at the workspace they own, so neither has judged yet.
    const held = await db.hold(
      (tx) => tx`select id from collaboration_workspaces where id = ${workspace.id} for update`
    );
    const requests = [first, second].map((owner) => t.api.call("me.delete", {}, owner.id));
    const deadline = Date.now() + 15_000;
    for (;;) {
      const [row] = await db.sql<Array<{ waiting: number }>>`
        select count(*)::int as waiting from pg_locks blocked
        join pg_stat_activity waiter on waiter.pid = blocked.pid
        where not blocked.granted and waiter.application_name = ${db.first}`;
      if ((row?.waiting ?? 0) >= 2) break;
      if (Date.now() > deadline) throw new Error("The two requests never waited for the workspace");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await held.commit();

    const answers = await Promise.all(requests);
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 409]);
    const refused = answers.find((answer) => answer.statusCode === 409);
    expect(refused?.json()).toMatchObject({
      error: { code: "CONFLICT", details: { blockingWorkspaceCount: 1 } }
    });
    const users = await db.store.users.listUsers(t.scope);
    expect(users).toEqual([expect.objectContaining({ status: "active" })]);
    await expect(
      db.store.workspaces.listMemberships({ ...t.scope, collaborationWorkspaceId: workspace.id })
    ).resolves.toEqual([expect.objectContaining({ userId: users[0]?.id, role: "owner" })]);
    await expect(t.eventsOfType("user.deletion_requested")).resolves.toHaveLength(1);
  });

  // Fails without the change: the dead job was removed with the others of its age.
  it("keeps the dead job of a stalled deletion until its subject is gone", async () => {
    const t = await arrange(db, "prune");
    const superadmin = await t.createUser("superadmin", ["user", "admin", "superadmin"]);
    const removed = await t.createUser("removed");
    await t.createData(await t.createConversation(removed, "own"));
    const deleteUser = () =>
      t.api.call("users.delete", { params: { userId: removed.id } }, superadmin.id);
    const prune = () => db.store.jobs.pruneEndedJobs(t.scope);

    t.byteStore.failDeletes = true;
    expect((await deleteUser()).statusCode).toBe(202);
    // As after the last attempt, long ago, with a dead job of another subject of the same age.
    await db.sql`
      update platform_jobs set status = 'dead', finished_at = now() - interval '400 days'
      where client_instance_id = ${t.clientInstanceId} and kind = 'account.delete'`;
    await db.sql`
      insert into platform_jobs
        (id, client_instance_id, kind, subject, payload, status, run_after, attempts,
         max_attempts, correlation_id, created_at, finished_at)
      select 'job_other_' || id, client_instance_id, 'test.other', 'something else', payload,
        status, run_after, attempts, max_attempts, correlation_id, created_at, finished_at
      from platform_jobs
      where client_instance_id = ${t.clientInstanceId} and kind = 'account.delete'`;

    await expect(prune()).resolves.toMatchObject({ failedCount: 1 });
    await expect(t.jobs()).resolves.toEqual([
      { kind: "account.delete", status: "dead", attempts: 0 }
    ]);

    t.byteStore.failDeletes = false;
    expect((await deleteUser()).statusCode).toBe(202);
    await t.runDeletionJobs();
    await expect(t.userRow(removed)).resolves.toEqual([]);
    await expect(prune()).resolves.toMatchObject({ failedCount: 1 });
    await expect(t.jobs()).resolves.toEqual([
      { kind: "account.delete", status: "succeeded", attempts: 1 }
    ]);
  });

  // Fails without the change: a user row had no mark, and both credentials kept working.
  it("refuses the session cookie and the session token of a user being deleted", async () => {
    const fixture = await createConversationCleanupFixture(db, "credentials");
    const baseUrl = "http://localhost:3000";
    const email = `${fixture.clientInstanceId}@example.test`;
    const password = "deletion-resumes-password";
    const tokenOptions = {
      clientInstanceId: fixture.clientInstanceId,
      secret: "test-session-token-secret-long-enough",
      issuer: "widget",
      ttlSeconds: 900
    };
    const auth = await createStandaloneAuthRuntime({
      clientInstanceId: fixture.clientInstanceId,
      databaseUrl: db.databaseUrl,
      secret: "test-secret-at-least-32-characters-long",
      baseUrl
    });
    try {
      await auth.setOrCreatePasswordSignIn({
        email,
        displayLabel: "Cookie User",
        password,
        roles: ["user"],
        permissionRefs: [],
        permissions: []
      });
      const api = await createTestInstance({
        server: {
          ...fixture.options,
          standaloneAuth: auth,
          authAdapter: new IdentityResolvingAuthAdapter(
            new CompositeAuthAdapter([
              auth.authAdapter,
              new HmacSessionTokenAuthAdapter(tokenOptions)
            ]),
            db.store.users,
            { linkByVerifiedEmail: false }
          )
        }
      });
      const signIn = await api.call("authSignIn", {
        headers: { origin: baseUrl },
        payload: { email, password }
      });
      expect(signIn.statusCode).toBe(200);
      const cookie =
        [signIn.headers["set-cookie"] ?? []]
          .flat()
          .map(String)
          .find((value) => value.includes("session_token"))
          ?.split(";")[0] ?? "";
      const { chatSessionToken } = new HmacSessionTokenIssuer(tokenOptions).issue({
        externalUserId: "host-user",
        displayLabel: "Token User"
      });
      const credentials = [{ cookie }, { authorization: `Bearer ${chatSessionToken}` }];

      for (const headers of credentials) {
        const before = await api.call("me.get", { headers });
        expect(before.statusCode).toBe(200);
        const marked = await db.store.users.markUserDeletionRequested({
          ...fixture.scope,
          userId: asUserId(String(before.json().id))
        });
        expect(marked).toBe(true);

        const after = await api.call("me.get", { headers });
        expect(after.statusCode).toBe(401);
        expect(after.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
      }
    } finally {
      await auth.close();
    }
  });
});
