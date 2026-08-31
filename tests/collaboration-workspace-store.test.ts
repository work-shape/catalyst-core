import { describe, expect, it } from "vitest";
import { asClientInstanceId } from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";

describe("InMemoryPlatformStore Collaboration Workspaces", () => {
  it("provisions exactly one private Personal Workspace and owner membership", async () => {
    const store = new InMemoryPlatformStore();
    const clientInstanceId = asClientInstanceId("workspace-unit-personal");
    const user = await store.createUser({ clientInstanceId, displayLabel: "Owner" });

    const first = await store.ensurePersonalWorkspace({ clientInstanceId, userId: user.id });
    const second = await store.ensurePersonalWorkspace({ clientInstanceId, userId: user.id });

    expect(second.id).toBe(first.id);
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
      store.getMembership({
        clientInstanceId,
        collaborationWorkspaceId: first.id,
        userId: user.id
      })
    ).resolves.toMatchObject({ role: "owner" });
  });

  it("protects Personal Workspace membership, name, visibility, and lifecycle", async () => {
    const store = new InMemoryPlatformStore();
    const clientInstanceId = asClientInstanceId("workspace-unit-invariants");
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
    await expect(
      store.updateWorkspace({
        clientInstanceId,
        collaborationWorkspaceId: personal.id,
        name: "Renamed"
      })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      store.updateWorkspace({
        clientInstanceId,
        collaborationWorkspaceId: personal.id,
        visibility: "discoverable"
      })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      store.deleteWorkspace({
        clientInstanceId,
        collaborationWorkspaceId: personal.id
      })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("updates Shared Workspace roles and keeps one pending access request per user", async () => {
    const store = new InMemoryPlatformStore();
    const clientInstanceId = asClientInstanceId("workspace-unit-shared");
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
    await expect(
      store.deleteAccessRequest({
        clientInstanceId,
        collaborationWorkspaceId: shared.id,
        userId: requester.id
      })
    ).resolves.toEqual(request);
  });
});
