import { type TestInstance as TestServer, createTestInstance } from "./support/test-instance";
import { required } from "./support/assertions";
import {
  testRequest,
  type TestRequest,
  type TestOperationName,
  type TestCallInput
} from "./support/operations";

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  asUserId,
  asClientInstanceId,
  asCollaborationWorkspaceId,
  asConversationId,
  createPlatformId
} from "@vivd-catalyst/core";
import { createTestConfig, seedConversationMessage } from "./support/fixtures";
import { createMultipartFilePayload } from "./support/chat-server-attachment-harness";

const clientInstanceId = asClientInstanceId("demo-local");

describe("Collaboration Workspace API", () => {
  it("pages candidates with identical labels and emails by their user ids", async () => {
    const app = await createWorkspaceApp();
    await currentUser(app, "owner");
    const workspaceId = await createSharedWorkspace(app, "owner", "Candidate paging");
    try {
      const candidates = [];
      for (let index = 0; index < 3; index++) {
        candidates.push(
          await app.stores.users.createUser({
            clientInstanceId,
            displayLabel: "Same Candidate",
            email: "same@example.test"
          })
        );
      }
      const ids: string[] = [];
      let cursor: string | undefined;
      for (let index = 0; index < 3; index++) {
        const response = await app.call(
          "workspaces.member_candidates.list",
          {
            params: { collaborationWorkspaceId: workspaceId },
            query: { q: "same", limit: 1, cursor }
          },
          "owner"
        );
        expect(response.statusCode).toBe(200);
        const page = response.json<{ items: { userId: string }[]; nextCursor?: string }>();
        expect(page.items).toHaveLength(1);
        ids.push(...page.items.map((item) => item.userId));
        cursor = page.nextCursor;
        if (index < 2) expect(cursor).toEqual(expect.any(String));
      }
      expect(cursor).toBeUndefined();
      expect(ids).toEqual(candidates.map((candidate) => candidate.id).sort());
    } finally {
      await app.close();
    }
  });

  it("searches add-member candidates for workspace owners and admins", async () => {
    const app = await createWorkspaceApp();
    await currentUser(app, "owner");
    const admin = await currentUser(app, "admin");
    await currentUser(app, "member");
    await currentUser(app, "outsider");
    const workspaceId = await createSharedWorkspace(app, "owner", "Candidate search");
    await addWorkspaceMember(app, "owner", workspaceId, "admin@example.test");
    await app.call(
      "workspaces.members.update_role",
      {
        params: { collaborationWorkspaceId: workspaceId, userId: admin.id },
        payload: { role: "admin" }
      },
      "owner"
    );
    await addWorkspaceMember(app, "owner", workspaceId, "member@example.test");

    await app.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Label Search Person",
      email: "label-result@example.test"
    });
    await app.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Email Result",
      email: "Mixed.Email@example.test"
    });
    const identityMatch = await app.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Identity Email Result"
    });
    await app.stores.users.upsertUserIdentity({
      clientInstanceId,
      userId: identityMatch.id,
      authSource: "oidc",
      externalUserId: "candidate-identity",
      email: "Verified.Alias@example.test",
      emailVerified: true
    });
    await app.call(
      "workspaces.access_requests.create",
      { params: { collaborationWorkspaceId: workspaceId } },
      "outsider"
    );

    const ownerLabelMatch = await app.call(
      "workspaces.member_candidates.list",
      { params: { collaborationWorkspaceId: workspaceId }, query: { q: "SEARCH PERSON" } },
      "owner"
    );
    expect(ownerLabelMatch.statusCode).toBe(200);
    expect(ownerLabelMatch.json().items).toEqual([
      {
        displayLabel: "Label Search Person",
        email: "label-result@example.test",
        userId: expect.any(String),
        hasPendingAccessRequest: false
      }
    ]);

    const adminEmailMatch = await app.call(
      "workspaces.member_candidates.list",
      { params: { collaborationWorkspaceId: workspaceId }, query: { q: "MIXED.EMAIL" } },
      "admin"
    );
    expect(adminEmailMatch.statusCode).toBe(200);
    expect(adminEmailMatch.json().items).toEqual([
      {
        displayLabel: "Email Result",
        email: "Mixed.Email@example.test",
        userId: expect.any(String),
        hasPendingAccessRequest: false
      }
    ]);

    const verifiedIdentityMatch = await app.call(
      "workspaces.member_candidates.list",
      { params: { collaborationWorkspaceId: workspaceId }, query: { q: "VERIFIED.ALIAS" } },
      "owner"
    );
    expect(verifiedIdentityMatch.json().items).toEqual([
      {
        displayLabel: "Identity Email Result",
        email: "Verified.Alias@example.test",
        userId: expect.any(String),
        hasPendingAccessRequest: false
      }
    ]);

    const pendingRequester = await app.call(
      "workspaces.member_candidates.list",
      { params: { collaborationWorkspaceId: workspaceId }, query: { q: "OUTSIDER@" } },
      "owner"
    );
    expect(pendingRequester.json().items).toEqual([
      {
        displayLabel: "outsider",
        email: "outsider@example.test",
        userId: expect.any(String),
        hasPendingAccessRequest: true
      }
    ]);

    expect(
      (
        await app.call(
          "workspaces.member_candidates.list",
          { params: { collaborationWorkspaceId: workspaceId }, query: { q: "MEMBER@EXAMPLE" } },
          "owner"
        )
      ).json().items
    ).toEqual([]);
    expect(
      (
        await app.call(
          "workspaces.member_candidates.list",
          { params: { collaborationWorkspaceId: workspaceId }, query: { q: " a " } },
          "owner"
        )
      ).json().items
    ).toEqual([]);
    expect(
      (
        await app.call(
          "workspaces.member_candidates.list",
          { params: { collaborationWorkspaceId: workspaceId }, query: { q: "search" } },
          "member"
        )
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.call(
          "workspaces.member_candidates.list",
          { params: { collaborationWorkspaceId: workspaceId }, query: { q: "search" } },
          "outsider"
        )
      ).statusCode
    ).toBe(404);

    for (let index = 0; index < 10; index += 1) {
      await app.stores.users.createUser({
        clientInstanceId,
        displayLabel: `Limit Candidate ${index.toString().padStart(2, "0")}`,
        email: `limit-${index}@example.test`
      });
    }
    const limited = await app.call(
      "workspaces.member_candidates.list",
      { params: { collaborationWorkspaceId: workspaceId }, query: { q: "limit candidate" } },
      "admin"
    );
    expect(limited.statusCode).toBe(200);
    expect(limited.json().items).toHaveLength(8);
    expect(limited.json()).not.toHaveProperty("nextCursor");
    expect(limited.json().items).toEqual(
      Array.from({ length: 8 }, (_, index) => ({
        displayLabel: `Limit Candidate ${index.toString().padStart(2, "0")}`,
        email: `limit-${index}@example.test`,
        userId: expect.any(String),
        hasPendingAccessRequest: false
      }))
    );

    const auditBefore = await app.stores.audit.listAuditEvents({ clientInstanceId });
    await app.call(
      "workspaces.member_candidates.list",
      { params: { collaborationWorkspaceId: workspaceId }, query: { q: "email" } },
      "owner"
    );
    const auditAfter = await app.stores.audit.listAuditEvents({ clientInstanceId });
    expect(auditAfter).toHaveLength(auditBefore.length);

    await app.close();
  });

  it("enforces roles, exact-email addition, access requests, and the last-owner invariant", async () => {
    const app = await createWorkspaceApp();
    const owner = await currentUser(app, "owner");
    const admin = await currentUser(app, "admin");
    const member = await currentUser(app, "member");
    const outsider = await currentUser(app, "outsider");
    const declined = await currentUser(app, "declined");
    const direct = await currentUser(app, "direct");

    const created = await app.call(
      "workspaces.create",
      {
        payload: {
          name: "  Product Lab  ",
          description: "Shared product work",
          emoji: "🧪",
          accentColor: "sapphire"
        }
      },
      "owner"
    );
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      kind: "shared",
      name: "Product Lab",
      role: "owner",
      visibility: "discoverable"
    });
    const collaborationWorkspaceId = created.json<{ id: string }>().id;

    const addedAdmin = await app.call(
      "workspaces.members.add",
      {
        params: { collaborationWorkspaceId: collaborationWorkspaceId },
        payload: { email: "ADMIN@EXAMPLE.TEST" }
      },
      "owner"
    );
    expect(addedAdmin.statusCode).toBe(200);
    expect(addedAdmin.json()).toMatchObject({ userId: admin.id, role: "member" });
    expect(
      (
        await app.call(
          "workspaces.members.update_role",
          {
            params: { collaborationWorkspaceId: collaborationWorkspaceId, userId: admin.id },
            payload: { role: "admin" }
          },
          "owner"
        )
      ).statusCode
    ).toBe(200);

    const addedMember = await app.call(
      "workspaces.members.add",
      {
        params: { collaborationWorkspaceId: collaborationWorkspaceId },
        payload: { email: "member@example.test" }
      },
      "admin"
    );
    expect(addedMember.statusCode).toBe(200);
    expect(addedMember.json()).toMatchObject({ userId: member.id, role: "member" });

    const memberRoleProbe = await app.call(
      "workspaces.members.update_role",
      {
        params: { collaborationWorkspaceId: collaborationWorkspaceId, userId: "missing-user" },
        payload: { role: "member" }
      },
      "member"
    );
    expect(memberRoleProbe.statusCode).toBe(403);
    const memberRemovalProbe = await app.call(
      "workspaces.members.remove",
      { params: { collaborationWorkspaceId: collaborationWorkspaceId, userId: "missing-user" } },
      "member"
    );
    expect(memberRemovalProbe.statusCode).toBe(403);

    const memberSettings = await app.call(
      "workspaces.update",
      { params: { collaborationWorkspaceId: collaborationWorkspaceId }, payload: { name: "Nope" } },
      "member"
    );
    expect(memberSettings.statusCode).toBe(403);
    const adminSettings = await app.call(
      "workspaces.update",
      {
        params: { collaborationWorkspaceId: collaborationWorkspaceId },
        payload: { visibility: "private", accentColor: "teal" }
      },
      "admin"
    );
    expect(adminSettings.statusCode).toBe(200);
    expect(adminSettings.json()).toMatchObject({ visibility: "private", accentColor: "teal" });

    const adminPromotion = await app.call(
      "workspaces.members.update_role",
      {
        params: { collaborationWorkspaceId: collaborationWorkspaceId, userId: member.id },
        payload: { role: "owner" }
      },
      "admin"
    );
    expect(adminPromotion.statusCode).toBe(403);

    const alreadyMember = await app.call(
      "workspaces.members.add",
      {
        params: { collaborationWorkspaceId: collaborationWorkspaceId },
        payload: { email: "member@example.test" }
      },
      "owner"
    );
    expect(alreadyMember.statusCode).toBe(409);

    const identityMatch = await app.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Identity match",
      email: "managed@example.test"
    });
    await app.stores.users.upsertUserIdentity({
      clientInstanceId,
      userId: identityMatch.id,
      authSource: "oidc",
      externalUserId: "identity-match",
      email: "verified-identity@example.test",
      emailVerified: true
    });
    const addedByIdentity = await app.call(
      "workspaces.members.add",
      {
        params: { collaborationWorkspaceId: collaborationWorkspaceId },
        payload: { email: "verified-identity@example.test" }
      },
      "owner"
    );
    expect(addedByIdentity.statusCode).toBe(200);
    expect(addedByIdentity.json()).toMatchObject({ userId: identityMatch.id });
    expect(
      (
        await app.call(
          "workspaces.members.remove",
          {
            params: { collaborationWorkspaceId: collaborationWorkspaceId, userId: identityMatch.id }
          },
          "admin"
        )
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.call(
          "workspaces.members.remove",
          { params: { collaborationWorkspaceId: collaborationWorkspaceId, userId: owner.id } },
          "admin"
        )
      ).statusCode
    ).toBe(403);

    for (const input of [
      { displayLabel: "Unknown", email: "unknown@example.test", status: "active" as const },
      { displayLabel: "Inactive", email: "inactive@example.test", status: "disabled" as const },
      { displayLabel: "Ambiguous one", email: "ambiguous@example.test", status: "active" as const },
      { displayLabel: "Ambiguous two", email: "ambiguous@example.test", status: "active" as const }
    ]) {
      if (input.displayLabel !== "Unknown") {
        await app.stores.users.createUser({ clientInstanceId, ...input });
      }
    }
    for (const email of [
      "unknown@example.test",
      "inactive@example.test",
      "ambiguous@example.test"
    ]) {
      const response = await app.call(
        "workspaces.members.add",
        { params: { collaborationWorkspaceId: collaborationWorkspaceId }, payload: { email } },
        "owner"
      );
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        error: { message: expect.stringContaining("Invitations") }
      });
    }

    const privateRequest = await app.call(
      "workspaces.access_requests.create",
      { params: { collaborationWorkspaceId: collaborationWorkspaceId } },
      "outsider"
    );
    expect(privateRequest.statusCode).toBe(404);
    await app.call(
      "workspaces.update",
      {
        params: { collaborationWorkspaceId: collaborationWorkspaceId },
        payload: { visibility: "discoverable" }
      },
      "admin"
    );
    const request = await app.call(
      "workspaces.access_requests.create",
      { params: { collaborationWorkspaceId: collaborationWorkspaceId } },
      "outsider"
    );
    expect(request.statusCode).toBe(200);
    expect(
      (
        await app.call(
          "workspaces.access_requests.create",
          { params: { collaborationWorkspaceId: collaborationWorkspaceId } },
          "outsider"
        )
      ).statusCode
    ).toBe(409);

    expect(
      (
        await app.call(
          "workspaces.access_requests.create",
          { params: { collaborationWorkspaceId: collaborationWorkspaceId } },
          "direct"
        )
      ).statusCode
    ).toBe(200);
    const directlyAdded = await app.call(
      "workspaces.members.add",
      {
        params: { collaborationWorkspaceId: collaborationWorkspaceId },
        payload: { email: "direct@example.test" }
      },
      "owner"
    );
    expect(directlyAdded.statusCode).toBe(200);
    expect(directlyAdded.json()).toMatchObject({ userId: direct.id, role: "member" });
    const clearedRequestApproval = await app.call(
      "workspaces.access_requests.approve",
      { params: { collaborationWorkspaceId: collaborationWorkspaceId, userId: direct.id } },
      "admin"
    );
    expect(clearedRequestApproval.statusCode).toBe(404);
    const pendingDirectory = await app.call("workspaces.directory.list", {}, "outsider");
    expect(pendingDirectory.json().items).toContainEqual(
      expect.objectContaining({ id: collaborationWorkspaceId, accessState: "request_pending" })
    );
    const requests = await app.call(
      "workspaces.access_requests.list",
      { params: { collaborationWorkspaceId: collaborationWorkspaceId } },
      "admin"
    );
    expect(requests.statusCode).toBe(200);
    expect(requests.json().items).toContainEqual(expect.objectContaining({ userId: outsider.id }));

    const ownerRows = await app.call("workspaces.list", {}, "owner");
    expect(ownerRows.json().items).toContainEqual(
      expect.objectContaining({ id: collaborationWorkspaceId, pendingAccessRequestCount: 1 })
    );
    expect(
      (
        await app.call(
          "workspaces.access_requests.approve",
          { params: { collaborationWorkspaceId: collaborationWorkspaceId, userId: outsider.id } },
          "admin"
        )
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.call(
          "workspaces.access_requests.create",
          { params: { collaborationWorkspaceId: collaborationWorkspaceId } },
          "declined"
        )
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.call(
          "workspaces.access_requests.decline",
          { params: { collaborationWorkspaceId: collaborationWorkspaceId, userId: declined.id } },
          "admin"
        )
      ).statusCode
    ).toBe(200);
    const declinedDirectory = await app.call("workspaces.directory.list", {}, "declined");
    expect(declinedDirectory.json().items).toContainEqual(
      expect.objectContaining({ id: collaborationWorkspaceId, accessState: "can_request" })
    );
    expect(
      (
        await app.call(
          "workspaces.get",
          { params: { collaborationWorkspaceId: collaborationWorkspaceId } },
          "outsider"
        )
      ).statusCode
    ).toBe(200);

    const soleOwnerLeave = await app.call(
      "workspaces.members.remove",
      { params: { collaborationWorkspaceId: collaborationWorkspaceId, userId: "me" } },
      "owner"
    );
    expect(soleOwnerLeave.statusCode).toBe(409);
    expect(
      (
        await app.call(
          "workspaces.members.update_role",
          {
            params: { collaborationWorkspaceId: collaborationWorkspaceId, userId: owner.id },
            payload: { role: "member" }
          },
          "owner"
        )
      ).statusCode
    ).toBe(409);
    expect(
      (
        await app.call(
          "workspaces.members.remove",
          { params: { collaborationWorkspaceId: collaborationWorkspaceId, userId: owner.id } },
          "owner"
        )
      ).statusCode
    ).toBe(409);
    const deleteOwner = await app.call("me.delete", {}, "owner");
    expect(deleteOwner.statusCode).toBe(409);
    expect(deleteOwner.json()).toMatchObject({
      error: { message: expect.stringContaining("1 Shared Workspace") }
    });

    expect(
      (
        await app.call(
          "workspaces.members.update_role",
          {
            params: { collaborationWorkspaceId: collaborationWorkspaceId, userId: member.id },
            payload: { role: "owner" }
          },
          "owner"
        )
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.call(
          "workspaces.members.remove",
          { params: { collaborationWorkspaceId: collaborationWorkspaceId, userId: "me" } },
          "owner"
        )
      ).statusCode
    ).toBe(200);

    const deletionBlockWorkspace = await app.call(
      "workspaces.create",
      { payload: { name: "Deletion block" } },
      "declined"
    );
    expect(deletionBlockWorkspace.statusCode).toBe(200);
    const superadminDelete = await app.call(
      "users.delete",
      { params: { userId: declined.id } },
      "owner"
    );
    expect(superadminDelete.statusCode).toBe(409);
    expect(superadminDelete.json()).toMatchObject({
      error: { message: expect.stringContaining("1 Shared Workspace") }
    });

    const audit = await app.call("audit_events.list", {}, "owner");
    expect(audit.statusCode).toBe(200);
    const auditEvents = audit.json<{
      items: Array<{
        type: string;
        metadata?: Record<string, unknown>;
      }>;
    }>().items;
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
    const owner = await currentUser(app, "owner");
    const member = await currentUser(app, "member");
    await currentUser(app, "outsider");
    const created = await app.call(
      "workspaces.create",
      { payload: { name: "Discoverable", description: "Limited metadata", accentColor: "ruby" } },
      "owner"
    );
    const collaborationWorkspaceId = created.json<{ id: string }>().id;

    const directory = await app.call("workspaces.directory.list", {}, "outsider");
    expect(directory.statusCode).toBe(200);
    const directoryRow = directory
      .json<{ items: Array<Record<string, unknown>> }>()
      .items.find((row) => row.id === collaborationWorkspaceId);
    expect(directoryRow).toEqual({
      id: collaborationWorkspaceId,
      name: "Discoverable",
      description: "Limited metadata",
      emoji: null,
      accentColor: "ruby",
      accessState: "can_request",
      // The key the directory is paged by.
      createdAt: expect.any(String)
    });
    for (const absent of ["members", "memberCount", "email", "activity", "role"]) {
      expect(directoryRow).not.toHaveProperty(absent);
    }

    const explicit = await app.call(
      "conversations.create",
      { payload: { title: "Shared thread", collaborationWorkspaceId } },
      "owner"
    );
    expect(explicit.statusCode).toBe(200);
    expect(explicit.json()).toMatchObject({ collaborationWorkspaceId, createdByUserId: owner.id });
    const conversationId = explicit.json<{ id: string }>().id;
    await seedConversationMessage(app.stores.conversations, conversationId);

    const defaulted = await app.call(
      "conversations.create",
      { payload: { title: "Private thread" } },
      "owner"
    );
    expect(defaulted.statusCode).toBe(200);
    expect(
      defaulted.json<{ collaborationWorkspaceId: string }>().collaborationWorkspaceId
    ).not.toBe(collaborationWorkspaceId);

    const unauthorized = await app.call(
      "conversations.thread.get",
      { params: { conversationId: conversationId } },
      "member"
    );
    expect(unauthorized.statusCode).toBe(404);
    const missing = await app.call(
      "conversations.thread.get",
      { params: { conversationId: "missing-conversation" } },
      "member"
    );
    expect(missing.statusCode).toBe(404);
    expect(unauthorized.json()).toMatchObject({
      error: { message: "Conversation is not available" }
    });
    expect(missing.json()).toMatchObject({
      error: { message: "Conversation is not available" }
    });

    const sharedCreateAndRun = await app.call(
      "conversations.runs.create",
      {
        payload: {
          idempotencyKey: "shared-create-and-run",
          conversation: { title: "Shared run", collaborationWorkspaceId },
          message: { text: "Run in the shared workspace" }
        }
      },
      "owner"
    );
    expect(sharedCreateAndRun.statusCode).toBe(200);
    expect(sharedCreateAndRun.json()).toMatchObject({
      conversation: { collaborationWorkspaceId }
    });

    const unauthorizedCreateAndRun = await app.call(
      "conversations.runs.create",
      {
        payload: {
          idempotencyKey: "unauthorized-create-and-run",
          conversation: { title: "Unauthorized run", collaborationWorkspaceId },
          message: { text: "Do not create this" }
        }
      },
      "member"
    );
    expect(unauthorizedCreateAndRun.statusCode).toBe(404);

    const personalCreateAndRun = await app.call(
      "conversations.runs.create",
      {
        payload: {
          idempotencyKey: "personal-create-and-run",
          conversation: { title: "Personal run" },
          message: { text: "Run in the personal workspace" }
        }
      },
      "owner"
    );
    expect(personalCreateAndRun.statusCode).toBe(200);
    expect(
      personalCreateAndRun.json<{ conversation: { collaborationWorkspaceId: string } }>()
        .conversation.collaborationWorkspaceId
    ).not.toBe(collaborationWorkspaceId);

    await app.call(
      "workspaces.members.add",
      {
        params: { collaborationWorkspaceId: collaborationWorkspaceId },
        payload: { email: "member@example.test" }
      },
      "owner"
    );
    const listed = await app.call(
      "conversations.list",
      { query: { collaborationWorkspaceId: collaborationWorkspaceId } },
      "member"
    );
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toContainEqual(expect.objectContaining({ id: conversationId }));
    expect(
      (
        await app.call(
          "conversations.rename",
          {
            params: { conversationId: conversationId },
            payload: { title: "Renamed by collaborator" }
          },
          "member"
        )
      ).statusCode
    ).toBe(200);

    const sent = await app.call(
      "conversations.runs.start",
      {
        params: { conversationId: conversationId },
        payload: { idempotencyKey: "collaborator-run", message: { text: "Hello" } }
      },
      "member"
    );
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({
      run: { ownerUserId: member.id },
      conversation: { createdByUserId: owner.id }
    });
    const runId = sent.json<{ run: { id: string } }>().run.id;
    const observedByOwner = await app.call(
      "conversations.runs.observe",
      { params: { conversationId: conversationId, runId: runId } },
      "owner"
    );
    expect(observedByOwner.statusCode).toBe(200);
    expect(
      (
        await app.call(
          "conversations.runs.observe",
          { params: { conversationId: conversationId, runId: runId } },
          "outsider"
        )
      ).statusCode
    ).toBe(404);

    const privateWorkspaceId = defaulted.json<{ collaborationWorkspaceId: string }>()
      .collaborationWorkspaceId;
    const privateConversationId = defaulted.json<{ id: string }>().id;
    expect(
      (
        await app.call(
          "workspaces.update",
          {
            params: { collaborationWorkspaceId: privateWorkspaceId },
            payload: { name: "Cannot rename personal" }
          },
          "owner"
        )
      ).statusCode
    ).toBe(422);

    const privateRun = await app.call(
      "conversations.runs.start",
      {
        params: { conversationId: privateConversationId },
        payload: { idempotencyKey: "private-run", message: { text: "Private" } }
      },
      "owner"
    );
    expect(privateRun.statusCode).toBe(200);
    const privateRunId = privateRun.json<{ run: { id: string } }>().run.id;
    expect(
      (
        await app.call(
          "conversations.runs.observe",
          { params: { conversationId: conversationId, runId: privateRunId } },
          "member"
        )
      ).statusCode
    ).toBe(404);

    const privateFile = await app.stores.files.createManagedFile({
      clientInstanceId,
      ownerUserId: owner.id,
      filename: "private.txt",
      mimeType: "text/plain",
      byteSize: 7,
      checksum: "private-file",
      objectKey: "private-file"
    });
    await app.stores.files.createConversationAttachment({
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
    const crossWorkspaceFile = await app.call(
      "conversations.files.get_content",
      {
        params: { conversationId: conversationId, fileId: privateFile.id },
        query: { download: "true" }
      },
      "member"
    );
    expect(crossWorkspaceFile.statusCode).toBe(404);

    const privateArtifact = await app.stores.files.createManagedArtifact({
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
        await app.call(
          "conversations.artifacts.get_preview",
          { params: { conversationId: conversationId, artifactId: privateArtifact.id } },
          "member"
        )
      ).statusCode
    ).toBe(404);
    const crossWorkspaceList = await app.call(
      "conversations.list",
      { query: { collaborationWorkspaceId: privateWorkspaceId } },
      "member"
    );
    expect(crossWorkspaceList.statusCode).toBe(404);

    await app.close();
  });

  it("makes a superadmin Owner of every shared workspace without a membership", async () => {
    const app = await createWorkspaceApp();
    const superadmin = await currentUser(app, "superadmin");
    await currentUser(app, "instance-admin");
    const member = await currentUser(app, "member");
    const outsider = await currentUser(app, "outsider");
    const workspaceId = await createSharedWorkspace(app, "member", "Team space");
    await app.call(
      "workspaces.access_requests.create",
      { params: { collaborationWorkspaceId: workspaceId } },
      "outsider"
    );
    // Not discoverable from here on: the superadmin's access does not depend on visibility.
    await app.call(
      "workspaces.update",
      { params: { collaborationWorkspaceId: workspaceId }, payload: { visibility: "private" } },
      "member"
    );
    const conversationId = await createConversation(app, "member", workspaceId, "Team");
    await seedConversationMessage(app.stores.conversations, conversationId);

    const workspaceUrl = testRequest("workspaces.get", {
      params: { collaborationWorkspaceId: workspaceId }
    });
    const workspaceRows = z.array(z.looseObject({ id: z.string(), kind: z.string() }));
    const listWorkspaces = async (actor: string) =>
      workspaceRows.parse((await app.call("workspaces.list", {}, actor)).json().items);
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
        testRequest("workspaces.members.list", {
          params: { collaborationWorkspaceId: workspaceId }
        }),
        testRequest("workspaces.agents.list", {
          params: { collaborationWorkspaceId: workspaceId }
        }),
        testRequest("conversations.list", { query: { collaborationWorkspaceId: workspaceId } }),
        testRequest("conversations.thread.get", { params: { conversationId: conversationId } })
      ]) {
        expect(
          (await callAs(app, actor, { ...url, input: { ...url.input, method: "GET" } })).statusCode,
          url.operation
        ).toBe(404);
      }
    }

    for (const url of [
      workspaceUrl,
      testRequest("workspaces.members.list", {
        params: { collaborationWorkspaceId: workspaceId }
      }),
      testRequest("workspaces.agents.list", {
        params: { collaborationWorkspaceId: workspaceId }
      }),
      testRequest("workspaces.access_requests.list", {
        params: { collaborationWorkspaceId: workspaceId }
      }),
      testRequest("workspaces.deletion_impact.get", {
        params: { collaborationWorkspaceId: workspaceId }
      }),
      testRequest("conversations.thread.get", { params: { conversationId: conversationId } })
    ]) {
      expect(
        (await callAs(app, "superadmin", { ...url, input: { ...url.input, method: "GET" } }))
          .statusCode,
        url.operation
      ).toBe(200);
    }
    const conversations = await app.call(
      "conversations.list",
      { query: { collaborationWorkspaceId: workspaceId } },
      "superadmin"
    );
    expect(
      z
        .array(z.object({ id: z.string() }))
        .parse(conversations.json().items)
        .map((row) => row.id)
    ).toEqual([conversationId]);

    const renamed = await callAs(app, "superadmin", {
      ...workspaceUrl,
      input: {
        ...workspaceUrl.input,
        method: "PATCH",
        payload: { name: "Renamed by the superadmin" }
      }
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({
      name: "Renamed by the superadmin",
      role: "owner",
      membershipRole: null,
      pendingAccessRequestCount: 0
    });
    const approved = await callAs(
      app,
      "superadmin",
      testRequest("workspaces.access_requests.approve", {
        params: { collaborationWorkspaceId: workspaceId, userId: outsider.id }
      })
    );
    expect(approved.statusCode).toBe(200);
    const promoted = await callAs(
      app,
      "superadmin",
      testRequest("workspaces.members.update_role", {
        params: { collaborationWorkspaceId: workspaceId, userId: outsider.id },
        payload: { role: "owner" }
      })
    );
    expect(promoted.statusCode).toBe(200);
    const audit = await app.call("audit_events.list", {}, "superadmin");
    expect(audit.json().items).toContainEqual(
      expect.objectContaining({
        type: "collaboration_workspace.updated",
        subject: workspaceId,
        actor: expect.objectContaining({ userId: superadmin.id })
      })
    );

    // Without a membership there is nothing to leave, and the access is not a member row.
    const leaveWithoutMembership = await callAs(
      app,
      "superadmin",
      testRequest("workspaces.members.leave", {
        params: { collaborationWorkspaceId: workspaceId }
      })
    );
    expect(leaveWithoutMembership.statusCode).toBe(409);
    expect(leaveWithoutMembership.json()).toMatchObject({
      error: { code: "CONFLICT", message: "User is not a workspace member" }
    });
    const members = await callAs(app, "superadmin", {
      ...testRequest("workspaces.members.list", {
        params: { collaborationWorkspaceId: workspaceId }
      }),
      input: {
        ...testRequest("workspaces.members.list", {
          params: { collaborationWorkspaceId: workspaceId }
        }).input,
        method: "GET"
      }
    });
    expect(
      z
        .array(z.object({ userId: z.string() }))
        .parse(members.json().items)
        .map((row) => row.userId)
        .sort()
    ).toEqual([member.id, outsider.id].sort());

    // A membership below Owner does not lower what the superadmin may do, and can be left again.
    await addWorkspaceMember(app, "superadmin", workspaceId, "superadmin@example.test");
    expect(
      (await listWorkspaces("superadmin")).find((row) => row.id === workspaceId)
    ).toMatchObject({ role: "owner", membershipRole: "member" });
    expect(
      (
        await callAs(app, "superadmin", {
          ...workspaceUrl,
          input: {
            ...workspaceUrl.input,
            method: "PATCH",
            payload: { description: "Still editable" }
          }
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await callAs(
          app,
          "superadmin",
          testRequest("workspaces.members.leave", {
            params: { collaborationWorkspaceId: workspaceId }
          })
        )
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
      app,
      "member",
      personalWorkspaceId,
      "Personal"
    );
    await seedConversationMessage(app.stores.conversations, personalConversationId);
    expect((await listWorkspaces("superadmin")).map((row) => row.id)).not.toContain(
      personalWorkspaceId
    );
    for (const url of [
      testRequest("workspaces.get", {
        params: { collaborationWorkspaceId: personalWorkspaceId }
      }),
      testRequest("workspaces.agents.list", {
        params: { collaborationWorkspaceId: personalWorkspaceId }
      }),
      testRequest("conversations.list", {
        query: { collaborationWorkspaceId: personalWorkspaceId }
      }),
      testRequest("conversations.thread.get", {
        params: { conversationId: personalConversationId }
      })
    ]) {
      expect(
        (await callAs(app, "superadmin", { ...url, input: { ...url.input, method: "GET" } }))
          .statusCode,
        url.operation
      ).toBe(404);
    }

    await app.close();
  });

  it("moves an idle conversation only for members of both workspaces and changes aggregate access", async () => {
    const app = await createWorkspaceApp();
    const owner = await currentUser(app, "owner");
    const member = await currentUser(app, "member");
    const sourceOnly = await currentUser(app, "declined");
    const destinationOnly = await currentUser(app, "direct");
    const sourceId = await createSharedWorkspace(app, "owner", "Move source");
    const destinationId = await createSharedWorkspace(app, "owner", "Move destination");
    await addWorkspaceMember(app, "owner", sourceId, "member@example.test");
    await addWorkspaceMember(app, "owner", destinationId, "member@example.test");
    await addWorkspaceMember(app, "owner", sourceId, "declined@example.test");
    await addWorkspaceMember(app, "owner", destinationId, "direct@example.test");

    const created = await app.call(
      "conversations.create",
      { payload: { title: "Movable", collaborationWorkspaceId: sourceId } },
      "owner"
    );
    const conversationId = created.json<{ id: string }>().id;
    const upload = createMultipartFilePayload({
      fieldName: "file",
      filename: "move.csv",
      contentType: "text/csv",
      content: "value\n42\n"
    });
    const uploaded = await app.call("conversations.draft_attachments.upload", {
      params: { conversationId: conversationId },
      headers: { ...upload.headers, "x-dev-user-id": "owner" },
      payload: upload.payload
    });
    expect(uploaded.statusCode).toBe(200);
    const fileId = uploaded.json<{ attachment: { fileId: string } }>().attachment.fileId;
    const runId = await createCompletedRun(app, conversationId, owner.id);

    const missingDestinationMembership = await app.call(
      "conversations.move",
      {
        params: { conversationId: conversationId },
        payload: { collaborationWorkspaceId: destinationId }
      },
      "declined"
    );
    expect(missingDestinationMembership.statusCode).toBe(404);
    expect(missingDestinationMembership.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    const missingSourceMembership = await app.call(
      "conversations.move",
      {
        params: { conversationId: conversationId },
        payload: { collaborationWorkspaceId: destinationId }
      },
      "direct"
    );
    expect(missingSourceMembership.statusCode).toBe(404);
    expect(missingSourceMembership.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    const sameWorkspace = await app.call(
      "conversations.move",
      {
        params: { conversationId: conversationId },
        payload: { collaborationWorkspaceId: sourceId }
      },
      "owner"
    );
    expect(sameWorkspace.statusCode).toBe(422);
    expect(sameWorkspace.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED" }
    });

    const busyConversation = await app.call(
      "conversations.create",
      { payload: { title: "Busy", collaborationWorkspaceId: sourceId } },
      "owner"
    );
    const busyConversationId = busyConversation.json<{ id: string }>().id;
    await createActiveRun(app, busyConversationId, owner.id);
    const busyMove = await app.call(
      "conversations.move",
      {
        params: { conversationId: busyConversationId },
        payload: { collaborationWorkspaceId: destinationId }
      },
      "owner"
    );
    expect(busyMove.statusCode).toBe(409);
    expect(busyMove.json()).toMatchObject({ error: { code: "CONFLICT" } });

    const moved = await app.call(
      "conversations.move",
      {
        params: { conversationId: conversationId },
        payload: { collaborationWorkspaceId: destinationId }
      },
      "member"
    );
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ collaborationWorkspaceId: destinationId });

    for (const url of [
      testRequest("conversations.thread.get", { params: { conversationId: conversationId } }),
      testRequest("conversations.draft_attachments.list", {
        params: { conversationId: conversationId }
      }),
      testRequest("conversations.runs.observe", {
        params: { conversationId: conversationId, runId: runId }
      })
    ]) {
      expect(
        (await callAs(app, "declined", { ...url, input: { ...url.input, method: "GET" } }))
          .statusCode
      ).toBe(404);
    }
    expect(
      (
        await app.call(
          "conversations.thread.get",
          { params: { conversationId: conversationId } },
          "direct"
        )
      ).statusCode
    ).toBe(200);
    const destinationFiles = await app.call(
      "conversations.draft_attachments.list",
      { params: { conversationId: conversationId } },
      "direct"
    );
    expect(destinationFiles.statusCode).toBe(200);
    expect(destinationFiles.json().items).toContainEqual(expect.objectContaining({ fileId }));
    expect(
      (
        await app.call(
          "conversations.runs.observe",
          { params: { conversationId: conversationId, runId: runId } },
          "direct"
        )
      ).statusCode
    ).toBe(200);

    const audit = await app.call("audit_events.list", {}, "owner");
    expect(audit.json().items).toContainEqual(
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
    const owner = await currentUser(app, "owner");
    const admin = await currentUser(app, "admin");
    const member = await currentUser(app, "member");
    const requester = await currentUser(app, "outsider");
    const workspaceId = await createSharedWorkspace(app, "owner", "Delete me exactly");
    await addWorkspaceMember(app, "owner", workspaceId, "admin@example.test");
    await app.call(
      "workspaces.members.update_role",
      {
        params: { collaborationWorkspaceId: workspaceId, userId: admin.id },
        payload: { role: "admin" }
      },
      "owner"
    );
    await addWorkspaceMember(app, "owner", workspaceId, "member@example.test");
    await app.call(
      "workspaces.access_requests.create",
      { params: { collaborationWorkspaceId: workspaceId } },
      "outsider"
    );
    const first = await createConversation(app, "owner", workspaceId, "First deletion");
    const second = await createConversation(app, "owner", workspaceId, "Second deletion");

    const impact = await app.call(
      "workspaces.deletion_impact.get",
      { params: { collaborationWorkspaceId: workspaceId } },
      "owner"
    );
    expect(impact.statusCode).toBe(200);
    expect(impact.json()).toEqual({
      conversationCount: 2,
      memberCount: 3,
      pendingAccessRequestCount: 1
    });
    const adminImpact = await app.call(
      "workspaces.deletion_impact.get",
      { params: { collaborationWorkspaceId: workspaceId } },
      "admin"
    );
    expect(adminImpact.statusCode).toBe(403);
    expect(adminImpact.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    const adminDelete = await app.call(
      "workspaces.delete",
      {
        params: { collaborationWorkspaceId: workspaceId },
        payload: { confirmName: "Delete me exactly" }
      },
      "admin"
    );
    expect(adminDelete.statusCode).toBe(403);
    const mismatch = await app.call(
      "workspaces.delete",
      {
        params: { collaborationWorkspaceId: workspaceId },
        payload: { confirmName: "delete me exactly" }
      },
      "owner"
    );
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });

    const ownerWorkspaces = (await app.call("workspaces.list", {}, "owner")).json<{
      items: Array<{ id: string; kind: string; name: string }>;
    }>().items;
    const personal = ownerWorkspaces.find((workspace) => workspace.kind === "personal")!;
    const personalDelete = await app.call(
      "workspaces.delete",
      {
        params: { collaborationWorkspaceId: personal.id },
        payload: { confirmName: personal.name }
      },
      "owner"
    );
    expect(personalDelete.statusCode).toBe(422);
    expect(personalDelete.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });

    const activeRunId = await createActiveRun(app, second, owner.id);
    const busyDelete = await app.call(
      "workspaces.delete",
      {
        params: { collaborationWorkspaceId: workspaceId },
        payload: { confirmName: "Delete me exactly" }
      },
      "owner"
    );
    expect(busyDelete.statusCode).toBe(409);
    expect(busyDelete.json()).toMatchObject({ error: { code: "CONFLICT" } });
    await app.stores.agentRuns.updateAgentRunStatus({
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
    const uploaded = await app.call("conversations.draft_attachments.upload", {
      params: { conversationId: first },
      headers: { ...upload.headers, "x-dev-user-id": "owner" },
      payload: upload.payload
    });
    const fileId = uploaded.json<{ attachment: { fileId: string } }>().attachment.fileId;
    const executionWorkspace = await app.stores.executionWorkspaces.ensureExecutionWorkspace({
      clientInstanceId,
      conversationId: asConversationId(first),
      ownerUserId: owner.id
    });
    const objectKey = `phase-d/${first}/workspace.txt`;
    const objectPath = join(WORKSPACE_OBJECT_ROOT, objectKey);
    await mkdir(dirname(objectPath), { recursive: true });
    await writeFile(objectPath, "workspace bytes");
    await app.stores.executionWorkspaces.upsertWorkspaceFile({
      clientInstanceId,
      workspaceId: executionWorkspace.id,
      path: "workspace.txt",
      objectKey,
      byteSize: 15,
      checksum: "phase-d-workspace",
      metadata: {}
    });

    const deleted = await app.call(
      "workspaces.delete",
      {
        params: { collaborationWorkspaceId: workspaceId },
        payload: { confirmName: "Delete me exactly" }
      },
      "owner"
    );
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({
      collaborationWorkspaceId: workspaceId,
      conversationCount: 2,
      fileCount: 2,
      memberCount: 3
    });
    await expect(access(objectPath)).rejects.toThrow();
    await expect(
      app.stores.workspaces.getWorkspace(clientInstanceId, asCollaborationWorkspaceId(workspaceId))
    ).resolves.toBeUndefined();
    await expect(
      app.stores.conversations.getConversation(clientInstanceId, asConversationId(first))
    ).resolves.toBeUndefined();
    await expect(
      app.stores.executionWorkspaces.getExecutionWorkspaceForConversation({
        clientInstanceId,
        conversationId: asConversationId(first)
      })
    ).resolves.toBeUndefined();
    await expect(
      app.stores.workspaces.getMembership({
        clientInstanceId,
        collaborationWorkspaceId: asCollaborationWorkspaceId(workspaceId),
        userId: member.id
      })
    ).resolves.toBeUndefined();
    await expect(
      app.stores.workspaces.getAccessRequest({
        clientInstanceId,
        collaborationWorkspaceId: asCollaborationWorkspaceId(workspaceId),
        userId: requester.id
      })
    ).resolves.toBeUndefined();
    for (const url of [
      testRequest("workspaces.get", {
        params: { collaborationWorkspaceId: workspaceId }
      }),
      testRequest("conversations.thread.get", { params: { conversationId: first } }),
      testRequest("conversations.files.get_content", {
        params: { conversationId: first, fileId: fileId }
      }),
      testRequest("conversations.runs.observe", {
        params: { conversationId: second, runId: activeRunId }
      })
    ]) {
      expect(
        (await callAs(app, "member", { ...url, input: { ...url.input, method: "GET" } })).statusCode
      ).toBe(404);
    }

    const audit = (await app.call("audit_events.list", {}, "owner")).json<{
      items: Array<{ type: string; subject: string; metadata?: Record<string, unknown> }>;
    }>().items;
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
    await currentUser(app, "owner");
    const workspaceId = await createSharedWorkspace(app, "owner", "Retry cleanup");
    const first = await createConversation(app, "owner", workspaceId, "Already deleted");
    const second = await createConversation(app, "owner", workspaceId, "Still present");
    expect(
      (await app.call("conversations.delete", { params: { conversationId: first } }, "owner"))
        .statusCode
    ).toBe(200);

    const deleted = await app.call(
      "workspaces.delete",
      {
        params: { collaborationWorkspaceId: workspaceId },
        payload: { confirmName: "Retry cleanup" }
      },
      "owner"
    );
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ conversationCount: 1 });
    await expect(
      app.stores.conversations.getConversation(clientInstanceId, asConversationId(first))
    ).resolves.toBeUndefined();
    await expect(
      app.stores.conversations.getConversation(clientInstanceId, asConversationId(second))
    ).resolves.toBeUndefined();
    await app.close();
  });

  it("preserves a conversation moved after workspace deletion enumerates it", async () => {
    const app = await createWorkspaceApp();
    await currentUser(app, "owner");
    const workspaceId = await createSharedWorkspace(app, "owner", "Delete source");
    const destinationId = await createSharedWorkspace(app, "owner", "Keep destination");
    const moved = await createConversation(app, "owner", workspaceId, "Move during delete");
    const deletedConversation = await createConversation(
      app,
      "owner",
      workspaceId,
      "Delete normally"
    );
    await app.stores.conversations.appendMessage({
      clientInstanceId,
      conversationId: asConversationId(moved),
      role: "user",
      text: "preserve this data"
    });

    const getConversation = app.stores.conversations.getConversation.bind(app.stores.conversations);
    let movedDuringDeletion = false;
    app.stores.conversations.getConversation = async (
      requestedClientInstanceId,
      conversationId
    ) => {
      if (!movedDuringDeletion && conversationId === moved) {
        movedDuringDeletion = true;
        await app.stores.conversations.moveConversation({
          clientInstanceId,
          conversationId: asConversationId(moved),
          fromCollaborationWorkspaceId: asCollaborationWorkspaceId(workspaceId),
          toCollaborationWorkspaceId: asCollaborationWorkspaceId(destinationId),
          visibility: "workspace"
        });
      }
      return getConversation(requestedClientInstanceId, conversationId);
    };

    const deleted = await app.call(
      "workspaces.delete",
      {
        params: { collaborationWorkspaceId: workspaceId },
        payload: { confirmName: "Delete source" }
      },
      "owner"
    );
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ conversationCount: 1 });
    await expect(
      app.stores.conversations.getConversation(clientInstanceId, asConversationId(moved))
    ).resolves.toMatchObject({ collaborationWorkspaceId: destinationId, status: "active" });
    await expect(
      app.stores.conversations.listMessages({
        clientInstanceId,
        conversationId: asConversationId(moved)
      })
    ).resolves.toEqual([expect.objectContaining({ text: "preserve this data" })]);
    await expect(
      app.stores.conversations.getConversation(
        clientInstanceId,
        asConversationId(deletedConversation)
      )
    ).resolves.toBeUndefined();
    await expect(
      app.stores.workspaces.getWorkspace(clientInstanceId, asCollaborationWorkspaceId(workspaceId))
    ).resolves.toBeUndefined();
    await app.close();
  });
});

