import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import { asClientInstanceId, type ClientInstanceId } from "@vivd-catalyst/core";
import { PostgresPlatformStore } from "@vivd-catalyst/postgres-store";

const databaseUrl = process.env.POSTGRES_STORE_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("Postgres Collaboration Workspace store", () => {
  let store: PostgresPlatformStore;
  let sql: Sql;

  beforeAll(async () => {
    store = await PostgresPlatformStore.connect({ databaseUrl: databaseUrl!, runMigrations: true });
    sql = postgres(databaseUrl!, { max: 1 });
  });

  afterAll(async () => {
    await sql?.end();
    await store?.close();
  });

  it("provisions one protected Personal Workspace", async () => {
    const clientInstanceId = testClientInstanceId("personal");
    try {
      const user = await store.createUser({ clientInstanceId, displayLabel: "Owner" });
      const [first] = await store.listWorkspacesForUser({ clientInstanceId, userId: user.id });
      const second = await store.ensurePersonalWorkspace({ clientInstanceId, userId: user.id });

      expect(first).toMatchObject({ role: "owner" });
      expect(second.id).toBe(first!.id);
      expect(first).toMatchObject({
        kind: "personal",
        visibility: "private",
        personalUserId: user.id
      });
      await expect(
        store.createWorkspace({
          clientInstanceId,
          kind: "personal",
          name: "Duplicate",
          personalUserId: user.id,
          creatorUserId: user.id
        })
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        store.updateWorkspace({
          clientInstanceId,
          collaborationWorkspaceId: first!.id,
          name: "Renamed"
        })
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await expect(
        store.deleteWorkspace({
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
      const owner = await store.createUser({ clientInstanceId, displayLabel: "Owner" });
      const other = await store.createUser({ clientInstanceId, displayLabel: "Other" });
      const personal = await store.ensurePersonalWorkspace({ clientInstanceId, userId: owner.id });

      await expect(
        store.addMembership({
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
      const owner = await store.createUser({ clientInstanceId, displayLabel: "Owner" });
      const member = await store.createUser({ clientInstanceId, displayLabel: "Member" });
      const requester = await store.createUser({ clientInstanceId, displayLabel: "Requester" });
      const shared = await store.createWorkspace({
        clientInstanceId,
        kind: "shared",
        name: "Shared",
        creatorUserId: owner.id
      });

      await store.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: shared.id,
        userId: member.id,
        role: "member"
      });
      await expect(
        store.updateMembershipRole({
          clientInstanceId,
          collaborationWorkspaceId: shared.id,
          userId: member.id,
          role: "admin"
        })
      ).resolves.toMatchObject({ role: "admin" });

      const request = await store.createAccessRequest({
        clientInstanceId,
        collaborationWorkspaceId: shared.id,
        userId: requester.id
      });
      await expect(
        store.createAccessRequest({
          clientInstanceId,
          collaborationWorkspaceId: shared.id,
          userId: requester.id
        })
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        store.listAccessRequestsForWorkspace({
          clientInstanceId,
          collaborationWorkspaceId: shared.id
        })
      ).resolves.toEqual([request]);
    } finally {
      await cleanupClient(sql, clientInstanceId);
    }
  });

  it("lists only discoverable Shared Workspaces", async () => {
    const clientInstanceId = testClientInstanceId("directory");
    try {
      const owner = await store.createUser({ clientInstanceId, displayLabel: "Owner" });
      const discoverable = await store.createWorkspace({
        clientInstanceId,
        kind: "shared",
        name: "Discoverable",
        creatorUserId: owner.id
      });
      await store.createWorkspace({
        clientInstanceId,
        kind: "shared",
        name: "Private",
        visibility: "private",
        creatorUserId: owner.id
      });

      await expect(store.listDiscoverableWorkspaces({ clientInstanceId })).resolves.toEqual([
        discoverable
      ]);
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
