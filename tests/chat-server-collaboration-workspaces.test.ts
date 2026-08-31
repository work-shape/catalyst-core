import { describe, expect, it } from "vitest";
import { asClientInstanceId, asConversationId } from "@vivd-catalyst/core";
import { createClientInstanceApp, createTestConfig, type TestServer } from "./chat-server-harness";

const clientInstanceId = asClientInstanceId("demo-local");

describe("Collaboration Workspace API", () => {
  it("enforces roles, exact-email addition, access requests, and the last-owner invariant", async () => {
    const app = await createWorkspaceApp();
    const owner = await currentUser(app.server, "owner");
    const admin = await currentUser(app.server, "admin");
    const member = await currentUser(app.server, "member");
    const outsider = await currentUser(app.server, "outsider");
    const declined = await currentUser(app.server, "declined");
    const direct = await currentUser(app.server, "direct");

    const created = await inject(app.server, "owner", {
      method: "POST",
      url: "/api/collaboration-workspaces",
      payload: {
        name: "  Product Lab  ",
        description: "Shared product work",
        emoji: "🧪",
        accentColor: "sapphire"
      }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      kind: "shared",
      name: "Product Lab",
      role: "owner",
      visibility: "discoverable"
    });
    const collaborationWorkspaceId = (created.json() as { id: string }).id;

    const addedAdmin = await inject(app.server, "owner", {
      method: "POST",
      url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/members`,
      payload: { email: "ADMIN@EXAMPLE.TEST" }
    });
    expect(addedAdmin.statusCode).toBe(200);
    expect(addedAdmin.json()).toMatchObject({ userId: admin.id, role: "member" });
    expect(
      (
        await inject(app.server, "owner", {
          method: "PATCH",
          url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/members/${admin.id}`,
          payload: { role: "admin" }
        })
      ).statusCode
    ).toBe(200);

    const addedMember = await inject(app.server, "admin", {
      method: "POST",
      url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/members`,
      payload: { email: "member@example.test" }
    });
    expect(addedMember.statusCode).toBe(200);
    expect(addedMember.json()).toMatchObject({ userId: member.id, role: "member" });

    const memberRoleProbe = await inject(app.server, "member", {
      method: "PATCH",
      url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/members/missing-user`,
      payload: { role: "member" }
    });
    expect(memberRoleProbe.statusCode).toBe(403);
    const memberRemovalProbe = await inject(app.server, "member", {
      method: "DELETE",
      url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/members/missing-user`
    });
    expect(memberRemovalProbe.statusCode).toBe(403);

    const memberSettings = await inject(app.server, "member", {
      method: "PATCH",
      url: `/api/collaboration-workspaces/${collaborationWorkspaceId}`,
      payload: { name: "Nope" }
    });
    expect(memberSettings.statusCode).toBe(403);
    const adminSettings = await inject(app.server, "admin", {
      method: "PATCH",
      url: `/api/collaboration-workspaces/${collaborationWorkspaceId}`,
      payload: { visibility: "private", accentColor: "teal" }
    });
    expect(adminSettings.statusCode).toBe(200);
    expect(adminSettings.json()).toMatchObject({ visibility: "private", accentColor: "teal" });

    const adminPromotion = await inject(app.server, "admin", {
      method: "PATCH",
      url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/members/${member.id}`,
      payload: { role: "owner" }
    });
    expect(adminPromotion.statusCode).toBe(403);

    const alreadyMember = await inject(app.server, "owner", {
      method: "POST",
      url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/members`,
      payload: { email: "member@example.test" }
    });
    expect(alreadyMember.statusCode).toBe(409);

    const identityMatch = await app.store.createUser({
      clientInstanceId,
      displayLabel: "Identity match",
      email: "managed@example.test"
    });
    await app.store.upsertUserIdentity({
      clientInstanceId,
      userId: identityMatch.id,
      authSource: "oidc",
      externalUserId: "identity-match",
      email: "verified-identity@example.test",
      emailVerified: true
    });
    const addedByIdentity = await inject(app.server, "owner", {
      method: "POST",
      url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/members`,
      payload: { email: "verified-identity@example.test" }
    });
    expect(addedByIdentity.statusCode).toBe(200);
    expect(addedByIdentity.json()).toMatchObject({ userId: identityMatch.id });
    expect(
      (
        await inject(app.server, "admin", {
          method: "DELETE",
          url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/members/${identityMatch.id}`
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await inject(app.server, "admin", {
          method: "DELETE",
          url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/members/${owner.id}`
        })
      ).statusCode
    ).toBe(403);

    for (const input of [
      { displayLabel: "Unknown", email: "unknown@example.test", status: "active" as const },
      { displayLabel: "Inactive", email: "inactive@example.test", status: "disabled" as const },
      { displayLabel: "Ambiguous one", email: "ambiguous@example.test", status: "active" as const },
      { displayLabel: "Ambiguous two", email: "ambiguous@example.test", status: "active" as const }
    ]) {
      if (input.displayLabel !== "Unknown") {
        await app.store.createUser({ clientInstanceId, ...input });
      }
    }
    for (const email of [
      "unknown@example.test",
      "inactive@example.test",
      "ambiguous@example.test"
    ]) {
      const response = await inject(app.server, "owner", {
        method: "POST",
        url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/members`,
        payload: { email }
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        error: { message: expect.stringContaining("Invitations") }
      });
    }

    const privateRequest = await inject(app.server, "outsider", {
      method: "POST",
      url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/access-requests`
    });
    expect(privateRequest.statusCode).toBe(404);
    await inject(app.server, "admin", {
      method: "PATCH",
      url: `/api/collaboration-workspaces/${collaborationWorkspaceId}`,
      payload: { visibility: "discoverable" }
    });
    const request = await inject(app.server, "outsider", {
      method: "POST",
      url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/access-requests`
    });
    expect(request.statusCode).toBe(200);
    expect(
      (
        await inject(app.server, "outsider", {
          method: "POST",
          url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/access-requests`
        })
      ).statusCode
    ).toBe(409);

    expect(
      (
        await inject(app.server, "direct", {
          method: "POST",
          url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/access-requests`
        })
      ).statusCode
    ).toBe(200);
    const directlyAdded = await inject(app.server, "owner", {
      method: "POST",
      url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/members`,
      payload: { email: "direct@example.test" }
    });
    expect(directlyAdded.statusCode).toBe(200);
    expect(directlyAdded.json()).toMatchObject({ userId: direct.id, role: "member" });
    const clearedRequestApproval = await inject(app.server, "admin", {
      method: "POST",
      url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/access-requests/${direct.id}/approve`
    });
    expect(clearedRequestApproval.statusCode).toBe(404);
    const pendingDirectory = await inject(app.server, "outsider", {
      method: "GET",
      url: "/api/collaboration-workspaces/directory"
    });
    expect(pendingDirectory.json()).toContainEqual(
      expect.objectContaining({ id: collaborationWorkspaceId, accessState: "request_pending" })
    );
    const requests = await inject(app.server, "admin", {
      method: "GET",
      url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/access-requests`
    });
    expect(requests.statusCode).toBe(200);
    expect(requests.json()).toContainEqual(expect.objectContaining({ userId: outsider.id }));

    const ownerRows = await inject(app.server, "owner", {
      method: "GET",
      url: "/api/collaboration-workspaces"
    });
    expect(ownerRows.json()).toContainEqual(
      expect.objectContaining({ id: collaborationWorkspaceId, pendingAccessRequestCount: 1 })
    );
    expect(
      (
        await inject(app.server, "admin", {
          method: "POST",
          url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/access-requests/${outsider.id}/approve`
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await inject(app.server, "declined", {
          method: "POST",
          url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/access-requests`
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await inject(app.server, "admin", {
          method: "DELETE",
          url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/access-requests/${declined.id}`
        })
      ).statusCode
    ).toBe(200);
    const declinedDirectory = await inject(app.server, "declined", {
      method: "GET",
      url: "/api/collaboration-workspaces/directory"
    });
    expect(declinedDirectory.json()).toContainEqual(
      expect.objectContaining({ id: collaborationWorkspaceId, accessState: "can_request" })
    );
    expect(
      (
        await inject(app.server, "outsider", {
          method: "GET",
          url: `/api/collaboration-workspaces/${collaborationWorkspaceId}`
        })
      ).statusCode
    ).toBe(200);

    const soleOwnerLeave = await inject(app.server, "owner", {
      method: "DELETE",
      url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/members/me`
    });
    expect(soleOwnerLeave.statusCode).toBe(409);
    expect(
      (
        await inject(app.server, "owner", {
          method: "PATCH",
          url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/members/${owner.id}`,
          payload: { role: "member" }
        })
      ).statusCode
    ).toBe(409);
    expect(
      (
        await inject(app.server, "owner", {
          method: "DELETE",
          url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/members/${owner.id}`
        })
      ).statusCode
    ).toBe(409);
    const deleteOwner = await inject(app.server, "owner", {
      method: "DELETE",
      url: "/api/me"
    });
    expect(deleteOwner.statusCode).toBe(409);
    expect(deleteOwner.json()).toMatchObject({
      error: { message: expect.stringContaining("1 Shared Workspace") }
    });

    expect(
      (
        await inject(app.server, "owner", {
          method: "PATCH",
          url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/members/${member.id}`,
          payload: { role: "owner" }
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await inject(app.server, "owner", {
          method: "DELETE",
          url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/members/me`
        })
      ).statusCode
    ).toBe(200);

    const deletionBlockWorkspace = await inject(app.server, "declined", {
      method: "POST",
      url: "/api/collaboration-workspaces",
      payload: { name: "Deletion block" }
    });
    expect(deletionBlockWorkspace.statusCode).toBe(200);
    const superadminDelete = await inject(app.server, "owner", {
      method: "DELETE",
      url: `/api/superadmin/users/${declined.id}`
    });
    expect(superadminDelete.statusCode).toBe(409);
    expect(superadminDelete.json()).toMatchObject({
      error: { message: expect.stringContaining("1 Shared Workspace") }
    });

    const audit = await inject(app.server, "owner", {
      method: "GET",
      url: "/api/audit-events"
    });
    expect(audit.statusCode).toBe(200);
    const auditEvents = audit.json() as Array<{
      type: string;
      metadata?: Record<string, unknown>;
    }>;
    expect(auditEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "collaboration_workspace.created",
        "collaboration_workspace.updated",
        "collaboration_workspace.member_added",
        "collaboration_workspace.member_removed",
        "collaboration_workspace.member_left",
        "collaboration_workspace.member_role_changed",
        "collaboration_workspace.access_requested",
        "collaboration_workspace.access_request_approved",
        "collaboration_workspace.access_request_declined"
      ])
    );
    expect(JSON.stringify(auditEvents)).not.toContain("@example.test");

    await app.close();
  });

  it("keeps directory metadata minimal and authorizes conversations through membership", async () => {
    const app = await createWorkspaceApp();
    const owner = await currentUser(app.server, "owner");
    const member = await currentUser(app.server, "member");
    await currentUser(app.server, "outsider");
    const created = await inject(app.server, "owner", {
      method: "POST",
      url: "/api/collaboration-workspaces",
      payload: { name: "Discoverable", description: "Limited metadata", accentColor: "ruby" }
    });
    const collaborationWorkspaceId = (created.json() as { id: string }).id;

    const directory = await inject(app.server, "outsider", {
      method: "GET",
      url: "/api/collaboration-workspaces/directory"
    });
    expect(directory.statusCode).toBe(200);
    const directoryRow = (directory.json() as Array<Record<string, unknown>>).find(
      (row) => row.id === collaborationWorkspaceId
    );
    expect(directoryRow).toEqual({
      id: collaborationWorkspaceId,
      name: "Discoverable",
      description: "Limited metadata",
      emoji: null,
      accentColor: "ruby",
      accessState: "can_request"
    });
    for (const absent of ["members", "memberCount", "email", "activity", "role"]) {
      expect(directoryRow).not.toHaveProperty(absent);
    }

    const explicit = await inject(app.server, "owner", {
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Shared thread", collaborationWorkspaceId }
    });
    expect(explicit.statusCode).toBe(200);
    expect(explicit.json()).toMatchObject({ collaborationWorkspaceId, createdByUserId: owner.id });
    const conversationId = (explicit.json() as { id: string }).id;

    const defaulted = await inject(app.server, "owner", {
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Private thread" }
    });
    expect(defaulted.statusCode).toBe(200);
    expect(
      (defaulted.json() as { collaborationWorkspaceId: string }).collaborationWorkspaceId
    ).not.toBe(collaborationWorkspaceId);

    const unauthorized = await inject(app.server, "member", {
      method: "GET",
      url: `/api/conversations/${conversationId}/thread`
    });
    expect(unauthorized.statusCode).toBe(404);
    const missing = await inject(app.server, "member", {
      method: "GET",
      url: "/api/conversations/missing-conversation/thread"
    });
    expect(missing.statusCode).toBe(404);
    expect(unauthorized.json()).toMatchObject({
      error: { message: "Conversation is not available" }
    });
    expect(missing.json()).toMatchObject({
      error: { message: "Conversation is not available" }
    });

    const sharedCreateAndRun = await inject(app.server, "owner", {
      method: "POST",
      url: "/api/conversations/runs",
      payload: {
        idempotencyKey: "shared-create-and-run",
        conversation: { title: "Shared run", collaborationWorkspaceId },
        message: { text: "Run in the shared workspace" }
      }
    });
    expect(sharedCreateAndRun.statusCode).toBe(200);
    expect(sharedCreateAndRun.json()).toMatchObject({
      conversation: { collaborationWorkspaceId }
    });

    const unauthorizedCreateAndRun = await inject(app.server, "member", {
      method: "POST",
      url: "/api/conversations/runs",
      payload: {
        idempotencyKey: "unauthorized-create-and-run",
        conversation: { title: "Unauthorized run", collaborationWorkspaceId },
        message: { text: "Do not create this" }
      }
    });
    expect(unauthorizedCreateAndRun.statusCode).toBe(404);

    const personalCreateAndRun = await inject(app.server, "owner", {
      method: "POST",
      url: "/api/conversations/runs",
      payload: {
        idempotencyKey: "personal-create-and-run",
        conversation: { title: "Personal run" },
        message: { text: "Run in the personal workspace" }
      }
    });
    expect(personalCreateAndRun.statusCode).toBe(200);
    expect(
      (personalCreateAndRun.json() as { conversation: { collaborationWorkspaceId: string } })
        .conversation.collaborationWorkspaceId
    ).not.toBe(collaborationWorkspaceId);

    await inject(app.server, "owner", {
      method: "POST",
      url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/members`,
      payload: { email: "member@example.test" }
    });
    const listed = await inject(app.server, "member", {
      method: "GET",
      url: `/api/conversations?collaborationWorkspaceId=${collaborationWorkspaceId}`
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toContainEqual(expect.objectContaining({ id: conversationId }));
    expect(
      (
        await inject(app.server, "member", {
          method: "PATCH",
          url: `/api/conversations/${conversationId}/title`,
          payload: { title: "Renamed by collaborator" }
        })
      ).statusCode
    ).toBe(200);

    const sent = await inject(app.server, "member", {
      method: "POST",
      url: `/api/conversations/${conversationId}/runs`,
      payload: { idempotencyKey: "collaborator-run", message: { text: "Hello" } }
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({
      run: { ownerUserId: member.id },
      conversation: { createdByUserId: owner.id }
    });
    const runId = (sent.json() as { run: { id: string } }).run.id;
    const observedByOwner = await inject(app.server, "owner", {
      method: "GET",
      url: `/api/conversations/${conversationId}/runs/${runId}/events`
    });
    expect(observedByOwner.statusCode).toBe(200);
    expect(
      (
        await inject(app.server, "outsider", {
          method: "GET",
          url: `/api/conversations/${conversationId}/runs/${runId}/events`
        })
      ).statusCode
    ).toBe(404);

    const privateWorkspaceId = (defaulted.json() as { collaborationWorkspaceId: string })
      .collaborationWorkspaceId;
    const privateConversationId = (defaulted.json() as { id: string }).id;
    expect(
      (
        await inject(app.server, "owner", {
          method: "PATCH",
          url: `/api/collaboration-workspaces/${privateWorkspaceId}`,
          payload: { name: "Cannot rename personal" }
        })
      ).statusCode
    ).toBe(422);

    const privateRun = await inject(app.server, "owner", {
      method: "POST",
      url: `/api/conversations/${privateConversationId}/runs`,
      payload: { idempotencyKey: "private-run", message: { text: "Private" } }
    });
    expect(privateRun.statusCode).toBe(200);
    const privateRunId = (privateRun.json() as { run: { id: string } }).run.id;
    expect(
      (
        await inject(app.server, "member", {
          method: "GET",
          url: `/api/conversations/${conversationId}/runs/${privateRunId}/events`
        })
      ).statusCode
    ).toBe(404);

    const privateFile = await app.store.createManagedFile({
      clientInstanceId,
      ownerUserId: owner.id,
      filename: "private.txt",
      mimeType: "text/plain",
      byteSize: 7,
      checksum: "private-file",
      objectKey: "private-file"
    });
    await app.store.createConversationAttachment({
      clientInstanceId,
      conversationId: asConversationId(privateConversationId),
      fileId: privateFile.id,
      filename: privateFile.filename,
      mimeType: privateFile.mimeType,
      byteSize: privateFile.byteSize,
      checksum: privateFile.checksum,
      status: "ready",
      processingMetadata: { source: "execution_workspace_source" }
    });
    const crossWorkspaceFile = await inject(app.server, "member", {
      method: "GET",
      url: `/api/conversations/${conversationId}/files/${privateFile.id}/content?download=true`
    });
    expect(crossWorkspaceFile.statusCode).toBe(404);

    const privateArtifact = await app.store.createManagedArtifact({
      clientInstanceId,
      conversationId: asConversationId(privateConversationId),
      kind: "file",
      objectKey: "private-artifact",
      filename: "private.txt",
      mimeType: "text/plain",
      byteSize: 7,
      checksum: "private"
    });
    expect(
      (
        await inject(app.server, "member", {
          method: "GET",
          url: `/api/conversations/${conversationId}/artifacts/${privateArtifact.id}/preview`
        })
      ).statusCode
    ).toBe(404);
    const crossWorkspaceList = await inject(app.server, "member", {
      method: "GET",
      url: `/api/conversations?collaborationWorkspaceId=${privateWorkspaceId}`
    });
    expect(crossWorkspaceList.statusCode).toBe(404);

    await app.close();
  });
});

async function createWorkspaceApp() {
  return createClientInstanceApp({
    config: createTestConfig({
      developmentAuth: {
        enabled: true,
        defaultUserId: "owner",
        users: [
          testIdentity("owner", "owner@example.test", ["user", "admin", "superadmin"]),
          testIdentity("admin", "admin@example.test"),
          testIdentity("member", "member@example.test"),
          testIdentity("outsider", "outsider@example.test"),
          testIdentity("declined", "declined@example.test"),
          testIdentity("direct", "direct@example.test")
        ]
      },
      executionWorkspaces: { enabled: true }
    }),
    env: { EXECUTION_WORKSPACE_OBJECT_ROOT: "/tmp/vivd-catalyst-phase-b-workspace-objects" },
    storeMode: "memory",
    tools: []
  });
}

function testIdentity(id: string, email: string, roles = ["user"]) {
  return {
    id,
    externalUserId: id,
    displayLabel: id,
    email,
    emailVerified: true,
    roles,
    permissionRefs: ["demo-tools"]
  };
}

async function currentUser(server: TestServer, externalUserId: string): Promise<{ id: string }> {
  const response = await inject(server, externalUserId, { method: "GET", url: "/api/me" });
  expect(response.statusCode).toBe(200);
  return response.json() as { id: string };
}

function inject(
  server: TestServer,
  externalUserId: string,
  input: { method: "GET" | "POST" | "PATCH" | "DELETE"; url: string; payload?: unknown }
) {
  return server.inject({
    ...input,
    headers: { "x-dev-user-id": externalUserId }
  });
}
