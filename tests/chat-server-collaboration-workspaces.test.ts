import { describe, expect, it } from "vitest";
import { z } from "zod";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  asClientInstanceId,
  asCollaborationWorkspaceId,
  asConversationId,
  createPlatformId
} from "@vivd-catalyst/core";
import {
  createClientInstanceApp,
  createTestConfig,
  seedConversationMessage,
  type TestServer
} from "./chat-server-harness";
import { createMultipartFilePayload } from "./chat-server-attachment-harness";

const clientInstanceId = asClientInstanceId("demo-local");

describe("Collaboration Workspace API", () => {
  it("blocks growth operations while personal workspace conversations keep working", async () => {
    const app = await createWorkspaceApp(false);
    await currentUser(app.server, "owner");

    const workspaces = await inject(app.server, "owner", {
      method: "GET",
      url: "/api/collaboration-workspaces"
    });
    expect(workspaces.statusCode).toBe(200);
    const personalWorkspace = workspaces
      .json<Array<{ id: string; kind: string }>>()
      .find((workspace) => workspace.kind === "personal");
    expect(personalWorkspace).toBeDefined();

    const conversation = await inject(app.server, "owner", {
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Personal while shared workspaces are disabled" }
    });
    expect(conversation.statusCode).toBe(200);
    expect(conversation.json()).toMatchObject({
      collaborationWorkspaceId: personalWorkspace!.id
    });
    const conversationId = conversation.json<{ id: string }>().id;
    await seedConversationMessage(app.store, conversationId);
    const listedConversations = await inject(app.server, "owner", {
      method: "GET",
      url: "/api/conversations"
    });
    expect(listedConversations.statusCode).toBe(200);
    expect(listedConversations.json()).toContainEqual(
      expect.objectContaining({ id: conversationId })
    );
    expect(
      (
        await inject(app.server, "owner", {
          method: "GET",
          url: `/api/conversations/${conversationId}/thread`
        })
      ).statusCode
    ).toBe(200);

    for (const request of [
      {
        method: "POST" as const,
        url: "/api/collaboration-workspaces",
        payload: { name: "Blocked" }
      },
      { method: "GET" as const, url: "/api/collaboration-workspaces/directory" },
      {
        method: "POST" as const,
        url: "/api/collaboration-workspaces/missing/access-requests"
      },
      {
        method: "POST" as const,
        url: "/api/collaboration-workspaces/missing/members",
        payload: { email: "member@example.test" }
      },
      {
        method: "GET" as const,
        url: "/api/collaboration-workspaces/missing/member-candidates?q=owner"
      }
    ]) {
      const response = await inject(app.server, "owner", request);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: {
          code: "FORBIDDEN",
          message: "Collaboration workspaces are not enabled for this instance"
        }
      });
    }

    await app.close();
  });

  it("searches add-member candidates for workspace owners and admins", async () => {
    const app = await createWorkspaceApp();
    await currentUser(app.server, "owner");
    const admin = await currentUser(app.server, "admin");
    await currentUser(app.server, "member");
    const outsider = await currentUser(app.server, "outsider");
    const workspaceId = await createSharedWorkspace(app.server, "owner", "Candidate search");
    await addWorkspaceMember(app.server, "owner", workspaceId, "admin@example.test");
    await inject(app.server, "owner", {
      method: "PATCH",
      url: `/api/collaboration-workspaces/${workspaceId}/members/${admin.id}`,
      payload: { role: "admin" }
    });
    await addWorkspaceMember(app.server, "owner", workspaceId, "member@example.test");

    await app.store.createUser({
      clientInstanceId,
      displayLabel: "Label Search Person",
      email: "label-result@example.test"
    });
    await app.store.createUser({
      clientInstanceId,
      displayLabel: "Email Result",
      email: "Mixed.Email@example.test"
    });
    const identityMatch = await app.store.createUser({
      clientInstanceId,
      displayLabel: "Identity Email Result"
    });
    await app.store.upsertUserIdentity({
      clientInstanceId,
      userId: identityMatch.id,
      authSource: "oidc",
      externalUserId: "candidate-identity",
      email: "Verified.Alias@example.test",
      emailVerified: true
    });
    await inject(app.server, "outsider", {
      method: "POST",
      url: `/api/collaboration-workspaces/${workspaceId}/access-requests`
    });

    const ownerLabelMatch = await inject(app.server, "owner", {
      method: "GET",
      url: `/api/collaboration-workspaces/${workspaceId}/member-candidates?q=SEARCH%20PERSON`
    });
    expect(ownerLabelMatch.statusCode).toBe(200);
    expect(ownerLabelMatch.json()).toEqual([
      {
        displayLabel: "Label Search Person",
        email: "label-result@example.test",
        hasPendingAccessRequest: false
      }
    ]);

    const adminEmailMatch = await inject(app.server, "admin", {
      method: "GET",
      url: `/api/collaboration-workspaces/${workspaceId}/member-candidates?q=MIXED.EMAIL`
    });
    expect(adminEmailMatch.statusCode).toBe(200);
    expect(adminEmailMatch.json()).toEqual([
      {
        displayLabel: "Email Result",
        email: "Mixed.Email@example.test",
        hasPendingAccessRequest: false
      }
    ]);

    const verifiedIdentityMatch = await inject(app.server, "owner", {
      method: "GET",
      url: `/api/collaboration-workspaces/${workspaceId}/member-candidates?q=VERIFIED.ALIAS`
    });
    expect(verifiedIdentityMatch.json()).toEqual([
      {
        displayLabel: "Identity Email Result",
        email: "Verified.Alias@example.test",
        hasPendingAccessRequest: false
      }
    ]);

    const pendingRequester = await inject(app.server, "owner", {
      method: "GET",
      url: `/api/collaboration-workspaces/${workspaceId}/member-candidates?q=OUTSIDER%40`
    });
    expect(pendingRequester.json()).toEqual([
      {
        displayLabel: "outsider",
        email: "outsider@example.test",
        hasPendingAccessRequest: true
      }
    ]);

    expect(
      (
        await inject(app.server, "owner", {
          method: "GET",
          url: `/api/collaboration-workspaces/${workspaceId}/member-candidates?q=MEMBER%40EXAMPLE`
        })
      ).json()
    ).toEqual([]);
    expect(
      (
        await inject(app.server, "owner", {
          method: "GET",
          url: `/api/collaboration-workspaces/${workspaceId}/member-candidates?q=%20a%20`
        })
      ).json()
    ).toEqual([]);
    expect(
      (
        await inject(app.server, "member", {
          method: "GET",
          url: `/api/collaboration-workspaces/${workspaceId}/member-candidates?q=search`
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await inject(app.server, "outsider", {
          method: "GET",
          url: `/api/collaboration-workspaces/${workspaceId}/member-candidates?q=search`
        })
      ).statusCode
    ).toBe(404);

    for (let index = 0; index < 10; index += 1) {
      await app.store.createUser({
        clientInstanceId,
        displayLabel: `Limit Candidate ${index.toString().padStart(2, "0")}`,
        email: `limit-${index}@example.test`
      });
    }
    const limited = await inject(app.server, "admin", {
      method: "GET",
      url: `/api/collaboration-workspaces/${workspaceId}/member-candidates?q=limit%20candidate`
    });
    expect(limited.statusCode).toBe(200);
    expect(limited.json()).toHaveLength(8);
    expect(limited.json()).toEqual(
      Array.from({ length: 8 }, (_, index) => ({
        displayLabel: `Limit Candidate ${index.toString().padStart(2, "0")}`,
        email: `limit-${index}@example.test`,
        hasPendingAccessRequest: false
      }))
    );

    const auditBefore = await app.store.listAuditEvents({ clientInstanceId });
    await inject(app.server, "owner", {
      method: "GET",
      url: `/api/collaboration-workspaces/${workspaceId}/member-candidates?q=email`
    });
    const auditAfter = await app.store.listAuditEvents({ clientInstanceId });
    expect(auditAfter).toHaveLength(auditBefore.length);

    await app.close();
  });

  it("keeps existing shared workspaces usable after the feature is disabled", async () => {
    const app = await createWorkspaceApp();
    await currentUser(app.server, "owner");
    await currentUser(app.server, "member");
    const workspaceId = await createSharedWorkspace(app.server, "owner", "Existing workspace");
    await addWorkspaceMember(app.server, "owner", workspaceId, "member@example.test");

    app.config.ui.collaborationWorkspaces.enabled = false;

    for (const actor of ["owner", "member"]) {
      const listed = await inject(app.server, actor, {
        method: "GET",
        url: "/api/collaboration-workspaces"
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toContainEqual(expect.objectContaining({ id: workspaceId }));

      const read = await inject(app.server, actor, {
        method: "GET",
        url: `/api/collaboration-workspaces/${workspaceId}`
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({ id: workspaceId, name: "Existing workspace" });
    }

    const left = await inject(app.server, "member", {
      method: "DELETE",
      url: `/api/collaboration-workspaces/${workspaceId}/members/me`
    });
    expect(left.statusCode).toBe(200);

    const deleted = await inject(app.server, "owner", {
      method: "DELETE",
      url: `/api/collaboration-workspaces/${workspaceId}`,
      payload: { confirmName: "Existing workspace" }
    });
    expect(deleted.statusCode).toBe(200);
    await expect(app.store.getWorkspace(clientInstanceId, workspaceId)).resolves.toBeUndefined();

    await app.close();
  });

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
    const collaborationWorkspaceId = created.json<{ id: string }>().id;

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
    const auditEvents = audit.json<
      Array<{
        type: string;
        metadata?: Record<string, unknown>;
      }>
    >();
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
    const collaborationWorkspaceId = created.json<{ id: string }>().id;

    const directory = await inject(app.server, "outsider", {
      method: "GET",
      url: "/api/collaboration-workspaces/directory"
    });
    expect(directory.statusCode).toBe(200);
    const directoryRow = directory
      .json<Array<Record<string, unknown>>>()
      .find((row) => row.id === collaborationWorkspaceId);
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
    const conversationId = explicit.json<{ id: string }>().id;
    await seedConversationMessage(app.store, conversationId);

    const defaulted = await inject(app.server, "owner", {
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Private thread" }
    });
    expect(defaulted.statusCode).toBe(200);
    expect(
      defaulted.json<{ collaborationWorkspaceId: string }>().collaborationWorkspaceId
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
      personalCreateAndRun.json<{ conversation: { collaborationWorkspaceId: string } }>()
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
    const runId = sent.json<{ run: { id: string } }>().run.id;
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

    const privateWorkspaceId = defaulted.json<{ collaborationWorkspaceId: string }>()
      .collaborationWorkspaceId;
    const privateConversationId = defaulted.json<{ id: string }>().id;
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
    const privateRunId = privateRun.json<{ run: { id: string } }>().run.id;
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

  it("makes a superadmin Owner of every shared workspace without a membership", async () => {
    const app = await createWorkspaceApp();
    const superadmin = await currentUser(app.server, "superadmin");
    await currentUser(app.server, "instance-admin");
    const member = await currentUser(app.server, "member");
    const outsider = await currentUser(app.server, "outsider");
    const workspaceId = await createSharedWorkspace(app.server, "member", "Team space");
    await inject(app.server, "outsider", {
      method: "POST",
      url: `/api/collaboration-workspaces/${workspaceId}/access-requests`
    });
    // Not discoverable from here on: the superadmin's access does not depend on visibility.
    await inject(app.server, "member", {
      method: "PATCH",
      url: `/api/collaboration-workspaces/${workspaceId}`,
      payload: { visibility: "private" }
    });
    const conversationId = await createConversation(app.server, "member", workspaceId, "Team");
    await seedConversationMessage(app.store, conversationId);

    const workspaceUrl = `/api/collaboration-workspaces/${workspaceId}`;
    const workspaceRows = z.array(z.looseObject({ id: z.string(), kind: z.string() }));
    const listWorkspaces = async (actor: string) =>
      workspaceRows.parse(
        (
          await inject(app.server, actor, { method: "GET", url: "/api/collaboration-workspaces" })
        ).json()
      );
    const listed = (await listWorkspaces("superadmin")).find((row) => row.id === workspaceId);
    // Pending requests stay a to-do for the workspace's own Owners and Admins.
    expect(listed).toMatchObject({
      role: "owner",
      membershipRole: null,
      pendingAccessRequestCount: 0
    });
    expect((await listWorkspaces("member")).find((row) => row.id === workspaceId)).toMatchObject({
      role: "owner",
      membershipRole: "owner",
      pendingAccessRequestCount: 1
    });

    // The instance role `admin` gives no workspace access.
    for (const actor of ["instance-admin", "outsider"]) {
      expect((await listWorkspaces(actor)).map((row) => row.id)).not.toContain(workspaceId);
      for (const url of [
        workspaceUrl,
        `${workspaceUrl}/members`,
        `${workspaceUrl}/agents`,
        `/api/conversations?collaborationWorkspaceId=${workspaceId}`,
        `/api/conversations/${conversationId}/thread`
      ]) {
        expect((await inject(app.server, actor, { method: "GET", url })).statusCode, url).toBe(404);
      }
    }

    for (const url of [
      workspaceUrl,
      `${workspaceUrl}/members`,
      `${workspaceUrl}/agents`,
      `${workspaceUrl}/access-requests`,
      `${workspaceUrl}/deletion-impact`,
      `/api/conversations/${conversationId}/thread`
    ]) {
      expect((await inject(app.server, "superadmin", { method: "GET", url })).statusCode, url).toBe(
        200
      );
    }
    const conversations = await inject(app.server, "superadmin", {
      method: "GET",
      url: `/api/conversations?collaborationWorkspaceId=${workspaceId}`
    });
    expect(
      z
        .array(z.object({ id: z.string() }))
        .parse(conversations.json())
        .map((row) => row.id)
    ).toEqual([conversationId]);

    const renamed = await inject(app.server, "superadmin", {
      method: "PATCH",
      url: workspaceUrl,
      payload: { name: "Renamed by the superadmin" }
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({
      name: "Renamed by the superadmin",
      role: "owner",
      membershipRole: null,
      pendingAccessRequestCount: 0
    });
    const approved = await inject(app.server, "superadmin", {
      method: "POST",
      url: `${workspaceUrl}/access-requests/${outsider.id}/approve`
    });
    expect(approved.statusCode).toBe(200);
    const promoted = await inject(app.server, "superadmin", {
      method: "PATCH",
      url: `${workspaceUrl}/members/${outsider.id}`,
      payload: { role: "owner" }
    });
    expect(promoted.statusCode).toBe(200);
    const audit = await inject(app.server, "superadmin", {
      method: "GET",
      url: "/api/audit-events"
    });
    expect(audit.json()).toContainEqual(
      expect.objectContaining({
        type: "collaboration_workspace.updated",
        subject: workspaceId,
        actor: expect.objectContaining({ userId: superadmin.id })
      })
    );

    // Without a membership there is nothing to leave, and the access is not a member row.
    const leaveWithoutMembership = await inject(app.server, "superadmin", {
      method: "DELETE",
      url: `${workspaceUrl}/members/me`
    });
    expect(leaveWithoutMembership.statusCode).toBe(409);
    expect(leaveWithoutMembership.json()).toMatchObject({
      error: { code: "CONFLICT", message: "User is not a workspace member" }
    });
    const members = await inject(app.server, "superadmin", {
      method: "GET",
      url: `${workspaceUrl}/members`
    });
    expect(
      z
        .array(z.object({ userId: z.string() }))
        .parse(members.json())
        .map((row) => row.userId)
        .sort()
    ).toEqual([member.id, outsider.id].sort());

    // A membership below Owner does not lower what the superadmin may do, and can be left again.
    await addWorkspaceMember(app.server, "superadmin", workspaceId, "superadmin@example.test");
    expect(
      (await listWorkspaces("superadmin")).find((row) => row.id === workspaceId)
    ).toMatchObject({ role: "owner", membershipRole: "member" });
    expect(
      (
        await inject(app.server, "superadmin", {
          method: "PATCH",
          url: workspaceUrl,
          payload: { description: "Still editable" }
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await inject(app.server, "superadmin", {
          method: "DELETE",
          url: `${workspaceUrl}/members/me`
        })
      ).statusCode
    ).toBe(200);
    expect(
      (await listWorkspaces("superadmin")).find((row) => row.id === workspaceId)
    ).toMatchObject({ role: "owner", membershipRole: null });

    // Personal Workspaces stay with their user.
    const personalWorkspaceId = (await listWorkspaces("member")).find(
      (row) => row.kind === "personal"
    )?.id;
    if (!personalWorkspaceId) throw new Error("The member has no Personal Workspace");
    const personalConversationId = await createConversation(
      app.server,
      "member",
      personalWorkspaceId,
      "Personal"
    );
    await seedConversationMessage(app.store, personalConversationId);
    expect((await listWorkspaces("superadmin")).map((row) => row.id)).not.toContain(
      personalWorkspaceId
    );
    for (const url of [
      `/api/collaboration-workspaces/${personalWorkspaceId}`,
      `/api/collaboration-workspaces/${personalWorkspaceId}/agents`,
      `/api/conversations?collaborationWorkspaceId=${personalWorkspaceId}`,
      `/api/conversations/${personalConversationId}/thread`
    ]) {
      expect((await inject(app.server, "superadmin", { method: "GET", url })).statusCode, url).toBe(
        404
      );
    }

    await app.close();
  });

  it("moves an idle conversation only for members of both workspaces and changes aggregate access", async () => {
    const app = await createWorkspaceApp();
    const owner = await currentUser(app.server, "owner");
    const member = await currentUser(app.server, "member");
    const sourceOnly = await currentUser(app.server, "declined");
    const destinationOnly = await currentUser(app.server, "direct");
    const sourceId = await createSharedWorkspace(app.server, "owner", "Move source");
    const destinationId = await createSharedWorkspace(app.server, "owner", "Move destination");
    await addWorkspaceMember(app.server, "owner", sourceId, "member@example.test");
    await addWorkspaceMember(app.server, "owner", destinationId, "member@example.test");
    await addWorkspaceMember(app.server, "owner", sourceId, "declined@example.test");
    await addWorkspaceMember(app.server, "owner", destinationId, "direct@example.test");

    const created = await inject(app.server, "owner", {
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Movable", collaborationWorkspaceId: sourceId }
    });
    const conversationId = created.json<{ id: string }>().id;
    const upload = createMultipartFilePayload({
      fieldName: "file",
      filename: "move.csv",
      contentType: "text/csv",
      content: "value\n42\n"
    });
    const uploaded = await app.server.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/draft-attachments`,
      headers: { ...upload.headers, "x-dev-user-id": "owner" },
      payload: upload.payload
    });
    expect(uploaded.statusCode).toBe(200);
    const fileId = uploaded.json<{ attachment: { fileId: string } }>().attachment.fileId;
    const runId = await createCompletedRun(app, conversationId, owner.id);

    const missingDestinationMembership = await inject(app.server, "declined", {
      method: "POST",
      url: `/api/conversations/${conversationId}/move`,
      payload: { collaborationWorkspaceId: destinationId }
    });
    expect(missingDestinationMembership.statusCode).toBe(404);
    expect(missingDestinationMembership.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    const missingSourceMembership = await inject(app.server, "direct", {
      method: "POST",
      url: `/api/conversations/${conversationId}/move`,
      payload: { collaborationWorkspaceId: destinationId }
    });
    expect(missingSourceMembership.statusCode).toBe(404);
    expect(missingSourceMembership.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    const sameWorkspace = await inject(app.server, "owner", {
      method: "POST",
      url: `/api/conversations/${conversationId}/move`,
      payload: { collaborationWorkspaceId: sourceId }
    });
    expect(sameWorkspace.statusCode).toBe(422);
    expect(sameWorkspace.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED" }
    });

    const busyConversation = await inject(app.server, "owner", {
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Busy", collaborationWorkspaceId: sourceId }
    });
    const busyConversationId = busyConversation.json<{ id: string }>().id;
    await createActiveRun(app, busyConversationId, owner.id);
    const busyMove = await inject(app.server, "owner", {
      method: "POST",
      url: `/api/conversations/${busyConversationId}/move`,
      payload: { collaborationWorkspaceId: destinationId }
    });
    expect(busyMove.statusCode).toBe(409);
    expect(busyMove.json()).toMatchObject({ error: { code: "CONFLICT" } });

    const moved = await inject(app.server, "member", {
      method: "POST",
      url: `/api/conversations/${conversationId}/move`,
      payload: { collaborationWorkspaceId: destinationId }
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ collaborationWorkspaceId: destinationId });

    for (const url of [
      `/api/conversations/${conversationId}/thread`,
      `/api/conversations/${conversationId}/draft-attachments`,
      `/api/conversations/${conversationId}/runs/${runId}/events`
    ]) {
      expect((await inject(app.server, "declined", { method: "GET", url })).statusCode).toBe(404);
    }
    expect(
      (
        await inject(app.server, "direct", {
          method: "GET",
          url: `/api/conversations/${conversationId}/thread`
        })
      ).statusCode
    ).toBe(200);
    const destinationFiles = await inject(app.server, "direct", {
      method: "GET",
      url: `/api/conversations/${conversationId}/draft-attachments`
    });
    expect(destinationFiles.statusCode).toBe(200);
    expect(destinationFiles.json()).toContainEqual(expect.objectContaining({ fileId }));
    expect(
      (
        await inject(app.server, "direct", {
          method: "GET",
          url: `/api/conversations/${conversationId}/runs/${runId}/events`
        })
      ).statusCode
    ).toBe(200);

    const audit = await inject(app.server, "owner", { method: "GET", url: "/api/audit-events" });
    expect(audit.json()).toContainEqual(
      expect.objectContaining({
        type: "conversation.moved",
        subject: conversationId,
        metadata: {
          fromCollaborationWorkspaceId: sourceId,
          toCollaborationWorkspaceId: destinationId
        }
      })
    );
    expect(member.id).toBeTruthy();
    expect(sourceOnly.id).toBeTruthy();
    expect(destinationOnly.id).toBeTruthy();
    await app.close();
  });

  it("deletes a shared workspace through owner-only cleanup and retains minimized audit events", async () => {
    const app = await createWorkspaceApp();
    const owner = await currentUser(app.server, "owner");
    const admin = await currentUser(app.server, "admin");
    const member = await currentUser(app.server, "member");
    const requester = await currentUser(app.server, "outsider");
    const workspaceId = await createSharedWorkspace(app.server, "owner", "Delete me exactly");
    await addWorkspaceMember(app.server, "owner", workspaceId, "admin@example.test");
    await inject(app.server, "owner", {
      method: "PATCH",
      url: `/api/collaboration-workspaces/${workspaceId}/members/${admin.id}`,
      payload: { role: "admin" }
    });
    await addWorkspaceMember(app.server, "owner", workspaceId, "member@example.test");
    await inject(app.server, "outsider", {
      method: "POST",
      url: `/api/collaboration-workspaces/${workspaceId}/access-requests`
    });
    const first = await createConversation(app.server, "owner", workspaceId, "First deletion");
    const second = await createConversation(app.server, "owner", workspaceId, "Second deletion");

    const impact = await inject(app.server, "owner", {
      method: "GET",
      url: `/api/collaboration-workspaces/${workspaceId}/deletion-impact`
    });
    expect(impact.statusCode).toBe(200);
    expect(impact.json()).toEqual({
      conversationCount: 2,
      memberCount: 3,
      pendingAccessRequestCount: 1
    });
    const adminImpact = await inject(app.server, "admin", {
      method: "GET",
      url: `/api/collaboration-workspaces/${workspaceId}/deletion-impact`
    });
    expect(adminImpact.statusCode).toBe(403);
    expect(adminImpact.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    const adminDelete = await inject(app.server, "admin", {
      method: "DELETE",
      url: `/api/collaboration-workspaces/${workspaceId}`,
      payload: { confirmName: "Delete me exactly" }
    });
    expect(adminDelete.statusCode).toBe(403);
    const mismatch = await inject(app.server, "owner", {
      method: "DELETE",
      url: `/api/collaboration-workspaces/${workspaceId}`,
      payload: { confirmName: "delete me exactly" }
    });
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });

    const ownerWorkspaces = (
      await inject(app.server, "owner", {
        method: "GET",
        url: "/api/collaboration-workspaces"
      })
    ).json<Array<{ id: string; kind: string; name: string }>>();
    const personal = ownerWorkspaces.find((workspace) => workspace.kind === "personal")!;
    const personalDelete = await inject(app.server, "owner", {
      method: "DELETE",
      url: `/api/collaboration-workspaces/${personal.id}`,
      payload: { confirmName: personal.name }
    });
    expect(personalDelete.statusCode).toBe(422);
    expect(personalDelete.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });

    const activeRunId = await createActiveRun(app, second, owner.id);
    const busyDelete = await inject(app.server, "owner", {
      method: "DELETE",
      url: `/api/collaboration-workspaces/${workspaceId}`,
      payload: { confirmName: "Delete me exactly" }
    });
    expect(busyDelete.statusCode).toBe(409);
    expect(busyDelete.json()).toMatchObject({ error: { code: "CONFLICT" } });
    await app.store.updateAgentRunStatus({
      clientInstanceId,
      runId: activeRunId,
      status: "completed",
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    });

    const upload = createMultipartFilePayload({
      fieldName: "file",
      filename: "delete.csv",
      contentType: "text/csv",
      content: "delete,me\n"
    });
    const uploaded = await app.server.inject({
      method: "POST",
      url: `/api/conversations/${first}/draft-attachments`,
      headers: { ...upload.headers, "x-dev-user-id": "owner" },
      payload: upload.payload
    });
    const fileId = uploaded.json<{ attachment: { fileId: string } }>().attachment.fileId;
    const executionWorkspace = await app.store.ensureExecutionWorkspace({
      clientInstanceId,
      conversationId: asConversationId(first),
      ownerUserId: owner.id
    });
    const objectKey = `phase-d/${first}/workspace.txt`;
    const objectPath = join(WORKSPACE_OBJECT_ROOT, objectKey);
    await mkdir(dirname(objectPath), { recursive: true });
    await writeFile(objectPath, "workspace bytes");
    await app.store.upsertWorkspaceFile({
      clientInstanceId,
      workspaceId: executionWorkspace.id,
      path: "workspace.txt",
      objectKey,
      byteSize: 15,
      checksum: "phase-d-workspace",
      metadata: {}
    });

    const deleted = await inject(app.server, "owner", {
      method: "DELETE",
      url: `/api/collaboration-workspaces/${workspaceId}`,
      payload: { confirmName: "Delete me exactly" }
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({
      collaborationWorkspaceId: workspaceId,
      conversationCount: 2,
      fileCount: 2,
      memberCount: 3
    });
    await expect(access(objectPath)).rejects.toThrow();
    await expect(app.store.getWorkspace(clientInstanceId, workspaceId)).resolves.toBeUndefined();
    await expect(
      app.store.getConversation(clientInstanceId, asConversationId(first))
    ).resolves.toBeUndefined();
    await expect(
      app.store.getExecutionWorkspaceForConversation({
        clientInstanceId,
        conversationId: asConversationId(first)
      })
    ).resolves.toBeUndefined();
    await expect(
      app.store.getMembership({
        clientInstanceId,
        collaborationWorkspaceId: asCollaborationWorkspaceId(workspaceId),
        userId: member.id
      })
    ).resolves.toBeUndefined();
    await expect(
      app.store.getAccessRequest({
        clientInstanceId,
        collaborationWorkspaceId: asCollaborationWorkspaceId(workspaceId),
        userId: requester.id
      })
    ).resolves.toBeUndefined();
    for (const url of [
      `/api/collaboration-workspaces/${workspaceId}`,
      `/api/conversations/${first}/thread`,
      `/api/conversations/${first}/files/${fileId}/content`,
      `/api/conversations/${second}/runs/${activeRunId}/events`
    ]) {
      expect((await inject(app.server, "member", { method: "GET", url })).statusCode).toBe(404);
    }

    const audit = (
      await inject(app.server, "owner", {
        method: "GET",
        url: "/api/audit-events"
      })
    ).json<Array<{ type: string; subject: string; metadata?: Record<string, unknown> }>>();
    expect(audit).toContainEqual(
      expect.objectContaining({
        type: "collaboration_workspace.deleted",
        subject: workspaceId,
        metadata: { conversationCount: 2, fileCount: 2, memberCount: 3 }
      })
    );
    expect(
      audit.filter(
        (event) =>
          event.type === "conversation.deleted" &&
          event.metadata?.requestedBy === "workspace_deletion"
      )
    ).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain("Delete me exactly");
    await app.close();
  });

  it("finishes workspace deletion after one conversation was already cleaned up", async () => {
    const app = await createWorkspaceApp();
    await currentUser(app.server, "owner");
    const workspaceId = await createSharedWorkspace(app.server, "owner", "Retry cleanup");
    const first = await createConversation(app.server, "owner", workspaceId, "Already deleted");
    const second = await createConversation(app.server, "owner", workspaceId, "Still present");
    expect(
      (
        await inject(app.server, "owner", {
          method: "DELETE",
          url: `/api/conversations/${first}`
        })
      ).statusCode
    ).toBe(200);

    const deleted = await inject(app.server, "owner", {
      method: "DELETE",
      url: `/api/collaboration-workspaces/${workspaceId}`,
      payload: { confirmName: "Retry cleanup" }
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ conversationCount: 1 });
    await expect(
      app.store.getConversation(clientInstanceId, asConversationId(first))
    ).resolves.toBeUndefined();
    await expect(
      app.store.getConversation(clientInstanceId, asConversationId(second))
    ).resolves.toBeUndefined();
    await app.close();
  });

  it("preserves a conversation moved after workspace deletion enumerates it", async () => {
    const app = await createWorkspaceApp();
    await currentUser(app.server, "owner");
    const workspaceId = await createSharedWorkspace(app.server, "owner", "Delete source");
    const destinationId = await createSharedWorkspace(app.server, "owner", "Keep destination");
    const moved = await createConversation(app.server, "owner", workspaceId, "Move during delete");
    const deletedConversation = await createConversation(
      app.server,
      "owner",
      workspaceId,
      "Delete normally"
    );
    await app.store.appendMessage({
      clientInstanceId,
      conversationId: asConversationId(moved),
      role: "user",
      text: "preserve this data"
    });

    const getConversation = app.store.getConversation.bind(app.store);
    let movedDuringDeletion = false;
    app.store.getConversation = async (requestedClientInstanceId, conversationId) => {
      if (!movedDuringDeletion && conversationId === moved) {
        movedDuringDeletion = true;
        await app.store.moveConversation({
          clientInstanceId,
          conversationId: asConversationId(moved),
          fromCollaborationWorkspaceId: asCollaborationWorkspaceId(workspaceId),
          toCollaborationWorkspaceId: asCollaborationWorkspaceId(destinationId),
          visibility: "workspace"
        });
      }
      return getConversation(requestedClientInstanceId, conversationId);
    };

    const deleted = await inject(app.server, "owner", {
      method: "DELETE",
      url: `/api/collaboration-workspaces/${workspaceId}`,
      payload: { confirmName: "Delete source" }
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ conversationCount: 1 });
    await expect(
      app.store.getConversation(clientInstanceId, asConversationId(moved))
    ).resolves.toMatchObject({ collaborationWorkspaceId: destinationId, status: "active" });
    await expect(
      app.store.listMessages({
        clientInstanceId,
        conversationId: asConversationId(moved)
      })
    ).resolves.toEqual([expect.objectContaining({ text: "preserve this data" })]);
    await expect(
      app.store.getConversation(clientInstanceId, asConversationId(deletedConversation))
    ).resolves.toBeUndefined();
    await expect(app.store.getWorkspace(clientInstanceId, workspaceId)).resolves.toBeUndefined();
    await app.close();
  });
});

describe("Conversation visibility", () => {
  it("lists a conversation without messages only to its creator while it holds draft attachments", async () => {
    const app = await createWorkspaceApp();
    await currentUser(app.server, "owner");
    await currentUser(app.server, "member");
    const workspaceId = await createSharedWorkspace(app.server, "owner", "Unsent drafts");
    await addWorkspaceMember(app.server, "owner", workspaceId, "member@example.test");
    const listedIds = async (actor: string) => {
      const listed = await inject(app.server, actor, {
        method: "GET",
        url: `/api/conversations?collaborationWorkspaceId=${workspaceId}`
      });
      expect(listed.statusCode).toBe(200);
      return listed.json<Array<{ id: string }>>().map((row) => row.id);
    };

    // The composer creates the conversation before the first upload lands.
    const conversationId = await createConversation(
      app.server,
      "owner",
      workspaceId,
      "2 attached files"
    );
    await expect(
      app.store.getConversation(clientInstanceId, asConversationId(conversationId))
    ).resolves.toMatchObject({ visibility: "workspace" });
    await expect(listedIds("owner")).resolves.toEqual([]);
    await expect(listedIds("member")).resolves.toEqual([]);

    const attachmentIds: string[] = [];
    for (const filename of ["first.csv", "second.csv"]) {
      const upload = createMultipartFilePayload({
        fieldName: "file",
        filename,
        contentType: "text/csv",
        content: `value\n${filename}\n`
      });
      const uploaded = await app.server.inject({
        method: "POST",
        url: `/api/conversations/${conversationId}/draft-attachments`,
        headers: { ...upload.headers, "x-dev-user-id": "owner" },
        payload: upload.payload
      });
      expect(uploaded.statusCode).toBe(200);
      attachmentIds.push(uploaded.json<{ attachment: { id: string } }>().attachment.id);
    }
    await expect(listedIds("owner")).resolves.toEqual([conversationId]);
    await expect(listedIds("member")).resolves.toEqual([]);
    // Listing is narrower than access: the workspace-visible conversation stays reachable.
    const memberThread = await inject(app.server, "member", {
      method: "GET",
      url: `/api/conversations/${conversationId}/thread`
    });
    expect(memberThread.statusCode).toBe(200);

    const [firstAttachmentId, secondAttachmentId] = attachmentIds;
    const removeDraft = (attachmentId: string | undefined) =>
      inject(app.server, "owner", {
        method: "DELETE",
        url: `/api/conversations/${conversationId}/draft-attachments/${attachmentId}`
      });
    expect((await removeDraft(firstAttachmentId)).statusCode).toBe(200);
    await expect(listedIds("owner")).resolves.toEqual([conversationId]);
    expect((await removeDraft(secondAttachmentId)).statusCode).toBe(200);
    await expect(listedIds("owner")).resolves.toEqual([]);
    await expect(listedIds("member")).resolves.toEqual([]);

    await seedConversationMessage(app.store, conversationId);
    await expect(listedIds("owner")).resolves.toEqual([conversationId]);
    await expect(listedIds("member")).resolves.toEqual([conversationId]);
    await app.close();
  });

  it("hides a private conversation from every non-author role on every conversation route", async () => {
    const fixture = await createPrivateConversationFixture();
    const { app, workspaceId, conversationId, sharedConversationId } = fixture;
    const routes = conversationRoutes(fixture);

    // "owner" is a superadmin with a membership, "superadmin" one without.
    for (const actor of ["owner", "admin", "member", "outsider", "superadmin"]) {
      for (const route of routes) {
        const denied = await route.send(actor, conversationId);
        const missing = await route.send(actor, "conv_missing");
        expect(
          { route: route.name, actor, status: denied.statusCode, body: denied.json() },
          `${actor} ${route.name}`
        ).toEqual({
          route: route.name,
          actor,
          status: 404,
          body: { error: { code: "NOT_FOUND", message: "Conversation is not available" } }
        });
        expect({ status: denied.statusCode, body: denied.body }).toEqual({
          status: missing.statusCode,
          body: missing.body
        });
      }
    }

    for (const actor of ["owner", "admin", "member", "superadmin"]) {
      const listed = await inject(app.server, actor, {
        method: "GET",
        url: `/api/conversations?collaborationWorkspaceId=${workspaceId}`
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json<Array<{ id: string }>>().map((row) => row.id)).toEqual([
        sharedConversationId
      ]);
    }
    const listedByAuthor = await inject(app.server, "direct", {
      method: "GET",
      url: `/api/conversations?collaborationWorkspaceId=${workspaceId}`
    });
    expect(
      listedByAuthor
        .json<Array<{ id: string }>>()
        .map((row) => row.id)
        .sort()
    ).toEqual([conversationId, sharedConversationId].sort());

    // Nothing a non-author sent may have changed the conversation: still the two fixture
    // messages and the one draft attachment.
    await expect(
      app.store.getConversation(clientInstanceId, asConversationId(conversationId))
    ).resolves.toMatchObject({
      status: "active",
      title: "Private thread",
      visibility: "private",
      collaborationWorkspaceId: workspaceId
    });
    await expect(
      app.store.listMessages({ clientInstanceId, conversationId: asConversationId(conversationId) })
    ).resolves.toHaveLength(2);
    await expect(
      app.store.listDraftAttachments({
        clientInstanceId,
        conversationId: asConversationId(conversationId)
      })
    ).resolves.toHaveLength(1);

    // The deletion impact keeps counting every conversation, private ones included.
    const impact = await inject(app.server, "owner", {
      method: "GET",
      url: `/api/collaboration-workspaces/${workspaceId}/deletion-impact`
    });
    expect(impact.json()).toMatchObject({ conversationCount: 2 });

    // Positive control: the author passes the access check on every route, so the matrix above
    // cannot pass because of a mistyped URL.
    for (const route of routes) {
      const allowed = await route.send("direct", conversationId);
      expect(
        allowed.statusCode === 404 &&
          allowed.json<{ error?: { message?: string } }>().error?.message ===
            "Conversation is not available",
        `author ${route.name} -> ${allowed.statusCode} ${allowed.body.slice(0, 200)}`
      ).toBe(false);
    }
    await app.close();
  });

  it("keeps a private conversation closed while its author is not a member", async () => {
    const { app, workspaceId, conversationId, author } = await createPrivateConversationFixture();
    const thread = { method: "GET" as const, url: `/api/conversations/${conversationId}/thread` };

    const removed = await inject(app.server, "owner", {
      method: "DELETE",
      url: `/api/collaboration-workspaces/${workspaceId}/members/${author.id}`
    });
    expect(removed.statusCode).toBe(200);
    for (const actor of ["direct", "owner", "admin", "member"]) {
      expect((await inject(app.server, actor, thread)).statusCode, actor).toBe(404);
    }
    await expect(
      app.store.getConversation(clientInstanceId, asConversationId(conversationId))
    ).resolves.toMatchObject({ status: "active", visibility: "private" });

    await addWorkspaceMember(app.server, "owner", workspaceId, "direct@example.test");
    expect((await inject(app.server, "direct", thread)).statusCode).toBe(200);
    for (const actor of ["owner", "admin", "member"]) {
      expect((await inject(app.server, actor, thread)).statusCode, actor).toBe(404);
    }
    await app.close();
  });

  it("stamps the workspace default at creation and never rewrites existing conversations", async () => {
    const app = await createWorkspaceApp();
    for (const actor of ["owner", "admin", "member"]) await currentUser(app.server, actor);
    const admin = await currentUser(app.server, "admin");
    const created = await inject(app.server, "owner", {
      method: "POST",
      url: "/api/collaboration-workspaces",
      payload: { name: "Private by default", defaultConversationVisibility: "private" }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ defaultConversationVisibility: "private" });
    const workspaceId = created.json<{ id: string }>().id;
    await addWorkspaceMember(app.server, "owner", workspaceId, "admin@example.test");
    await addWorkspaceMember(app.server, "owner", workspaceId, "member@example.test");
    await inject(app.server, "owner", {
      method: "PATCH",
      url: `/api/collaboration-workspaces/${workspaceId}/members/${admin.id}`,
      payload: { role: "admin" }
    });

    const defaultWorkspaceId = await createSharedWorkspace(app.server, "owner", "Open by default");
    const workspaces = await inject(app.server, "owner", {
      method: "GET",
      url: "/api/collaboration-workspaces"
    });
    expect(workspaces.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: defaultWorkspaceId,
          defaultConversationVisibility: "workspace"
        }),
        expect.objectContaining({ kind: "personal", defaultConversationVisibility: "workspace" })
      ])
    );

    const privateConversation = await inject(app.server, "member", {
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Stamped private", collaborationWorkspaceId: workspaceId }
    });
    expect(privateConversation.json()).toMatchObject({ visibility: "private" });
    const privateConversationId = privateConversation.json<{ id: string }>().id;
    const createdWithRun = await inject(app.server, "member", {
      method: "POST",
      url: "/api/conversations/runs",
      payload: {
        idempotencyKey: "stamped-create-and-run",
        message: { text: "Hello" },
        conversation: { title: "Stamped by create-and-run", collaborationWorkspaceId: workspaceId }
      }
    });
    expect(createdWithRun.statusCode).toBe(200);
    expect(createdWithRun.json()).toMatchObject({
      conversation: { visibility: "private" },
      thread: { conversation: { visibility: "private" } }
    });
    const personalConversation = await inject(app.server, "member", {
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Personal" }
    });
    expect(personalConversation.json()).toMatchObject({ visibility: "workspace" });

    const byMember = await inject(app.server, "member", {
      method: "PATCH",
      url: `/api/collaboration-workspaces/${workspaceId}`,
      payload: { defaultConversationVisibility: "workspace" }
    });
    expect(byMember.statusCode).toBe(403);
    const byAdmin = await inject(app.server, "admin", {
      method: "PATCH",
      url: `/api/collaboration-workspaces/${workspaceId}`,
      payload: { defaultConversationVisibility: "workspace" }
    });
    expect(byAdmin.statusCode).toBe(200);
    expect(byAdmin.json()).toMatchObject({ defaultConversationVisibility: "workspace" });

    const openConversation = await inject(app.server, "member", {
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Stamped open", collaborationWorkspaceId: workspaceId }
    });
    expect(openConversation.json()).toMatchObject({ visibility: "workspace" });
    const openConversationId = openConversation.json<{ id: string }>().id;
    await expect(
      app.store.getConversation(clientInstanceId, asConversationId(privateConversationId))
    ).resolves.toMatchObject({ visibility: "private" });
    expect(
      (
        await inject(app.server, "owner", {
          method: "GET",
          url: `/api/conversations/${privateConversationId}/thread`
        })
      ).statusCode
    ).toBe(404);

    await inject(app.server, "owner", {
      method: "PATCH",
      url: `/api/collaboration-workspaces/${workspaceId}`,
      payload: { defaultConversationVisibility: "private" }
    });
    await expect(
      app.store.getConversation(clientInstanceId, asConversationId(openConversationId))
    ).resolves.toMatchObject({ visibility: "workspace" });
    expect(
      (
        await inject(app.server, "owner", {
          method: "GET",
          url: `/api/conversations/${openConversationId}/thread`
        })
      ).statusCode
    ).toBe(200);

    const personalWorkspaceId = personalConversation.json<{ collaborationWorkspaceId: string }>()
      .collaborationWorkspaceId;
    await expect(
      app.store.updateWorkspace({
        clientInstanceId,
        collaborationWorkspaceId: asCollaborationWorkspaceId(personalWorkspaceId),
        defaultConversationVisibility: "private"
      })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await app.close();
  });

  it("applies the move visibility rule", async () => {
    const app = await createWorkspaceApp();
    for (const actor of ["owner", "member"]) await currentUser(app.server, actor);
    const openId = await createSharedWorkspace(app.server, "owner", "Open");
    const otherOpenId = await createSharedWorkspace(app.server, "owner", "Other open");
    const privateDefault = await inject(app.server, "owner", {
      method: "POST",
      url: "/api/collaboration-workspaces",
      payload: { name: "Private default", defaultConversationVisibility: "private" }
    });
    const privateDefaultId = privateDefault.json<{ id: string }>().id;
    for (const workspaceId of [openId, otherOpenId, privateDefaultId]) {
      await addWorkspaceMember(app.server, "owner", workspaceId, "member@example.test");
    }
    const personalWorkspaceId = (
      await inject(app.server, "member", { method: "GET", url: "/api/collaboration-workspaces" })
    )
      .json<Array<{ id: string; kind: string }>>()
      .find((workspace) => workspace.kind === "personal")!.id;
    const move = (
      actor: string,
      conversationId: string,
      collaborationWorkspaceId: string,
      visibility?: "workspace" | "private"
    ) =>
      inject(app.server, actor, {
        method: "POST",
        url: `/api/conversations/${conversationId}/move`,
        payload: { collaborationWorkspaceId, ...(visibility ? { visibility } : {}) }
      });

    // A private conversation stays private unless the request says otherwise.
    const privateId = await createConversation(app.server, "member", privateDefaultId, "Private");
    const keptPrivate = await move("member", privateId, openId);
    expect(keptPrivate.statusCode).toBe(200);
    expect(keptPrivate.json()).toMatchObject({
      collaborationWorkspaceId: openId,
      visibility: "private"
    });
    expect((await move("owner", privateId, otherOpenId)).statusCode).toBe(404);
    const opened = await move("member", privateId, otherOpenId, "workspace");
    expect(opened.json()).toMatchObject({
      collaborationWorkspaceId: otherOpenId,
      visibility: "workspace"
    });

    // A workspace-visible conversation takes the destination default.
    const creatorIntoPrivateDefault = await move("member", privateId, privateDefaultId);
    expect(creatorIntoPrivateDefault.json()).toMatchObject({ visibility: "private" });
    const ownersId = await createConversation(app.server, "owner", openId, "Owner's");
    const nonCreatorIntoPrivateDefault = await move("member", ownersId, privateDefaultId);
    expect(nonCreatorIntoPrivateDefault.statusCode).toBe(422);
    expect(nonCreatorIntoPrivateDefault.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED" }
    });
    expect((await move("member", ownersId, otherOpenId, "private")).statusCode).toBe(422);
    await expect(
      app.store.getConversation(clientInstanceId, asConversationId(ownersId))
    ).resolves.toMatchObject({ collaborationWorkspaceId: openId, visibility: "workspace" });
    const nonCreatorExplicit = await move("member", ownersId, privateDefaultId, "workspace");
    expect(nonCreatorExplicit.statusCode).toBe(200);
    expect(nonCreatorExplicit.json()).toMatchObject({
      collaborationWorkspaceId: privateDefaultId,
      visibility: "workspace"
    });
    const explicitOverDefault = await move("owner", ownersId, openId, "private");
    expect(explicitOverDefault.json()).toMatchObject({ visibility: "private" });

    // A Personal Workspace only holds workspace-visible conversations.
    const intoPersonal = await move("member", privateId, personalWorkspaceId, "private");
    expect(intoPersonal.statusCode).toBe(200);
    expect(intoPersonal.json()).toMatchObject({
      collaborationWorkspaceId: personalWorkspaceId,
      visibility: "workspace"
    });
    await app.close();
  });
});

type ConversationRouteCase = {
  name: string;
  send(actor: string, conversationId: string): ReturnType<typeof inject>;
};

async function createPrivateConversationFixture() {
  const app = await createWorkspaceApp();
  await currentUser(app.server, "owner");
  const admin = await currentUser(app.server, "admin");
  await currentUser(app.server, "member");
  await currentUser(app.server, "outsider");
  await currentUser(app.server, "superadmin");
  const author = await currentUser(app.server, "direct");
  const created = await inject(app.server, "owner", {
    method: "POST",
    url: "/api/collaboration-workspaces",
    payload: { name: "Visibility matrix", defaultConversationVisibility: "private" }
  });
  const workspaceId = created.json<{ id: string }>().id;
  for (const email of ["admin@example.test", "member@example.test", "direct@example.test"]) {
    await addWorkspaceMember(app.server, "owner", workspaceId, email);
  }
  const promoted = await inject(app.server, "owner", {
    method: "PATCH",
    url: `/api/collaboration-workspaces/${workspaceId}/members/${admin.id}`,
    payload: { role: "admin" }
  });
  expect(promoted.statusCode).toBe(200);

  const conversationId = await createConversation(
    app.server,
    "direct",
    workspaceId,
    "Private thread"
  );
  await app.store.appendMessage({
    clientInstanceId,
    conversationId: asConversationId(conversationId),
    role: "user",
    text: "private content"
  });
  const upload = createMultipartFilePayload({
    fieldName: "file",
    filename: "private.csv",
    contentType: "text/csv",
    content: "value\n42\n"
  });
  const uploaded = await app.server.inject({
    method: "POST",
    url: `/api/conversations/${conversationId}/draft-attachments`,
    headers: { ...upload.headers, "x-dev-user-id": "direct" },
    payload: upload.payload
  });
  expect(uploaded.statusCode).toBe(200);
  const attachment = uploaded.json<{ attachment: { id: string; fileId: string } }>().attachment;
  const artifact = await app.store.createManagedArtifact({
    clientInstanceId,
    conversationId: asConversationId(conversationId),
    kind: "file",
    objectKey: "private-matrix-artifact",
    filename: "private.txt",
    mimeType: "text/plain",
    byteSize: 7,
    checksum: "private"
  });
  const runId = await createCompletedRun(app, conversationId, author.id);

  // A workspace-visible neighbour proves the list filter is per conversation, not per workspace.
  await inject(app.server, "owner", {
    method: "PATCH",
    url: `/api/collaboration-workspaces/${workspaceId}`,
    payload: { defaultConversationVisibility: "workspace" }
  });
  const sharedConversationId = await createConversation(
    app.server,
    "direct",
    workspaceId,
    "Shared thread"
  );
  await seedConversationMessage(app.store, sharedConversationId);
  return {
    app,
    author,
    workspaceId,
    conversationId,
    sharedConversationId,
    attachmentId: attachment.id,
    fileId: attachment.fileId,
    artifactId: artifact.id,
    runId
  };
}

function conversationRoutes(
  fixture: Awaited<ReturnType<typeof createPrivateConversationFixture>>
): ConversationRouteCase[] {
  const { app, workspaceId, attachmentId, fileId, artifactId, runId } = fixture;
  const json =
    (
      method: "GET" | "POST" | "PATCH" | "DELETE",
      path: string,
      payload?: unknown
    ): ConversationRouteCase["send"] =>
    (actor, conversationId) =>
      inject(app.server, actor, {
        method,
        url: `/api/conversations/${conversationId}${path}`,
        ...(payload === undefined ? {} : { payload })
      });
  return [
    { name: "thread", send: json("GET", "/thread") },
    { name: "messages", send: json("GET", "/messages") },
    { name: "resources", send: json("GET", "/resources") },
    { name: "structured data", send: json("GET", "/structured-data/sdr_missing") },
    { name: "generate title", send: json("POST", "/title") },
    { name: "rename", send: json("PATCH", "/title", { title: "Renamed by someone else" }) },
    {
      name: "start run",
      // The unknown model binding stops the author's positive control after the access check.
      send: json("POST", "/runs", {
        idempotencyKey: "visibility-matrix",
        message: { text: "Hello" },
        modelBindingId: "not-selectable"
      })
    },
    { name: "run events", send: json("GET", `/runs/${runId}/events`) },
    { name: "cancel run", send: json("POST", `/runs/${runId}/cancel`, {}) },
    {
      name: "command run",
      send: json("POST", `/runs/${runId}/commands`, { command: { type: "continue" } })
    },
    { name: "list draft attachments", send: json("GET", "/draft-attachments") },
    {
      name: "upload draft attachment",
      send: (actor, conversationId) => {
        const upload = createMultipartFilePayload({
          fieldName: "file",
          filename: "intruder.csv",
          contentType: "text/csv",
          content: "value\n1\n"
        });
        return app.server.inject({
          method: "POST",
          url: `/api/conversations/${conversationId}/draft-attachments`,
          headers: { ...upload.headers, "x-dev-user-id": actor },
          payload: upload.payload
        });
      }
    },
    {
      name: "retry draft attachment",
      send: json("POST", `/draft-attachments/${attachmentId}/retry`)
    },
    { name: "file content", send: json("GET", `/files/${fileId}/content`) },
    { name: "file download", send: json("GET", `/files/${fileId}/content?download=true`) },
    { name: "artifact content", send: json("GET", `/artifacts/${artifactId}/content`) },
    { name: "artifact preview", send: json("GET", `/artifacts/${artifactId}/preview`) },
    { name: "attachment preview", send: json("GET", `/attachments/${attachmentId}/preview`) },
    {
      name: "retry artifact preview",
      send: json("POST", `/artifacts/${artifactId}/preview/retry`)
    },
    { name: "delete draft attachment", send: json("DELETE", `/draft-attachments/${attachmentId}`) },
    // Same-workspace move: denied for non-authors, a validation error for the author.
    { name: "move", send: json("POST", "/move", { collaborationWorkspaceId: workspaceId }) },
    { name: "delete", send: json("DELETE", "") }
  ];
}

const WORKSPACE_OBJECT_ROOT = "/tmp/vivd-catalyst-phase-d-workspace-objects";

async function createWorkspaceApp(collaborationWorkspacesEnabled = true) {
  return createClientInstanceApp({
    config: createTestConfig({
      collaborationWorkspacesEnabled,
      developmentAuth: {
        enabled: true,
        defaultUserId: "owner",
        users: [
          testIdentity("owner", "owner@example.test", ["user", "admin", "superadmin"]),
          testIdentity("admin", "admin@example.test"),
          testIdentity("member", "member@example.test"),
          testIdentity("outsider", "outsider@example.test"),
          testIdentity("declined", "declined@example.test"),
          testIdentity("direct", "direct@example.test"),
          testIdentity("superadmin", "superadmin@example.test", ["user", "admin", "superadmin"]),
          testIdentity("instance-admin", "instance-admin@example.test", ["user", "admin"])
        ]
      },
      executionWorkspaces: { enabled: true }
    }),
    env: { EXECUTION_WORKSPACE_OBJECT_ROOT: WORKSPACE_OBJECT_ROOT },
    storeMode: "memory",
    tools: []
  });
}

async function createSharedWorkspace(server: TestServer, actor: string, name: string) {
  const response = await inject(server, actor, {
    method: "POST",
    url: "/api/collaboration-workspaces",
    payload: { name }
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ id: string }>().id;
}

async function addWorkspaceMember(
  server: TestServer,
  actor: string,
  collaborationWorkspaceId: string,
  email: string
) {
  const response = await inject(server, actor, {
    method: "POST",
    url: `/api/collaboration-workspaces/${collaborationWorkspaceId}/members`,
    payload: { email }
  });
  expect(response.statusCode).toBe(200);
}

async function createConversation(
  server: TestServer,
  actor: string,
  collaborationWorkspaceId: string,
  title: string
) {
  const response = await inject(server, actor, {
    method: "POST",
    url: "/api/conversations",
    payload: { title, collaborationWorkspaceId }
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ id: string }>().id;
}

async function createActiveRun(
  app: Awaited<ReturnType<typeof createWorkspaceApp>>,
  conversationId: string,
  ownerUserId: string
) {
  const message = await app.store.appendMessage({
    clientInstanceId,
    conversationId: asConversationId(conversationId),
    role: "user",
    text: "background work"
  });
  const run = await app.store.createAgentRun({
    id: createPlatformId<"AgentRunId">("run"),
    clientInstanceId,
    conversationId: asConversationId(conversationId),
    ownerUserId,
    inputMessageId: message.id,
    agentName: "test_agent",
    correlationId: createPlatformId("corr"),
    startedAt: new Date().toISOString()
  });
  return run.id;
}

async function createCompletedRun(
  app: Awaited<ReturnType<typeof createWorkspaceApp>>,
  conversationId: string,
  ownerUserId: string
) {
  const runId = await createActiveRun(app, conversationId, ownerUserId);
  const completedAt = new Date().toISOString();
  await app.store.appendRunObservation({
    clientInstanceId,
    runId,
    conversationId: asConversationId(conversationId),
    ownerUserId,
    event: { type: "run_completed", runId, sequence: 1, createdAt: completedAt }
  });
  await app.store.updateAgentRunStatus({
    clientInstanceId,
    runId,
    status: "completed",
    updatedAt: completedAt,
    completedAt,
    lastSequence: 1
  });
  return runId;
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
  return response.json<{ id: string }>();
}

function inject(
  server: TestServer,
  externalUserId: string,
  input: { method: "GET" | "POST" | "PATCH" | "DELETE"; url: string; payload?: string | object }
) {
  return server.inject({
    ...input,
    headers: { "x-dev-user-id": externalUserId }
  });
}
