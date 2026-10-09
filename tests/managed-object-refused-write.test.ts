import { describe, expect, it, vi } from "vitest";
import { asClientInstanceId, asUserId, type Logger } from "@vivd-catalyst/core";
import { RecordingByteStore, createTestManagedObjectAccess } from "./support/retention-harness";
import { createTestInstance } from "./support/test-instance";

describe("managed object access writing into a deleted conversation", () => {
  async function createFixture() {
    const clientInstanceId = asClientInstanceId(`refused_${globalThis.crypto.randomUUID()}`);
    const store = (await createTestInstance()).stores;
    const owner = await store.users.resolveUserIdentity({
      clientInstanceId,
      authSource: "test",
      externalUserId: "author",
      displayLabel: "Author",
      roles: ["user"],
      permissionRefs: [],
      permissions: []
    });
    const workspace = await store.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: asUserId(owner.id)
    });
    const conversation = await store.conversations.createConversation({
      visibility: "workspace",
      clientInstanceId,
      collaborationWorkspaceId: workspace.id,
      createdByUserId: owner.id,
      createdByExternalUserId: owner.externalUserId,
      title: "Deleted under a run",
      retainedUntil: "2999-01-01T00:00:00.000Z"
    });
    const byteStore = new RecordingByteStore();
    const loggedErrors = vi.fn<Logger["error"]>();
    const logger: Logger = {
      debug() {},
      info() {},
      warn() {},
      error: loggedErrors,
      child: () => logger
    };
    const managedObjects = createTestManagedObjectAccess({
      clientInstanceId,
      files: store.files,
      byteStore,
      logger
    });
    await store.conversations.deleteConversation({
      clientInstanceId,
      conversationId: conversation.id,
      deletedAt: new Date().toISOString()
    });
    const createArtifact = () =>
      managedObjects.createArtifact({
        conversationId: conversation.id,
        kind: "test.output",
        filename: "late.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode("late")
      });
    return { conversation, byteStore, createArtifact, loggedErrors };
  }

  it("removes the bytes it stored when the artifact record is refused", async () => {
    const fixture = await createFixture();

    await expect(fixture.createArtifact()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Conversation is not available"
    });

    expect(fixture.byteStore.deletedKeys).toHaveLength(1);
    expect(fixture.byteStore.deletedKeys[0]).toContain(fixture.conversation.id);
    expect(fixture.byteStore.keys()).toEqual([]);
  });

  it("logs the object key when that removal fails, and still reports the refusal", async () => {
    const fixture = await createFixture();
    fixture.byteStore.failDeletes = true;

    await expect(fixture.createArtifact()).rejects.toMatchObject({ code: "NOT_FOUND" });

    const [objectKey] = fixture.byteStore.keys();
    expect(objectKey).toContain(fixture.conversation.id);
    expect(fixture.loggedErrors).toHaveBeenCalledWith(
      expect.objectContaining({ objectKey }),
      "Could not remove an artifact object after its record was refused"
    );
  });
});