/**
 * For the test that sends every conversation route as every role: some two hundred requests with
 * no wait among them, seconds alone and many times that beside other suites. The limit only ends
 * a run that hangs; nothing asserts a duration.
 */
const EVERY_ROUTE_FOR_EVERY_ROLE_TIMEOUT_MS = 180_000;

describe("Conversation visibility", () => {
  it("lists a conversation without messages only to its creator while it holds draft attachments", async () => {
    const app = await createWorkspaceApp();
    await currentUser(app, "owner");
    await currentUser(app, "member");
    const workspaceId = await createSharedWorkspace(app, "owner", "Unsent drafts");
    await addWorkspaceMember(app, "owner", workspaceId, "member@example.test");
    const listedIds = async (actor: string) => {
      const listed = await app.call(
        "conversations.list",
        { query: { collaborationWorkspaceId: workspaceId } },
        actor
      );
      expect(listed.statusCode).toBe(200);
      return listed.json<{ items: Array<{ id: string }> }>().items.map((row) => row.id);
    };

    // The composer creates the conversation before the first upload lands.
    const conversationId = await createConversation(app, "owner", workspaceId, "2 attached files");
    await expect(
      app.stores.conversations.getConversation(clientInstanceId, asConversationId(conversationId))
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
      const uploaded = await app.call("conversations.draft_attachments.upload", {
        params: { conversationId: conversationId },
        headers: { ...upload.headers, "x-dev-user-id": "owner" },
        payload: upload.payload
      });
      expect(uploaded.statusCode).toBe(200);
      attachmentIds.push(uploaded.json<{ attachment: { id: string } }>().attachment.id);
    }
    await expect(listedIds("owner")).resolves.toEqual([conversationId]);
    await expect(listedIds("member")).resolves.toEqual([]);
    // Listing is narrower than access: the workspace-visible conversation stays reachable.
    const memberThread = await app.call(
      "conversations.thread.get",
      { params: { conversationId: conversationId } },
      "member"
    );
    expect(memberThread.statusCode).toBe(200);

    const [firstAttachmentId, secondAttachmentId] = attachmentIds;
    const removeDraft = (attachmentId: string | undefined) =>
      app.call(
        "conversations.draft_attachments.delete",
        { params: { conversationId: conversationId, attachmentId: required(attachmentId) } },
        "owner"
      );
    expect((await removeDraft(firstAttachmentId)).statusCode).toBe(200);
    await expect(listedIds("owner")).resolves.toEqual([conversationId]);
    expect((await removeDraft(secondAttachmentId)).statusCode).toBe(200);
    await expect(listedIds("owner")).resolves.toEqual([]);
    await expect(listedIds("member")).resolves.toEqual([]);

    await seedConversationMessage(app.stores.conversations, conversationId);
    await expect(listedIds("owner")).resolves.toEqual([conversationId]);
    await expect(listedIds("member")).resolves.toEqual([conversationId]);
    await app.close();
  });

  it(
    "hides a private conversation from every non-author role on every conversation route",
    async () => {
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
            body: {
              error: {
                correlationId: expect.any(String),
                code: "NOT_FOUND",
                message: "Conversation is not available"
              }
            }
          });
          expect(denied.statusCode).toBe(missing.statusCode);
          expect(denied.json().error).toEqual({
            ...missing.json().error,
            correlationId: expect.any(String)
          });
        }
      }

      for (const actor of ["owner", "admin", "member", "superadmin"]) {
        const listed = await app.call(
          "conversations.list",
          { query: { collaborationWorkspaceId: workspaceId } },
          actor
        );
        expect(listed.statusCode).toBe(200);
        expect(listed.json<{ items: Array<{ id: string }> }>().items.map((row) => row.id)).toEqual([
          sharedConversationId
        ]);
      }
      const listedByAuthor = await app.call(
        "conversations.list",
        { query: { collaborationWorkspaceId: workspaceId } },
        "direct"
      );
      expect(
        listedByAuthor
          .json<{ items: Array<{ id: string }> }>()
          .items.map((row) => row.id)
          .sort()
      ).toEqual([conversationId, sharedConversationId].sort());

      // Nothing a non-author sent may have changed the conversation: still the two fixture
      // messages and the one draft attachment.
      await expect(
        app.stores.conversations.getConversation(clientInstanceId, asConversationId(conversationId))
      ).resolves.toMatchObject({
        status: "active",
        title: "Private thread",
        visibility: "private",
        collaborationWorkspaceId: workspaceId
      });
      await expect(
        app.stores.conversations.listMessages({
          clientInstanceId,
          conversationId: asConversationId(conversationId)
        })
      ).resolves.toHaveLength(2);
      await expect(
        app.stores.files.listDraftAttachments({
          clientInstanceId,
          conversationId: asConversationId(conversationId)
        })
      ).resolves.toHaveLength(1);

      // The deletion impact keeps counting every conversation, private ones included.
      const impact = await app.call(
        "workspaces.deletion_impact.get",
        { params: { collaborationWorkspaceId: workspaceId } },
        "owner"
      );
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
    },
    EVERY_ROUTE_FOR_EVERY_ROLE_TIMEOUT_MS
  );

  it("keeps a private conversation closed while its author is not a member", async () => {
    const { app, workspaceId, conversationId, author } = await createPrivateConversationFixture();
    const thread = testRequest("conversations.thread.get", {
      params: { conversationId: conversationId },
      method: "GET" as const
    });

    const removed = await app.call(
      "workspaces.members.remove",
      { params: { collaborationWorkspaceId: workspaceId, userId: author.id } },
      "owner"
    );
    expect(removed.statusCode).toBe(200);
    for (const actor of ["direct", "owner", "admin", "member"]) {
      expect((await callAs(app, actor, thread)).statusCode, actor).toBe(404);
    }
    await expect(
      app.stores.conversations.getConversation(clientInstanceId, asConversationId(conversationId))
    ).resolves.toMatchObject({ status: "active", visibility: "private" });

    await addWorkspaceMember(app, "owner", workspaceId, "direct@example.test");
    expect((await callAs(app, "direct", thread)).statusCode).toBe(200);
    for (const actor of ["owner", "admin", "member"]) {
      expect((await callAs(app, actor, thread)).statusCode, actor).toBe(404);
    }
    await app.close();
  });

  it("stamps the workspace default at creation and never rewrites existing conversations", async () => {
    const app = await createWorkspaceApp();
    for (const actor of ["owner", "admin", "member"]) await currentUser(app, actor);
    const admin = await currentUser(app, "admin");
    const created = await app.call(
      "workspaces.create",
      { payload: { name: "Private by default", defaultConversationVisibility: "private" } },
      "owner"
    );
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ defaultConversationVisibility: "private" });
    const workspaceId = created.json<{ id: string }>().id;
    await addWorkspaceMember(app, "owner", workspaceId, "admin@example.test");
    await addWorkspaceMember(app, "owner", workspaceId, "member@example.test");
    await app.call(
      "workspaces.members.update_role",
      {
        params: { collaborationWorkspaceId: workspaceId, userId: admin.id },
        payload: { role: "admin" }
      },
      "owner"
    );

    const defaultWorkspaceId = await createSharedWorkspace(app, "owner", "Open by default");
    const workspaces = await app.call("workspaces.list", {}, "owner");
    expect(workspaces.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: defaultWorkspaceId,
          defaultConversationVisibility: "workspace"
        }),
        expect.objectContaining({ kind: "personal", defaultConversationVisibility: "workspace" })
      ])
    );

    const privateConversation = await app.call(
      "conversations.create",
      { payload: { title: "Stamped private", collaborationWorkspaceId: workspaceId } },
      "member"
    );
    expect(privateConversation.json()).toMatchObject({ visibility: "private" });
    const privateConversationId = privateConversation.json<{ id: string }>().id;
    const createdWithRun = await app.call(
      "conversations.runs.create",
      {
        payload: {
          idempotencyKey: "stamped-create-and-run",
          message: { text: "Hello" },
          conversation: {
            title: "Stamped by create-and-run",
            collaborationWorkspaceId: workspaceId
          }
        }
      },
      "member"
    );
    expect(createdWithRun.statusCode).toBe(200);
    expect(createdWithRun.json()).toMatchObject({
      conversation: { visibility: "private" },
      thread: { conversation: { visibility: "private" } }
    });
    const personalConversation = await app.call(
      "conversations.create",
      { payload: { title: "Personal" } },
      "member"
    );
    expect(personalConversation.json()).toMatchObject({ visibility: "workspace" });

    const byMember = await app.call(
      "workspaces.update",
      {
        params: { collaborationWorkspaceId: workspaceId },
        payload: { defaultConversationVisibility: "workspace" }
      },
      "member"
    );
    expect(byMember.statusCode).toBe(403);
    const byAdmin = await app.call(
      "workspaces.update",
      {
        params: { collaborationWorkspaceId: workspaceId },
        payload: { defaultConversationVisibility: "workspace" }
      },
      "admin"
    );
    expect(byAdmin.statusCode).toBe(200);
    expect(byAdmin.json()).toMatchObject({ defaultConversationVisibility: "workspace" });

    const openConversation = await app.call(
      "conversations.create",
      { payload: { title: "Stamped open", collaborationWorkspaceId: workspaceId } },
      "member"
    );
    expect(openConversation.json()).toMatchObject({ visibility: "workspace" });
    const openConversationId = openConversation.json<{ id: string }>().id;
    await expect(
      app.stores.conversations.getConversation(
        clientInstanceId,
        asConversationId(privateConversationId)
      )
    ).resolves.toMatchObject({ visibility: "private" });
    expect(
      (
        await app.call(
          "conversations.thread.get",
          { params: { conversationId: privateConversationId } },
          "owner"
        )
      ).statusCode
    ).toBe(404);

    await app.call(
      "workspaces.update",
      {
        params: { collaborationWorkspaceId: workspaceId },
        payload: { defaultConversationVisibility: "private" }
      },
      "owner"
    );
    await expect(
      app.stores.conversations.getConversation(
        clientInstanceId,
        asConversationId(openConversationId)
      )
    ).resolves.toMatchObject({ visibility: "workspace" });
    expect(
      (
        await app.call(
          "conversations.thread.get",
          { params: { conversationId: openConversationId } },
          "owner"
        )
      ).statusCode
    ).toBe(200);

    const personalWorkspaceId = personalConversation.json<{ collaborationWorkspaceId: string }>()
      .collaborationWorkspaceId;
    await expect(
      app.stores.workspaces.updateWorkspace({
        clientInstanceId,
        collaborationWorkspaceId: asCollaborationWorkspaceId(personalWorkspaceId),
        defaultConversationVisibility: "private"
      })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await app.close();
  });

  it("applies the move visibility rule", async () => {
    const app = await createWorkspaceApp();
    for (const actor of ["owner", "member"]) await currentUser(app, actor);
    const openId = await createSharedWorkspace(app, "owner", "Open");
    const otherOpenId = await createSharedWorkspace(app, "owner", "Other open");
    const privateDefault = await app.call(
      "workspaces.create",
      { payload: { name: "Private default", defaultConversationVisibility: "private" } },
      "owner"
    );
    const privateDefaultId = privateDefault.json<{ id: string }>().id;
    for (const workspaceId of [openId, otherOpenId, privateDefaultId]) {
      await addWorkspaceMember(app, "owner", workspaceId, "member@example.test");
    }
    const personalWorkspaceId = (await app.call("workspaces.list", {}, "member"))
      .json<{ items: Array<{ id: string; kind: string }> }>()
      .items.find((workspace) => workspace.kind === "personal")!.id;
    const move = (
      actor: string,
      conversationId: string,
      collaborationWorkspaceId: string,
      visibility?: "workspace" | "private"
    ) =>
      app.call(
        "conversations.move",
        {
          params: { conversationId: conversationId },
          payload: { collaborationWorkspaceId, ...(visibility ? { visibility } : {}) }
        },
        actor
      );

    // A private conversation stays private unless the request says otherwise.
    const privateId = await createConversation(app, "member", privateDefaultId, "Private");
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
    const ownersId = await createConversation(app, "owner", openId, "Owner's");
    const nonCreatorIntoPrivateDefault = await move("member", ownersId, privateDefaultId);
    expect(nonCreatorIntoPrivateDefault.statusCode).toBe(422);
    expect(nonCreatorIntoPrivateDefault.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED" }
    });
    expect((await move("member", ownersId, otherOpenId, "private")).statusCode).toBe(422);
    await expect(
      app.stores.conversations.getConversation(clientInstanceId, asConversationId(ownersId))
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
  send(actor: string, conversationId: string): ReturnType<typeof callAs>;
};

async function createPrivateConversationFixture() {
  const app = await createWorkspaceApp();
  await currentUser(app, "owner");
  const admin = await currentUser(app, "admin");
  await currentUser(app, "member");
  await currentUser(app, "outsider");
  await currentUser(app, "superadmin");
  const author = await currentUser(app, "direct");
  const created = await app.call(
    "workspaces.create",
    { payload: { name: "Visibility matrix", defaultConversationVisibility: "private" } },
    "owner"
  );
  const workspaceId = created.json<{ id: string }>().id;
  for (const email of ["admin@example.test", "member@example.test", "direct@example.test"]) {
    await addWorkspaceMember(app, "owner", workspaceId, email);
  }
  const promoted = await app.call(
    "workspaces.members.update_role",
    {
      params: { collaborationWorkspaceId: workspaceId, userId: admin.id },
      payload: { role: "admin" }
    },
    "owner"
  );
  expect(promoted.statusCode).toBe(200);

  const conversationId = await createConversation(app, "direct", workspaceId, "Private thread");
  await app.stores.conversations.appendMessage({
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
  const uploaded = await app.call("conversations.draft_attachments.upload", {
    params: { conversationId: conversationId },
    headers: { ...upload.headers, "x-dev-user-id": "direct" },
    payload: upload.payload
  });
  expect(uploaded.statusCode).toBe(200);
  const attachment = uploaded.json<{ attachment: { id: string; fileId: string } }>().attachment;
  const artifact = await app.stores.files.createManagedArtifact({
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
  await app.call(
    "workspaces.update",
    {
      params: { collaborationWorkspaceId: workspaceId },
      payload: { defaultConversationVisibility: "workspace" }
    },
    "owner"
  );
  const sharedConversationId = await createConversation(
    app,
    "direct",
    workspaceId,
    "Shared thread"
  );
  await seedConversationMessage(app.stores.conversations, sharedConversationId);
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
    (operation: TestOperationName, input: TestCallInput = {}): ConversationRouteCase["send"] =>
    (actor, conversationId) =>
      app.call(operation, { ...input, params: { ...input.params, conversationId } }, actor);
  return [
    { name: "thread", send: json("conversations.thread.get") },
    { name: "messages", send: json("conversations.messages.list") },
    { name: "resources", send: json("conversations.resources.list") },
    {
      name: "structured data",
      send: json("conversations.structured_data.get", {
        params: { structuredDataResourceId: "sdr_missing" }
      })
    },
    {
      name: "rename",
      send: json("conversations.rename", { payload: { title: "Renamed by someone else" } })
    },
    {
      name: "start run",
      // The unknown model binding stops the author's positive control after the access check.
      send: json("conversations.runs.start", {
        payload: {
          idempotencyKey: "visibility-matrix",
          message: { text: "Hello" },
          modelBindingId: "not-selectable"
        }
      })
    },
    { name: "run events", send: json("conversations.runs.observe", { params: { runId } }) },
    {
      name: "cancel run",
      send: json("conversations.runs.cancel", { params: { runId }, payload: {} })
    },
    {
      name: "command run",
      send: json("conversations.runs.command", {
        params: { runId },
        payload: { command: { type: "continue" } }
      })
    },
    { name: "list draft attachments", send: json("conversations.draft_attachments.list") },
    {
      name: "upload draft attachment",
      send: (actor, conversationId) => {
        const upload = createMultipartFilePayload({
          fieldName: "file",
          filename: "intruder.csv",
          contentType: "text/csv",
          content: "value\n1\n"
        });
        return app.call("conversations.draft_attachments.upload", {
          params: { conversationId: conversationId },
          headers: { ...upload.headers, "x-dev-user-id": actor },
          payload: upload.payload
        });
      }
    },
    {
      name: "retry draft attachment",
      send: json("conversations.draft_attachments.retry", { params: { attachmentId } })
    },
    { name: "file content", send: json("conversations.files.get_content", { params: { fileId } }) },
    {
      name: "file download",
      send: json("conversations.files.get_content", {
        params: { fileId },
        query: { download: true }
      })
    },
    {
      name: "artifact content",
      send: json("conversations.artifacts.get_content", { params: { artifactId } })
    },
    {
      name: "artifact preview",
      send: json("conversations.artifacts.get_preview", { params: { artifactId } })
    },
    {
      name: "attachment preview",
      send: json("conversations.attachments.get_preview", { params: { attachmentId } })
    },
    {
      name: "retry artifact preview",
      send: json("conversations.artifacts.retry_preview", { params: { artifactId } })
    },
    {
      name: "delete draft attachment",
      send: json("conversations.draft_attachments.delete", { params: { attachmentId } })
    },
    // Same-workspace move: denied for non-authors, a validation error for the author.
    {
      name: "move",
      send: json("conversations.move", { payload: { collaborationWorkspaceId: workspaceId } })
    },
    { name: "delete", send: json("conversations.delete") }
  ];
}

const WORKSPACE_OBJECT_ROOT = "/tmp/vivd-catalyst-phase-d-workspace-objects";

async function createWorkspaceApp() {
  return createTestInstance({
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
          testIdentity("direct", "direct@example.test"),
          testIdentity("superadmin", "superadmin@example.test", ["user", "admin", "superadmin"]),
          testIdentity("instance-admin", "instance-admin@example.test", ["user", "admin"])
        ]
      },
      executionWorkspaces: { enabled: true },
      workspaceObjectRoot: WORKSPACE_OBJECT_ROOT
    }),
    tools: []
  });
}

async function createSharedWorkspace(server: TestServer, actor: string, name: string) {
  const response = await server.call("workspaces.create", { payload: { name } }, actor);
  expect(response.statusCode).toBe(200);
  return response.json<{ id: string }>().id;
}

async function addWorkspaceMember(
  server: TestServer,
  actor: string,
  collaborationWorkspaceId: string,
  email: string
) {
  const response = await server.call(
    "workspaces.members.add",
    { params: { collaborationWorkspaceId: collaborationWorkspaceId }, payload: { email } },
    actor
  );
  expect(response.statusCode).toBe(200);
}

async function createConversation(
  server: TestServer,
  actor: string,
  collaborationWorkspaceId: string,
  title: string
) {
  const response = await server.call(
    "conversations.create",
    { payload: { title, collaborationWorkspaceId } },
    actor
  );
  expect(response.statusCode).toBe(200);
  return response.json<{ id: string }>().id;
}

async function createActiveRun(
  app: Awaited<ReturnType<typeof createWorkspaceApp>>,
  conversationId: string,
  ownerUserId: string
) {
  const message = await app.stores.conversations.appendMessage({
    clientInstanceId,
    conversationId: asConversationId(conversationId),
    role: "user",
    text: "background work"
  });
  const run = await app.stores.agentRuns.createAgentRun({
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
  await app.stores.agentRuns.appendRunObservation({
    clientInstanceId,
    runId,
    conversationId: asConversationId(conversationId),
    ownerUserId,
    event: { type: "run_completed", runId, sequence: 1, createdAt: completedAt }
  });
  await app.stores.agentRuns.updateAgentRunStatus({
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

async function currentUser(
  server: TestServer,
  externalUserId: string
): Promise<{ id: ReturnType<typeof asUserId> }> {
  const response = await server.call("me.get", {}, externalUserId);
  expect(response.statusCode).toBe(200);
  expect((await server.call("workspaces.ensure_personal", {}, externalUserId)).statusCode).toBe(
    200
  );
  return { id: asUserId(response.json<{ id: string }>().id) };
}

function callAs(server: TestServer, externalUserId: string, request: TestRequest) {
  return server.call(request.operation, request.input, externalUserId);
}
