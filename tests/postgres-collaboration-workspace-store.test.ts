import type { PlatformStores } from "@vivd-catalyst/core";
import { createTestInstance } from "./support/test-instance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import { asClientInstanceId, type ClientInstanceId } from "@vivd-catalyst/core";

const databaseUrl = process.env.POSTGRES_STORE_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("Postgres Collaboration Workspace store", () => {
  let store: PlatformStores;
  let sql: Sql;

  beforeAll(async () => {
    store = (
      await createTestInstance({ postgres: { databaseUrl: databaseUrl!, runMigrations: true } })
    ).stores;
    sql = postgres(databaseUrl!, { max: 1 });
  });

  afterAll(async () => {
    await sql?.end();
    await store?.close?.();
  });

  it("provisions one protected Personal Workspace", async () => {
    const clientInstanceId = testClientInstanceId("personal");
    try {
      const user = await store.users.createUser({ clientInstanceId, displayLabel: "Owner" });
      const [first] = await store.workspaces.listWorkspacesForUser({
        clientInstanceId,
        userId: user.id
      });
      const second = await store.workspaces.ensurePersonalWorkspace({
        clientInstanceId,
        userId: user.id
      });

      expect(first).toMatchObject({ role: "owner" });
      expect(second.id).toBe(first!.id);
      expect(first).toMatchObject({
        kind: "personal",
        visibility: "private",
        personalUserId: user.id
      });
      await expect(
        store.workspaces.createWorkspace({
          clientInstanceId,
          kind: "personal",
          name: "Duplicate",
          personalUserId: user.id,
          creatorUserId: user.id
        })
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        store.workspaces.updateWorkspace({
          clientInstanceId,
          collaborationWorkspaceId: first!.id,
          name: "Renamed"
        })
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await expect(
        store.workspaces.deleteWorkspace({
          clientInstanceId,
          collaborationWorkspaceId: first!.id
        })
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    } finally {
      await cleanupClient(sql, clientInstanceId);
    }
  });

  it("rejects additional Personal Workspace members", async () => {
    const clientInstanceId = testClientInstanceId("personal-members");
    try {
      const owner = await store.users.createUser({ clientInstanceId, displayLabel: "Owner" });
      const other = await store.users.createUser({ clientInstanceId, displayLabel: "Other" });
      const personal = await store.workspaces.ensurePersonalWorkspace({
        clientInstanceId,
        userId: owner.id
      });

      await expect(
        store.workspaces.addMembership({
          clientInstanceId,
          collaborationWorkspaceId: personal.id,
          userId: other.id,
          role: "member"
        })
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    } finally {
      await cleanupClient(sql, clientInstanceId);
    }
  });

  it("updates Shared Workspace roles and enforces pending-request uniqueness", async () => {
    const clientInstanceId = testClientInstanceId("shared");
    try {
      const owner = await store.users.createUser({ clientInstanceId, displayLabel: "Owner" });
      const member = await store.users.createUser({ clientInstanceId, displayLabel: "Member" });
      const requester = await store.users.createUser({
        clientInstanceId,
        displayLabel: "Requester"
      });
      const shared = await store.workspaces.createWorkspace({
        clientInstanceId,
        kind: "shared",
        name: "Shared",
        creatorUserId: owner.id
      });

      await store.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: shared.id,
        userId: member.id,
        role: "member"
      });
      await expect(
        store.workspaces.updateMembershipRole({
          clientInstanceId,
          collaborationWorkspaceId: shared.id,
          userId: member.id,
          role: "admin"
        })
      ).resolves.toMatchObject({ role: "admin" });

      const request = await store.workspaces.createAccessRequest({
        clientInstanceId,
        collaborationWorkspaceId: shared.id,
        userId: requester.id
      });
      await expect(
        store.workspaces.createAccessRequest({
          clientInstanceId,
          collaborationWorkspaceId: shared.id,
          userId: requester.id
        })
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        store.workspaces.listAccessRequestsForWorkspace({
          clientInstanceId,
          collaborationWorkspaceId: shared.id
        })
      ).resolves.toEqual([request]);
    } finally {
      await cleanupClient(sql, clientInstanceId);
    }
  });

  it("searches active non-members as add-member candidates", async () => {
    const clientInstanceId = testClientInstanceId("member-candidates");
    try {
      const owner = await store.users.createUser({ clientInstanceId, displayLabel: "Owner" });
      const existing = await store.users.createUser({
        clientInstanceId,
        displayLabel: "Existing Candidate",
        email: "existing-candidate@example.test"
      });
      const pending = await store.users.createUser({
        clientInstanceId,
        displayLabel: "Pending Candidate",
        email: "pending-candidate@example.test"
      });
      await store.users.createUser({
        clientInstanceId,
        displayLabel: "Disabled Candidate",
        email: "disabled-candidate@example.test",
        status: "disabled"
      });
      const identityMatch = await store.users.createUser({
        clientInstanceId,
        displayLabel: "Identity Result"
      });
      await store.users.upsertUserIdentity({
        clientInstanceId,
        userId: identityMatch.id,
        authSource: "oidc",
        externalUserId: "postgres-candidate",
        email: "Verified.Alias@example.test",
        emailVerified: true
      });
      const shared = await store.workspaces.createWorkspace({
        clientInstanceId,
        kind: "shared",
        name: "Candidate search",
        creatorUserId: owner.id
      });
      await store.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: shared.id,
        userId: existing.id,
        role: "member"
      });
      await store.workspaces.createAccessRequest({
        clientInstanceId,
        collaborationWorkspaceId: shared.id,
        userId: pending.id
      });

      await expect(
        store.workspaces.searchMemberCandidates({
          clientInstanceId,
          collaborationWorkspaceId: shared.id,
          query: "PENDING CANDIDATE",
          limit: 8
        })
      ).resolves.toEqual([
        {
          displayLabel: "Pending Candidate",
          email: "pending-candidate@example.test",
          hasPendingAccessRequest: true
        }
      ]);
      await expect(
        store.workspaces.searchMemberCandidates({
          clientInstanceId,
          collaborationWorkspaceId: shared.id,
          query: "verified.alias",
          limit: 8
        })
      ).resolves.toEqual([
        {
          displayLabel: "Identity Result",
          email: "Verified.Alias@example.test",
          hasPendingAccessRequest: false
        }
      ]);
      await expect(
        store.workspaces.searchMemberCandidates({
          clientInstanceId,
          collaborationWorkspaceId: shared.id,
          query: "existing-candidate",
          limit: 8
        })
      ).resolves.toEqual([]);
      await expect(
        store.workspaces.searchMemberCandidates({
          clientInstanceId,
          collaborationWorkspaceId: shared.id,
          query: "disabled-candidate",
          limit: 8
        })
      ).resolves.toEqual([]);

      for (let index = 0; index < 10; index += 1) {
        await store.users.createUser({
          clientInstanceId,
          displayLabel: `PG Limit ${index.toString().padStart(2, "0")}`,
          email: `pg-limit-${index}@example.test`
        });
      }
      const limited = await store.workspaces.searchMemberCandidates({
        clientInstanceId,
        collaborationWorkspaceId: shared.id,
        query: "PG LIMIT",
        limit: 8
      });
      expect(limited).toHaveLength(8);
      expect(limited.map((candidate) => candidate.displayLabel)).toEqual(
        Array.from({ length: 8 }, (_, index) => `PG Limit ${index.toString().padStart(2, "0")}`)
      );
    } finally {
      await cleanupClient(sql, clientInstanceId);
    }
  });

  it("lists only discoverable Shared Workspaces", async () => {
    const clientInstanceId = testClientInstanceId("directory");
    try {
      const owner = await store.users.createUser({ clientInstanceId, displayLabel: "Owner" });
      const discoverable = await store.workspaces.createWorkspace({
        clientInstanceId,
        kind: "shared",
        name: "Discoverable",
        creatorUserId: owner.id
      });
      await store.workspaces.createWorkspace({
        clientInstanceId,
        kind: "shared",
        name: "Private",
        visibility: "private",
        creatorUserId: owner.id
      });

      await expect(
        store.workspaces.listDiscoverableWorkspaces({ clientInstanceId })
      ).resolves.toEqual([discoverable]);
    } finally {
      await cleanupClient(sql, clientInstanceId);
    }
  });

  it("moves with an expected source and hard-deletes cleaned conversation rows", async () => {
    const clientInstanceId = testClientInstanceId("conversation-lifecycle");
    try {
      const owner = await store.users.createUser({ clientInstanceId, displayLabel: "Owner" });
      const source = await store.workspaces.createWorkspace({
        clientInstanceId,
        kind: "shared",
        name: "Source",
        creatorUserId: owner.id
      });
      const destination = await store.workspaces.createWorkspace({
        clientInstanceId,
        kind: "shared",
        name: "Destination",
        creatorUserId: owner.id
      });
      const conversation = await store.conversations.createConversation({
        visibility: "workspace",
        clientInstanceId,
        collaborationWorkspaceId: source.id,
        createdByUserId: owner.id,
        createdByExternalUserId: "owner",
        title: "Movable",
        retainedUntil: "2030-01-01T00:00:00.000Z"
      });

      await expect(
        store.conversations.moveConversation({
          clientInstanceId,
          conversationId: conversation.id,
          fromCollaborationWorkspaceId: source.id,
          toCollaborationWorkspaceId: destination.id,
          visibility: "workspace"
        })
      ).resolves.toMatchObject({ collaborationWorkspaceId: destination.id });
      await expect(
        store.conversations.moveConversation({
          clientInstanceId,
          conversationId: conversation.id,
          fromCollaborationWorkspaceId: source.id,
          toCollaborationWorkspaceId: destination.id,
          visibility: "workspace"
        })
      ).rejects.toMatchObject({ code: "CONFLICT" });

      await store.conversations.deleteConversation({
        clientInstanceId,
        conversationId: conversation.id,
        deletedAt: new Date().toISOString()
      });
      await store.workspaces.deleteWorkspace({
        clientInstanceId,
        collaborationWorkspaceId: destination.id
      });
      await expect(
        store.conversations.getConversation(clientInstanceId, conversation.id)
      ).resolves.toBeUndefined();
    } finally {
      await cleanupClient(sql, clientInstanceId);
    }
  });

  it("filters conversation listings by visibility in SQL and moves visibility with the row", async () => {
    const clientInstanceId = testClientInstanceId("conversation-visibility");
    try {
      const author = await store.users.createUser({ clientInstanceId, displayLabel: "Author" });
      const colleague = await store.users.createUser({
        clientInstanceId,
        displayLabel: "Colleague"
      });
      const workspace = await store.workspaces.createWorkspace({
        clientInstanceId,
        kind: "shared",
        name: "Shared",
        defaultConversationVisibility: "private",
        creatorUserId: author.id
      });
      expect(workspace.defaultConversationVisibility).toBe("private");
      const destination = await store.workspaces.createWorkspace({
        clientInstanceId,
        kind: "shared",
        name: "Destination",
        creatorUserId: author.id
      });
      expect(destination.defaultConversationVisibility).toBe("workspace");
      const create = (visibility: "workspace" | "private", createdByUserId: string) =>
        store.conversations.createConversation({
          clientInstanceId,
          collaborationWorkspaceId: workspace.id,
          createdByUserId,
          createdByExternalUserId: createdByUserId,
          visibility,
          title: visibility,
          retainedUntil: "2030-01-01T00:00:00.000Z"
        });
      const open = await create("workspace", author.id);
      const authorsPrivate = await create("private", author.id);
      const colleaguesPrivate = await create("private", colleague.id);
      expect(authorsPrivate.visibility).toBe("private");
      for (const conversation of [open, authorsPrivate, colleaguesPrivate]) {
        await store.conversations.appendMessage({
          clientInstanceId,
          conversationId: conversation.id,
          role: "user",
          text: "First message"
        });
      }
      const list = async (
        scope: Parameters<typeof store.conversations.listConversationsForWorkspace>[0]["scope"]
      ) =>
        (
          await store.conversations.listConversationsForWorkspace({
            clientInstanceId,
            collaborationWorkspaceId: workspace.id,
            scope
          })
        )
          .map((conversation) => conversation.id)
          .sort();

      await expect(list({ kind: "viewer", userId: author.id })).resolves.toEqual(
        [open.id, authorsPrivate.id].sort()
      );
      await expect(list({ kind: "viewer", userId: colleague.id })).resolves.toEqual(
        [open.id, colleaguesPrivate.id].sort()
      );
      await expect(list({ kind: "lifecycle" })).resolves.toEqual(
        [open.id, authorsPrivate.id, colleaguesPrivate.id].sort()
      );
      await expect(
        store.conversations.listPrivateConversationsCreatedByUser({
          clientInstanceId,
          userId: author.id
        })
      ).resolves.toEqual([expect.objectContaining({ id: authorsPrivate.id })]);

      await expect(
        store.conversations.moveConversation({
          clientInstanceId,
          conversationId: authorsPrivate.id,
          fromCollaborationWorkspaceId: workspace.id,
          toCollaborationWorkspaceId: destination.id,
          visibility: "workspace"
        })
      ).resolves.toMatchObject({
        collaborationWorkspaceId: destination.id,
        visibility: "workspace"
      });
      await expect(
        store.conversations.listPrivateConversationsCreatedByUser({
          clientInstanceId,
          userId: author.id
        })
      ).resolves.toEqual([]);

      const personal = await store.workspaces.ensurePersonalWorkspace({
        clientInstanceId,
        userId: author.id
      });
      expect(personal.defaultConversationVisibility).toBe("workspace");
      await expect(
        store.workspaces.updateWorkspace({
          clientInstanceId,
          collaborationWorkspaceId: personal.id,
          defaultConversationVisibility: "private"
        })
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await expect(
        store.workspaces.updateWorkspace({
          clientInstanceId,
          collaborationWorkspaceId: workspace.id,
          defaultConversationVisibility: "workspace"
        })
      ).resolves.toMatchObject({ defaultConversationVisibility: "workspace" });
      await expect(
        store.conversations.getConversation(clientInstanceId, colleaguesPrivate.id)
      ).resolves.toMatchObject({ visibility: "private" });
    } finally {
      await cleanupClient(sql, clientInstanceId);
    }
  });
});

function testClientInstanceId(label: string): ClientInstanceId {
  return asClientInstanceId(`workspace_pg_${label}_${globalThis.crypto.randomUUID()}`);
}

async function cleanupClient(sql: Sql, clientInstanceId: ClientInstanceId): Promise<void> {
  await sql`delete from conversations where client_instance_id = ${clientInstanceId}`;
  await sql`delete from collaboration_workspace_access_requests where client_instance_id = ${clientInstanceId}`;
  await sql`delete from collaboration_workspace_memberships where client_instance_id = ${clientInstanceId}`;
  await sql`delete from collaboration_workspaces where client_instance_id = ${clientInstanceId}`;
  await sql`delete from product_users where client_instance_id = ${clientInstanceId}`;
}
