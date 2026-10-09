import { createTestInstance } from "./support/test-instance";
import { describe, expect, it } from "vitest";
import { asClientInstanceId } from "@vivd-catalyst/core";

describe("TestMemoryStore Collaboration Workspaces", () => {
  it("provisions exactly one private Personal Workspace and owner membership", async () => {
    const store = createTestInstance().stores;
    const clientInstanceId = asClientInstanceId("workspace-unit-personal");
    const user = await store.users.createUser({ clientInstanceId, displayLabel: "Owner" });

    const first = await store.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: user.id
    });
    const second = await store.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: user.id
    });

    expect(second.id).toBe(first.id);
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
      store.workspaces.getMembership({
        clientInstanceId,
        collaborationWorkspaceId: first.id,
        userId: user.id
      })
    ).resolves.toMatchObject({ role: "owner" });
  });

  it("protects Personal Workspace membership, name, visibility, and lifecycle", async () => {
    const store = createTestInstance().stores;
    const clientInstanceId = asClientInstanceId("workspace-unit-invariants");
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
    await expect(
      store.workspaces.updateWorkspace({
        clientInstanceId,
        collaborationWorkspaceId: personal.id,
        name: "Renamed"
      })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      store.workspaces.updateWorkspace({
        clientInstanceId,
        collaborationWorkspaceId: personal.id,
        visibility: "discoverable"
      })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      store.workspaces.deleteWorkspace({
        clientInstanceId,
        collaborationWorkspaceId: personal.id
      })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("updates Shared Workspace roles and keeps one pending access request per user", async () => {
    const store = createTestInstance().stores;
    const clientInstanceId = asClientInstanceId("workspace-unit-shared");
    const owner = await store.users.createUser({ clientInstanceId, displayLabel: "Owner" });
    const member = await store.users.createUser({ clientInstanceId, displayLabel: "Member" });
    const requester = await store.users.createUser({ clientInstanceId, displayLabel: "Requester" });
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
    await expect(
      store.workspaces.deleteAccessRequest({
        clientInstanceId,
        collaborationWorkspaceId: shared.id,
        userId: requester.id
      })
    ).resolves.toEqual(request);
  });

  it("moves only from the expected workspace and finalizes cleaned shared workspaces", async () => {
    const store = createTestInstance().stores;
    const clientInstanceId = asClientInstanceId("workspace-unit-lifecycle");
    const owner = await store.users.createUser({ clientInstanceId, displayLabel: "Owner" });
    const requester = await store.users.createUser({ clientInstanceId, displayLabel: "Requester" });
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
    await store.workspaces.createAccessRequest({
      clientInstanceId,
      collaborationWorkspaceId: source.id,
      userId: requester.id
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
      store.workspaces.getWorkspace(clientInstanceId, destination.id)
    ).resolves.toBeUndefined();
  });

  it("scopes conversation listings by visibility and keeps Personal Workspaces open", async () => {
    const store = createTestInstance().stores;
    const clientInstanceId = asClientInstanceId("workspace-unit-visibility");
    const author = await store.users.createUser({ clientInstanceId, displayLabel: "Author" });
    const colleague = await store.users.createUser({ clientInstanceId, displayLabel: "Colleague" });
    const workspace = await store.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Shared",
      defaultConversationVisibility: "private",
      creatorUserId: author.id
    });
    expect(workspace.defaultConversationVisibility).toBe("private");
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
    for (const conversation of [open, authorsPrivate, colleaguesPrivate]) {
      await store.conversations.appendMessage({
        clientInstanceId,
        conversationId: conversation.id,
        role: "user",
        text: "First message"
      });
    }
    const list = async (
      scope: Parameters<typeof store.listConversationsForWorkspace>[0]["scope"]
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

    const unsent = await create("workspace", author.id);
    await expect(list({ kind: "viewer", userId: author.id })).resolves.not.toContain(unsent.id);
    await expect(list({ kind: "viewer", userId: colleague.id })).resolves.not.toContain(unsent.id);
    await expect(list({ kind: "lifecycle" })).resolves.toContain(unsent.id);

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
      store.conversations.getConversation(clientInstanceId, authorsPrivate.id)
    ).resolves.toMatchObject({ visibility: "private" });
  });
});
