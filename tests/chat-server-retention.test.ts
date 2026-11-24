import { orderedStoreCalls } from "./support/postgres-concurrency-harness";
import { fileTestDatabaseUrl } from "./support/test-database";
import postgres from "postgres";
import {
  type TestInstance,
  type TestStore,
  createTestInstance,
  createTestInstanceWith,
  getTestJobs
} from "./support/test-instance";
import { createFailingTestLogger, createTestConfig } from "./support/fixtures";

import { describe, expect, it, vi } from "vitest";
import { createApiClient, type SafeConfig } from "@work-shape/catalyst-api-client";
import {
  ConversationRetentionWorkflow,
  ExecutionWorkspaceCleanupWorkflow,
  expireConversationsJob
} from "@work-shape/catalyst-server";
import { createManagedObjectAccess } from "@work-shape/catalyst-capability-sdk";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asExecutionWorkspaceId,
  createPlatformId,
  asMessageId,
  asUserId,
  isJsonObject,
  scheduleDedupeKey,
  unknownToJsonValue,
  type ClientInstanceId,
  type Conversation,
  type ConversationAttachment,
  type ConversationId,
  type ManagedArtifactRecord,
  type ManagedFileRecord,
  type PlatformFileStore,
  type PlatformStores,
  type PrepareConversationRunStartInput
} from "@work-shape/catalyst-core";
import {
  RecordingByteStore,
  createAttachedObjects,
  createManagedObjectAttachmentService,
  createRetentionOptions,
  createTestManagedObjectAccess
} from "./support/retention-harness";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";

describe("conversation retention expiration", () => {
  it("expires due conversations on each run with object cleanup and audit", async () => {
    const clientInstanceId = asClientInstanceId("retention-test");
    const store = (await createTestInstance()).stores;
    const byteStore = new RecordingByteStore();
    const managedObjects = createManagedObjectAccess({
      clientInstanceId,
      files: store.files,
      byteStore,
      keyFactory: {
        createFileObjectKey(input) {
          return `files/${input.conversationId ?? "unscoped"}/${input.checksum}`;
        },
        createArtifactObjectKey(input) {
          return `artifacts/${input.conversationId}/${input.kind}/${input.checksum}`;
        }
      }
    });
    const attachments = createManagedObjectAttachmentService({ managedObjects });
    const options = createRetentionOptions({
      clientInstanceId,
      store,
      attachments,
      workspaceObjects: byteStore
    });
    const workflow = new ConversationRetentionWorkflow(options);
    const logger = createFailingTestLogger("Retention job failed");

    const startupConversation = await createExpiredConversation(store, clientInstanceId, "startup");
    const startupObjects = await createAttachedObjects({
      store: store.files,
      managedObjects,
      clientInstanceId,
      conversation: startupConversation
    });
    const startupWorkspaceObjects = await createWorkspaceObjects({
      store,
      byteStore,
      clientInstanceId,
      conversation: startupConversation
    });

    await workflow.run(logger);
    await waitFor(async () => {
      await expectConversationStatus(
        store,
        clientInstanceId,
        startupConversation.id,
        "retention_expired"
      );
    });

    await expect(
      store.conversations.listMessages({
        clientInstanceId,
        conversationId: startupConversation.id
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
    await waitForRetentionAudit(store, clientInstanceId, startupConversation.id);
    await expectDeletedManagedObjects(store.files, byteStore, clientInstanceId, startupObjects);
    await expectDeletedWorkspaceObjects(
      store,
      byteStore,
      clientInstanceId,
      startupWorkspaceObjects
    );

    const periodicConversation = await createExpiredConversation(
      store,
      clientInstanceId,
      "periodic"
    );
    await workflow.run(logger);
    await waitFor(async () => {
      await expectConversationStatus(
        store,
        clientInstanceId,
        periodicConversation.id,
        "retention_expired"
      );
    });
    await waitForRetentionAudit(store, clientInstanceId, periodicConversation.id);

    const events = await store.audit.listAuditEvents({ clientInstanceId, limit: 10 });
    const startupAudit = events.find(
      (event) =>
        event.subject === startupConversation.id && event.type === "conversation.retention_expired"
    );
    expect(startupAudit).toMatchObject({
      type: "conversation.retention_expired",
      status: "success",
      metadata: expect.objectContaining({
        retainedUntil: startupConversation.retainedUntil,
        attachmentCount: 1,
        fileCount: 1,
        artifactCount: 1,
        workspaceCount: 1,
        workspaceFileCount: 6,
        workspaceCommandCount: 1,
        workspaceObjectCount: 6
      })
    });
    expect(startupAudit).not.toHaveProperty("actor");
    expect(
      events.find(
        (event) =>
          event.subject === periodicConversation.id &&
          event.type === "conversation.retention_expired"
      )
    ).toMatchObject({
      type: "conversation.retention_expired",
      status: "success",
      metadata: expect.objectContaining({
        retainedUntil: periodicConversation.retainedUntil,
        attachmentCount: 0,
        fileCount: 0,
        artifactCount: 0
      })
    });
  });

  it("expires abandoned draft conversations after the grace period", async () => {
    const clientInstanceId = asClientInstanceId("retention-abandoned-test");
    const store = (await createTestInstance()).stores;
    const managedObjects = createManagedObjectAccess({
      clientInstanceId,
      files: store.files,
      byteStore: new RecordingByteStore(),
      keyFactory: {
        createFileObjectKey(input) {
          return `files/${input.conversationId ?? "unscoped"}/${input.checksum}`;
        },
        createArtifactObjectKey(input) {
          return `artifacts/${input.conversationId}/${input.kind}/${input.checksum}`;
        }
      }
    });
    const options = createRetentionOptions({
      clientInstanceId,
      store,
      attachments: createManagedObjectAttachmentService({ managedObjects })
    });
    const create = (title: string) =>
      store.createConversationForTesting({
        clientInstanceId,
        createdByUserId: "user-1",
        createdByExternalUserId: "external-user-1",
        title,
        retainedUntil: "2999-01-01T00:00:00.000Z"
      });
    const abandoned = await create("5 attached files");
    const started = await create("started");
    await store.conversations.appendMessage({
      clientInstanceId,
      conversationId: started.id,
      role: "user",
      text: "first message"
    });
    const drafting = await create("drafting");
    await createAttachedObjects({
      store: store.files,
      managedObjects,
      clientInstanceId,
      conversation: drafting
    });
    const emptied = await create("emptied");
    const removed = await createAttachedObjects({
      store: store.files,
      managedObjects,
      clientInstanceId,
      conversation: emptied
    });
    await store.files.deleteDraftAttachment({
      clientInstanceId,
      conversationId: emptied.id,
      attachmentId: removed.attachment.id,
      deletedAt: new Date().toISOString()
    });
    const hoursFromNow = (hours: number) => () => new Date(Date.now() + hours * 60 * 60 * 1000);

    await expect(
      new ConversationRetentionWorkflow(options, {
        now: hoursFromNow(23)
      }).expireDueConversations()
    ).resolves.toEqual({ expiredCount: 0, failedCount: 0, cleanupPendingCount: 0 });
    await expectConversationStatus(store, clientInstanceId, abandoned.id, "active");

    await expect(
      new ConversationRetentionWorkflow(options, {
        now: hoursFromNow(25)
      }).expireDueConversations()
    ).resolves.toEqual({ expiredCount: 2, failedCount: 0, cleanupPendingCount: 0 });
    await expectConversationStatus(store, clientInstanceId, abandoned.id, "retention_expired");
    await expectConversationStatus(store, clientInstanceId, emptied.id, "retention_expired");
    await expectConversationStatus(store, clientInstanceId, started.id, "active");
    await expectConversationStatus(store, clientInstanceId, drafting.id, "active");

    const events = await store.audit.listAuditEvents({ clientInstanceId, limit: 10 });
    expect(
      events.find(
        (event) => event.subject === abandoned.id && event.type === "conversation.retention_expired"
      )
    ).toMatchObject({
      status: "success",
      metadata: expect.objectContaining({ reason: "abandoned_draft", attachmentCount: 0 })
    });
  });

  it("keeps overdue conversations while expiry is turned off", async () => {
    const clientInstanceId = asClientInstanceId("retention-off-test");
    const store = (await createTestInstance()).stores;
    const logger = createFailingTestLogger("Retention job failed");
    const conversation = await createExpiredConversation(store, clientInstanceId, "kept");

    await new ConversationRetentionWorkflow(
      createRetentionOptions({ clientInstanceId, store, expireConversations: false })
    ).run(logger);
    await expectConversationStatus(store, clientInstanceId, conversation.id, "active");
    await expect(
      store.conversations.listMessages({ clientInstanceId, conversationId: conversation.id })
    ).resolves.toHaveLength(1);

    // The stamped date still stands: turning expiry back on expires it.
    await new ConversationRetentionWorkflow(
      createRetentionOptions({ clientInstanceId, store })
    ).run(logger);
    await expectConversationStatus(store, clientInstanceId, conversation.id, "retention_expired");
  });

  it("expires only abandoned drafts while expiry is turned off", async () => {
    const clientInstanceId = asClientInstanceId("retention-off-abandoned-test");
    const store = (await createTestInstance()).stores;
    const managedObjects = createManagedObjectAccess({
      clientInstanceId,
      files: store.files,
      byteStore: new RecordingByteStore(),
      keyFactory: {
        createFileObjectKey(input) {
          return `files/${input.conversationId ?? "unscoped"}/${input.checksum}`;
        },
        createArtifactObjectKey(input) {
          return `artifacts/${input.conversationId}/${input.kind}/${input.checksum}`;
        }
      }
    });
    const options = createRetentionOptions({
      clientInstanceId,
      store,
      attachments: createManagedObjectAttachmentService({ managedObjects }),
      expireConversations: false
    });
    // Every conversation is past its stamped date, as after a long time without expiry.
    const create = (title: string) =>
      store.createConversationForTesting({
        clientInstanceId,
        createdByUserId: "user-1",
        createdByExternalUserId: "external-user-1",
        title,
        retainedUntil: "2024-01-01T00:00:00.000Z"
      });
    const abandoned = await create("5 attached files");
    const started = await createExpiredConversation(store, clientInstanceId, "started");
    const drafting = await create("drafting");
    await createAttachedObjects({
      store: store.files,
      managedObjects,
      clientInstanceId,
      conversation: drafting
    });
    const workflowAt = (hours: number) =>
      new ConversationRetentionWorkflow(options, {
        now: () => new Date(Date.now() + hours * 60 * 60 * 1000)
      });

    await expect(workflowAt(23).expireDueConversations()).resolves.toEqual({
      expiredCount: 0,
      failedCount: 0,
      cleanupPendingCount: 0
    });
    await expect(workflowAt(25).expireDueConversations()).resolves.toEqual({
      expiredCount: 1,
      failedCount: 0,
      cleanupPendingCount: 0
    });
    await expectConversationStatus(store, clientInstanceId, abandoned.id, "retention_expired");
    await expectConversationStatus(store, clientInstanceId, started.id, "active");
    await expectConversationStatus(store, clientInstanceId, drafting.id, "active");
    await expect(
      store.conversations.listMessages({ clientInstanceId, conversationId: started.id })
    ).resolves.toHaveLength(1);

    const events = await store.audit.listAuditEvents({ clientInstanceId, limit: 10 });
    expect(
      events.find(
        (event) => event.subject === abandoned.id && event.type === "conversation.retention_expired"
      )
    ).toMatchObject({ metadata: expect.objectContaining({ reason: "abandoned_draft" }) });
  });

  it("leaves the conversation expired when object deletion fails and finishes the cleanup later", async () => {
    const clientInstanceId = asClientInstanceId("retention-retry-test");
    const store = (await createTestInstance()).stores;
    const byteStore = new RecordingByteStore();
    const managedObjects = createManagedObjectAccess({
      clientInstanceId,
      files: store.files,
      byteStore,
      keyFactory: {
        createFileObjectKey(input) {
          return `files/${input.conversationId ?? "unscoped"}/${input.checksum}`;
        },
        createArtifactObjectKey(input) {
          return `artifacts/${input.conversationId}/${input.kind}/${input.checksum}`;
        }
      }
    });
    const attachments = createManagedObjectAttachmentService({ managedObjects });
    const options = createRetentionOptions({
      clientInstanceId,
      store,
      attachments,
      workspaceObjects: byteStore
    });
    const workflow = new ConversationRetentionWorkflow(options);
    const conversation = await createExpiredConversation(store, clientInstanceId, "retry");
    const objects = await createAttachedObjects({
      store: store.files,
      managedObjects,
      clientInstanceId,
      conversation
    });

    const pending = () =>
      store.files.listConversationsPendingObjectCleanup({ clientInstanceId, limit: 10 });

    byteStore.failNextDeleteFor(objects.artifact.objectKey);
    await expect(workflow.expireDueConversations()).resolves.toEqual({
      expiredCount: 1,
      failedCount: 0,
      cleanupPendingCount: 1
    });
    // The expiry stands. What the failed cleanup left is still recorded, so it can be found.
    await expectConversationStatus(store, clientInstanceId, conversation.id, "retention_expired");
    await expect(
      store.files.getManagedArtifact({
        clientInstanceId,
        artifactId: objects.artifact.id
      })
    ).resolves.toMatchObject({
      id: objects.artifact.id,
      status: "available"
    });
    expect(byteStore.has(objects.artifact.objectKey)).toBe(true);
    await expect(pending()).resolves.toEqual([conversation.id]);

    const failedEvents = await store.audit.listAuditEvents({ clientInstanceId, limit: 10 });
    expect(
      failedEvents.find((event) => event.type === "conversation.retention_expired")
    ).toMatchObject({
      status: "success",
      subject: conversation.id,
      metadata: {
        retainedUntil: conversation.retainedUntil,
        reason: "retention_due",
        cleanup: "pending"
      }
    });
    const failureAudit = failedEvents.find((event) => event.type === "conversation.cleanup_failed");
    expect(failureAudit).toMatchObject({
      status: "failed",
      subject: conversation.id,
      metadata: { errorCode: "INTERNAL", errorCategory: "conversation_cleanup" }
    });
    expect(JSON.stringify(failureAudit)).not.toContain(objects.artifact.objectKey);
    expect(
      failedEvents.some((event) => event.type === "conversation.retention_expiration_failed")
    ).toBe(false);

    await expect(workflow.expireDueConversations()).resolves.toEqual({
      expiredCount: 0,
      failedCount: 0,
      cleanupPendingCount: 0
    });
    await expect(workflow.cleanUpPendingConversations()).resolves.toEqual({
      completedCount: 1,
      cleanupPendingCount: 0
    });
    await expectDeletedManagedObjects(store.files, byteStore, clientInstanceId, objects);
    await expect(pending()).resolves.toEqual([]);
    const events = await store.audit.listAuditEvents({ clientInstanceId, limit: 10 });
    expect(events.find((event) => event.type === "conversation.cleanup_completed")).toMatchObject({
      status: "success",
      subject: conversation.id,
      metadata: expect.objectContaining({ fileCount: 1, artifactCount: 1 })
    });
    await expect(workflow.cleanUpPendingConversations()).resolves.toEqual({
      completedCount: 0,
      cleanupPendingCount: 0
    });
  });

  it("sanitizes workspace object keys in direct retention cleanup failure audit", async () => {
    const clientInstanceId = asClientInstanceId("retention-workspace-failure-test");
    const store = (await createTestInstance()).stores;
    const byteStore = new RecordingByteStore();
    const options = createRetentionOptions({
      clientInstanceId,
      store,
      workspaceObjects: byteStore
    });
    const workflow = new ConversationRetentionWorkflow(options);
    const conversation = await createExpiredConversation(
      store,
      clientInstanceId,
      "workspace-failure"
    );
    const workspaceObjects = await createWorkspaceObjects({
      store,
      byteStore,
      clientInstanceId,
      conversation
    });
    byteStore.failNextDeleteFor(workspaceObjects.objectKey);

    await expect(workflow.expireDueConversations()).resolves.toEqual({
      expiredCount: 1,
      failedCount: 0,
      cleanupPendingCount: 1
    });
    await expectConversationStatus(store, clientInstanceId, conversation.id, "retention_expired");

    const events = await store.audit.listAuditEvents({ clientInstanceId, limit: 10 });
    const failureAudit = events.find((event) => event.type === "conversation.cleanup_failed");
    expect(failureAudit).toMatchObject({
      status: "failed",
      subject: conversation.id,
      metadata: { errorCode: "INTERNAL", errorCategory: "conversation_cleanup" }
    });
    expect(JSON.stringify(failureAudit)).not.toContain(workspaceObjects.objectKey);
  });

  it("sanitizes workspace object keys in periodic workspace cleanup failure audit", async () => {
    const clientInstanceId = asClientInstanceId("workspace-cleanup-failure-test");
    const store = (await createTestInstance()).stores;
    const byteStore = new RecordingByteStore();
    const options = createRetentionOptions({
      clientInstanceId,
      store,
      workspaceObjects: byteStore
    });
    const conversation = await createExpiredConversation(
      store,
      clientInstanceId,
      "cleanup-failure"
    );
    const workspaceObjects = await createWorkspaceObjects({
      store,
      byteStore,
      clientInstanceId,
      conversation
    });
    await store.conversations.deleteConversation({
      clientInstanceId,
      conversationId: conversation.id,
      deletedAt: "2024-01-02T00:00:00.000Z"
    });
    byteStore.failNextDeleteFor(workspaceObjects.objectKey);

    const workflow = new ExecutionWorkspaceCleanupWorkflow(options);
    await expect(workflow.cleanupDeletedConversationWorkspaces()).resolves.toEqual({
      cleanedCount: 0,
      failedCount: 1
    });

    const events = await store.audit.listAuditEvents({ clientInstanceId, limit: 10 });
    const cleanupAudit = events.find(
      (event) => event.type === "execution_workspace.cleanup_failed"
    );
    expect(cleanupAudit).toMatchObject({
      status: "failed",
      subject: conversation.id,
      metadata: expect.objectContaining({
        errorCode: "INTERNAL",
        errorCategory: "workspace_cleanup",
        errorMessage: "Execution workspace cleanup failed"
      })
    });
    expect(JSON.stringify(cleanupAudit)).not.toContain(workspaceObjects.objectKey);
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;

describe("conversation expiry claim in Postgres", () => {
  const clientInstanceId = asClientInstanceId("expiry-claim-test");
  const now = new Date();
  // Every Conversation without a message counts as an abandoned draft under these criteria.
  const criteria = {
    now: now.toISOString(),
    abandonedBefore: new Date(now.getTime() + DAY_MS).toISOString()
  };

  async function raceInOrder<A, B>(
    first: (stores: import("@work-shape/catalyst-core").PlatformStores) => Promise<A>,
    second: (stores: import("@work-shape/catalyst-core").PlatformStores) => Promise<B>
  ) {
    const prefix = `expiry_${globalThis.crypto.randomUUID()}`;
    const firstName = `${prefix}_first`;
    const secondName = `${prefix}_second`;
    const firstStore = (await createTestInstance({ postgres: { applicationName: firstName } }))
      .stores;
    const secondStore = (await createTestInstance({ postgres: { applicationName: secondName } }))
      .stores;
    const observer = postgres(await fileTestDatabaseUrl(), { max: 1 });
    try {
      return await orderedStoreCalls(
        observer,
        { first: firstStore, firstName, secondName },
        first,
        () => second(secondStore)
      );
    } finally {
      await observer.end();
    }
  }

  async function createDraftWithAcceptance(store: TestStore) {
    const conversation = await store.createConversationForTesting({
      clientInstanceId,
      createdByUserId: "user-1",
      createdByExternalUserId: "external-user-1",
      title: "draft",
      retainedUntil: "2999-01-01T00:00:00.000Z"
    });
    const ownerUserId = asUserId(conversation.createdByUserId);
    const claim = await store.agentRuns.claimRunStartCommand({
      clientInstanceId,
      ownerUserId,
      idempotencyKey: "key-1",
      commandKind: "start_conversation_run"
    });
    const messageId = asMessageId("msg_first");
    const acceptance: PrepareConversationRunStartInput = {
      clientInstanceId,
      conversationId: conversation.id,
      ownerUserId,
      userMessage: { id: messageId, text: "First message" },
      run: {
        id: asAgentRunId("run_first"),
        clientInstanceId,
        conversationId: conversation.id,
        ownerUserId,
        inputMessageId: messageId,
        agentName: "expiry-test",
        correlationId: "corr_first"
      },
      runStartCommand: {
        idempotencyKey: "key-1",
        commandKind: "start_conversation_run",
        claimedAt: claim.command.updatedAt
      }
    };
    const expiry = {
      clientInstanceId,
      conversationId: conversation.id,
      expiredAt: criteria.now,
      ...criteria
    };
    return { conversation, acceptance, expiry };
  }

  it("keeps a draft whose first message takes the conversation lock before expiry", async () => {
    const store = (await createTestInstance()).stores;
    const { conversation, acceptance, expiry } = await createDraftWithAcceptance(store);
    await expect(
      store.conversations.listExpiredConversations({ clientInstanceId, ...criteria, limit: 10 })
    ).resolves.toEqual([expect.objectContaining({ id: conversation.id })]);

    const [accepted, expired] = await raceInOrder(
      (tx) => tx.agentRuns.prepareConversationRunStart(acceptance),
      (tx) => tx.conversations.expireConversation(expiry)
    );

    expect(accepted).toMatchObject({ status: "fulfilled" });
    expect(expired).toEqual({ status: "fulfilled", value: { status: "not_expired" } });
    await expectConversationStatus(store, clientInstanceId, conversation.id, "active");
    await expect(
      store.conversations.listMessages({ clientInstanceId, conversationId: conversation.id })
    ).resolves.toEqual([expect.objectContaining({ text: "First message" })]);
  });

  it("refuses a first message once expiry holds the conversation lock", async () => {
    const store = (await createTestInstance()).stores;
    const { conversation, acceptance, expiry } = await createDraftWithAcceptance(store);

    const [expired, accepted] = await raceInOrder(
      (tx) => tx.conversations.expireConversation(expiry),
      (tx) => tx.agentRuns.prepareConversationRunStart(acceptance)
    );

    expect(expired).toMatchObject({
      status: "fulfilled",
      value: { status: "expired", reason: "abandoned_draft" }
    });
    expect(accepted).toMatchObject({
      status: "rejected",
      reason: { code: "NOT_FOUND", message: "Conversation is not available" }
    });
    await expectConversationStatus(store, clientInstanceId, conversation.id, "retention_expired");
    await expect(
      store.agentRuns.getAgentRun({ clientInstanceId, runId: acceptance.run.id })
    ).resolves.toBeUndefined();
  });

  it("keeps a workspace whose deleted conversation still waits for its cleanup", async () => {
    const store = (await createTestInstance()).stores;
    const byteStore = new RecordingByteStore();
    const managedObjects = createTestManagedObjectAccess({
      clientInstanceId,
      files: store.files,
      byteStore
    });
    const options = createRetentionOptions({
      clientInstanceId,
      store,
      attachments: createManagedObjectAttachmentService({ managedObjects })
    });
    const owner = await store.users.createUser({ clientInstanceId, displayLabel: "Owner" });
    const workspace = await store.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Shared",
      creatorUserId: owner.id
    });
    const conversation = await store.conversations.createConversation({
      visibility: "workspace",
      clientInstanceId,
      collaborationWorkspaceId: workspace.id,
      createdByUserId: owner.id,
      createdByExternalUserId: "external-owner",
      title: "with a file",
      retainedUntil: "2999-01-01T00:00:00.000Z"
    });
    const objects = await createAttachedObjects({
      store: store.files,
      managedObjects,
      clientInstanceId,
      conversation
    });
    await store.conversations.deleteConversation({
      clientInstanceId,
      conversationId: conversation.id,
      deletedAt: new Date().toISOString()
    });
    const deleteWorkspace = () =>
      store.workspaces.deleteWorkspace({
        clientInstanceId,
        collaborationWorkspaceId: workspace.id
      });

    await expect(deleteWorkspace()).rejects.toMatchObject({
      code: "CONFLICT",
      details: { pendingCleanupCount: 1 }
    });
    expect(byteStore.has(objects.file.objectKey)).toBe(true);

    await expect(
      new ConversationRetentionWorkflow(options).cleanUpPendingConversations()
    ).resolves.toEqual({ completedCount: 1, cleanupPendingCount: 0 });
    await expect(deleteWorkspace()).resolves.toMatchObject({ id: workspace.id });
    expect(byteStore.keys()).toEqual([]);
  });

  it("compares the retention date as an instant, whatever its spelling", async () => {
    const store = (await createTestInstance()).stores;
    // The same instant as the `now` below, written with an offset. As text it sorts after it.
    const conversation = await store.createConversationForTesting({
      clientInstanceId,
      createdByUserId: "user-1",
      createdByExternalUserId: "external-user-1",
      title: "due this instant",
      retainedUntil: "2024-01-01T01:00:00.000+01:00"
    });
    await store.conversations.appendMessage({
      clientInstanceId,
      conversationId: conversation.id,
      role: "user",
      text: "message"
    });
    const due = { now: "2024-01-01T00:00:00.000Z", abandonedBefore: "2000-01-01T00:00:00.000Z" };
    const scope = { clientInstanceId, conversationId: conversation.id };

    await expect(
      store.conversations.expireConversation({
        ...scope,
        expiredAt: due.now,
        ...due,
        now: "2023-12-31T23:59:59.999Z"
      })
    ).resolves.toEqual({ status: "not_expired" });
    await expect(
      store.conversations.listExpiredConversations({ clientInstanceId, ...due, limit: 10 })
    ).resolves.toEqual([expect.objectContaining({ id: conversation.id })]);
    await expect(
      store.conversations.expireConversation({ ...scope, expiredAt: due.now, ...due })
    ).resolves.toMatchObject({ status: "expired", reason: "retention_due" });
  });
});

async function createOrphanFixture(name: string, keyPrefix = "files") {
  const clientInstanceId = asClientInstanceId(name);
  const store = (await createTestInstance()).stores;
  const byteStore = new RecordingByteStore();
  const managedObjects = createManagedObjectAccess({
    clientInstanceId,
    files: store.files,
    byteStore,
    keyFactory: {
      createFileObjectKey(input) {
        const prefix = input.filename.startsWith("foreign") ? "foreign" : keyPrefix;
        return `${prefix}/${input.conversationId ?? "unscoped"}/${input.checksum}`;
      },
      createArtifactObjectKey(input) {
        return `artifacts/${input.conversationId}/${input.kind}/${input.checksum}`;
      }
    }
  });
  const options = createRetentionOptions({
    clientInstanceId,
    store,
    attachments: createManagedObjectAttachmentService({ managedObjects, byteStore })
  });
  const createFile = (conversation: Conversation, filename: string, content = filename) =>
    managedObjects.createFile({
      ownerUserId: conversation.createdByUserId,
      conversationId: conversation.id,
      filename,
      mimeType: "text/plain",
      bytes: new TextEncoder().encode(content)
    });
  const attach = (conversation: Conversation, file: ManagedFileRecord) =>
    store.files.createConversationAttachment({
      clientInstanceId,
      conversationId: conversation.id,
      fileId: file.id,
      filename: file.filename,
      mimeType: file.mimeType,
      byteSize: file.byteSize,
      checksum: file.checksum,
      status: "ready",
      format: "txt"
    });
  const createConversation = (title: string) =>
    store.createConversationForTesting({
      clientInstanceId,
      createdByUserId: "user-1",
      createdByExternalUserId: "external-user-1",
      title,
      retainedUntil: "2999-01-01T00:00:00.000Z"
    });
  const isAvailable = async (file: ManagedFileRecord) =>
    (await store.files.getManagedFile({ clientInstanceId, fileId: file.id })) !== undefined;
  return {
    clientInstanceId,
    store,
    byteStore,
    options,
    createFile,
    attach,
    createConversation,
    isAvailable,
    /** A workflow that runs after the grace period of everything created so far. */
    laterWorkflow: (batchSize?: number) =>
      new ConversationRetentionWorkflow(options, {
        batchSize,
        now: () => new Date(Date.now() + 2 * DAY_MS)
      })
  };
}

describe("orphaned managed file cleanup", () => {
  it("removes files without an active conversation and keeps every file that has one", async () => {
    const fixture = await createOrphanFixture("orphan-test");
    const { store, byteStore, clientInstanceId } = fixture;
    const active = await fixture.createConversation("active");
    const deleted = await fixture.createConversation("deleted without cleanup");

    const neverAttached = await fixture.createFile(active, "never-attached.txt");
    const leftBehind = await fixture.createFile(deleted, "left-behind.txt");
    await fixture.attach(deleted, leftBehind);
    await store.conversations.deleteConversation({
      clientInstanceId,
      conversationId: deleted.id,
      deletedAt: new Date().toISOString()
    });
    const attached = await fixture.createFile(active, "attached.txt");
    await fixture.attach(active, attached);
    const removedDraft = await fixture.createFile(active, "removed-draft.txt");
    const removedDraftAttachment = await fixture.attach(active, removedDraft);
    await store.files.deleteDraftAttachment({
      clientInstanceId,
      conversationId: active.id,
      attachmentId: removedDraftAttachment.id,
      deletedAt: new Date().toISOString()
    });

    // A file younger than the grace period may still be on its way into a conversation.
    await expect(
      new ConversationRetentionWorkflow(fixture.options).deleteOrphanedManagedFiles()
    ).resolves.toEqual({ fileCount: 0, objectCount: 0, unclaimedCount: 0 });
    expect(byteStore.deletedKeys).toEqual([]);

    const workflow = fixture.laterWorkflow();
    await expect(workflow.deleteOrphanedManagedFiles()).resolves.toEqual({
      fileCount: 2,
      objectCount: 2,
      unclaimedCount: 0
    });
    for (const file of [neverAttached, leftBehind]) {
      expect(byteStore.has(file.objectKey)).toBe(false);
      await expect(fixture.isAvailable(file)).resolves.toBe(false);
    }
    for (const file of [attached, removedDraft]) {
      expect(byteStore.has(file.objectKey)).toBe(true);
      await expect(fixture.isAvailable(file)).resolves.toBe(true);
    }

    await expect(workflow.deleteOrphanedManagedFiles()).resolves.toEqual({
      fileCount: 0,
      objectCount: 0,
      unclaimedCount: 0
    });
    const audits = (await store.audit.listAuditEvents({ clientInstanceId, limit: 20 })).filter(
      (event) => event.type.startsWith("storage.")
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      type: "storage.orphaned_files_deleted",
      status: "success",
      metadata: { fileCount: 2, objectCount: 2, unclaimedCount: 0 }
    });
    expect(audits[0]!.subject).toBeUndefined();
    expect(JSON.stringify(audits[0])).not.toContain(neverAttached.objectKey);
  });

  it("keeps bytes that a file with an owner stores under the same object key", async () => {
    const fixture = await createOrphanFixture("orphan-shared-key-test");
    const active = await fixture.createConversation("active");
    const attached = await fixture.createFile(active, "same.txt", "same bytes");
    await fixture.attach(active, attached);
    const duplicate = await fixture.createFile(active, "same.txt", "same bytes");
    expect(duplicate.objectKey).toBe(attached.objectKey);

    await expect(fixture.laterWorkflow().deleteOrphanedManagedFiles()).resolves.toEqual({
      fileCount: 1,
      objectCount: 0,
      unclaimedCount: 0
    });
    expect(fixture.byteStore.has(attached.objectKey)).toBe(true);
    await expect(fixture.isAvailable(attached)).resolves.toBe(true);
    await expect(fixture.isAvailable(duplicate)).resolves.toBe(false);
  });

  it("leaves a file whose object no handler stores and continues past it", async () => {
    const fixture = await createOrphanFixture("orphan-unclaimed-test");
    const conversation = await fixture.createConversation("active");
    const foreign = await fixture.createFile(conversation, "foreign.txt");
    const own = [
      await fixture.createFile(conversation, "own-1.txt"),
      await fixture.createFile(conversation, "own-2.txt")
    ];

    await expect(fixture.laterWorkflow(1).deleteOrphanedManagedFiles()).resolves.toEqual({
      fileCount: 2,
      objectCount: 2,
      unclaimedCount: 1
    });
    expect(fixture.byteStore.has(foreign.objectKey)).toBe(true);
    await expect(fixture.isAvailable(foreign)).resolves.toBe(true);
    for (const file of own) {
      expect(fixture.byteStore.has(file.objectKey)).toBe(false);
      await expect(fixture.isAvailable(file)).resolves.toBe(false);
    }
  });

  it("keeps the file retryable and audits counts only when byte deletion fails", async () => {
    const fixture = await createOrphanFixture("orphan-failure-test");
    const { store, byteStore, clientInstanceId } = fixture;
    const conversation = await fixture.createConversation("active");
    const orphan = await fixture.createFile(conversation, "orphan.txt");
    const workflow = fixture.laterWorkflow();

    byteStore.failNextDeleteFor(orphan.objectKey);
    await expect(workflow.deleteOrphanedManagedFiles()).rejects.toThrow();
    await expect(fixture.isAvailable(orphan)).resolves.toBe(true);
    const failure = (await store.audit.listAuditEvents({ clientInstanceId, limit: 10 })).find(
      (event) => event.type === "storage.orphaned_file_cleanup_failed"
    );
    expect(failure).toMatchObject({
      status: "failed",
      metadata: { fileCount: 0, objectCount: 0, errorCategory: "orphaned_file_cleanup" }
    });
    expect(JSON.stringify(failure)).not.toContain(orphan.objectKey);

    await expect(workflow.deleteOrphanedManagedFiles()).resolves.toMatchObject({ fileCount: 1 });
    expect(byteStore.has(orphan.objectKey)).toBe(false);
  });

  it("runs after conversation expiry in the retention run", async () => {
    const fixture = await createOrphanFixture("orphan-job-test");
    const conversation = await fixture.createConversation("active");
    const orphan = await fixture.createFile(conversation, "orphan.txt");
    await fixture.laterWorkflow().run(createFailingTestLogger("Retention job failed"));

    expect(fixture.byteStore.has(orphan.objectKey)).toBe(false);
    await expect(fixture.isAvailable(orphan)).resolves.toBe(false);
  });
});

async function createExpiredConversation(
  store: TestStore,
  clientInstanceId: ClientInstanceId,
  title: string
): Promise<Conversation> {
  const conversation = await store.createConversationForTesting({
    clientInstanceId,
    createdByUserId: "user-1",
    createdByExternalUserId: "external-user-1",
    title,
    retainedUntil: "2024-01-01T00:00:00.000Z"
  });
  await store.conversations.appendMessage({
    clientInstanceId,
    conversationId: conversation.id,
    role: "user",
    text: `message for ${title}`
  });
  return conversation;
}

async function createWorkspaceObjects(input: {
  store: TestStore;
  byteStore: RecordingByteStore;
  clientInstanceId: ClientInstanceId;
  conversation: Conversation;
}): Promise<{
  workspaceId: string;
  objectKey: string;
  objectKeys: string[];
}> {
  const workspace = await input.store.executionWorkspaces.ensureExecutionWorkspace({
    clientInstanceId: input.clientInstanceId,
    conversationId: input.conversation.id,
    ownerUserId: input.conversation.createdByUserId,
    now: "2023-12-31T23:00:00.000Z"
  });
  // The files below name this command; it is the one stored command of the workspace.
  const command = await input.store.executionWorkspaces.enqueueWorkspaceCommand({
    clientInstanceId: input.clientInstanceId,
    workspaceId: workspace.id,
    ownerUserId: input.conversation.createdByUserId,
    command: "python3 calculate.py",
    limits: {
      timeoutSeconds: 60,
      idleTimeoutSeconds: 30,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
      maxWorkspaceBytes: 100 * 1024 * 1024
    },
    queuedAt: "2023-12-31T23:02:00.000Z"
  });
  const files = [
    {
      path: "scripts/build-report.py",
      body: "print('retained script')\n",
      mimeType: "text/x-python",
      metadata: { source: "workspace.exec", role: "script" }
    },
    {
      path: "previews/page-1.png",
      body: "png bytes",
      mimeType: "image/png",
      metadata: { source: "workspace.exec", role: "preview" }
    },
    {
      path: "tmp/session-cache.json",
      body: '{"cached":true}\n',
      mimeType: "application/json",
      metadata: { source: "workspace.exec", role: "temporary" }
    },
    {
      path: "artifacts/unpromoted.csv",
      body: "value\n42\n",
      mimeType: "text/csv",
      metadata: { source: "workspace.exec", role: "unpromoted_artifact" }
    },
    {
      path: "artifacts/final-report.pdf",
      body: "%PDF promoted placeholder\n",
      mimeType: "application/pdf",
      metadata: {
        source: "workspace.exec",
        promotedArtifacts: [{ artifactId: "artifact_retention_seed", kind: "document.pdf" }]
      }
    }
  ];
  const objectKeys: string[] = [];
  for (const file of files) {
    const objectKey = `execution-workspaces/${input.conversation.id}/${file.path}`;
    const bytes = new TextEncoder().encode(file.body);
    objectKeys.push(objectKey);
    await input.byteStore.put(objectKey, bytes);
    const metadata = unknownToJsonValue(file.metadata);
    if (!isJsonObject(metadata)) throw new Error("Expected workspace file metadata");
    await input.store.executionWorkspaces.upsertWorkspaceFile({
      clientInstanceId: input.clientInstanceId,
      workspaceId: workspace.id,
      path: file.path,
      objectKey,
      byteSize: bytes.byteLength,
      checksum: `sha256:${file.path}`,
      mimeType: file.mimeType,
      metadata,
      lastCommandId: command.id,
      updatedAt: "2023-12-31T23:01:00.000Z"
    });
  }
  const deletedObjectKey = `execution-workspaces/${input.conversation.id}/tmp/deleted-before-retention.txt`;
  const deletedBytes = new TextEncoder().encode("deleted before retention");
  objectKeys.push(deletedObjectKey);
  await input.byteStore.put(deletedObjectKey, deletedBytes);
  await input.store.executionWorkspaces.upsertWorkspaceFile({
    clientInstanceId: input.clientInstanceId,
    workspaceId: workspace.id,
    path: "tmp/deleted-before-retention.txt",
    objectKey: deletedObjectKey,
    byteSize: deletedBytes.byteLength,
    checksum: "sha256:deleted-before-retention",
    mimeType: "text/plain",
    metadata: { source: "workspace.exec", role: "temporary" },
    lastCommandId: command.id,
    updatedAt: "2023-12-31T23:01:30.000Z"
  });
  await input.store.executionWorkspaces.deleteWorkspaceFile({
    clientInstanceId: input.clientInstanceId,
    workspaceId: workspace.id,
    path: "tmp/deleted-before-retention.txt",
    lastCommandId: command.id,
    deletedAt: "2023-12-31T23:01:45.000Z"
  });
  return {
    workspaceId: workspace.id,
    objectKey: objectKeys[0]!,
    objectKeys
  };
}

async function expectConversationStatus(
  store: TestStore,
  clientInstanceId: ClientInstanceId,
  conversationId: ConversationId,
  status: Conversation["status"]
): Promise<void> {
  await expect(
    store.conversations.getConversation(clientInstanceId, conversationId)
  ).resolves.toMatchObject({
    status
  });
}

async function expectDeletedManagedObjects(
  store: PlatformFileStore,
  byteStore: RecordingByteStore,
  clientInstanceId: ClientInstanceId,
  objects: {
    attachment: ConversationAttachment;
    file: ManagedFileRecord;
    artifact: ManagedArtifactRecord;
  }
): Promise<void> {
  await expect(
    store.getConversationAttachment({
      clientInstanceId,
      attachmentId: objects.attachment.id
    })
  ).resolves.toBeUndefined();
  await expect(
    store.getManagedFile({
      clientInstanceId,
      fileId: objects.file.id
    })
  ).resolves.toBeUndefined();
  await expect(
    store.getManagedArtifact({
      clientInstanceId,
      artifactId: objects.artifact.id
    })
  ).resolves.toBeUndefined();
  expect(byteStore.has(objects.file.objectKey)).toBe(false);
  expect(byteStore.has(objects.artifact.objectKey)).toBe(false);
  expect(byteStore.deletedKeys).toEqual(
    expect.arrayContaining([objects.artifact.objectKey, objects.file.objectKey])
  );
}

async function expectDeletedWorkspaceObjects(
  store: TestStore,
  byteStore: RecordingByteStore,
  clientInstanceId: ClientInstanceId,
  objects: {
    workspaceId: string;
    objectKey: string;
    objectKeys: string[];
  }
): Promise<void> {
  await expect(
    store.executionWorkspaces.getExecutionWorkspace({
      clientInstanceId,
      workspaceId: asExecutionWorkspaceId(objects.workspaceId)
    })
  ).resolves.toBeUndefined();
  await expect(
    store.executionWorkspaces.listWorkspaceFiles({
      clientInstanceId,
      workspaceId: asExecutionWorkspaceId(objects.workspaceId)
    })
  ).resolves.toEqual([]);
  for (const objectKey of objects.objectKeys) {
    expect(byteStore.has(objectKey)).toBe(false);
  }
  expect(byteStore.deletedKeys).toEqual(expect.arrayContaining(objects.objectKeys));
}

/**
 * The job commits a conversation's expiry first, deletes its data next and records the audit
 * event last, so the event marks the moment a test may look for the data.
 */
async function waitForRetentionAudit(
  store: TestStore,
  clientInstanceId: ClientInstanceId,
  conversationId: ConversationId
): Promise<void> {
  await waitFor(async () => {
    const events = await store.audit.listAuditEvents({ clientInstanceId, limit: 10 });
    expect(
      events.some(
        (event) =>
          event.subject === conversationId && event.type === "conversation.retention_expired"
      )
    ).toBe(true);
  });
}

async function waitFor(assertion: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for assertion");
}

describe("conversation cleanup without object storage", () => {
  it.each([
    { expireConversations: false, throws: true },
    { expireConversations: true, throws: false }
  ])(
    "retries leftover Operation Runs with expiry $expireConversations and throwing cleanup $throws",
    async ({ expireConversations, throws }) => {
      const config = createTestConfig();
      config.retention.expireConversations = expireConversations;
      // The default instance has neither attachments nor Pages storage.
      const instance = await createTestInstanceWith(() => ({ config }));
      const clientInstanceId = asClientInstanceId(config.clientInstance.id);
      const created = await instance.call("conversations.create", {
        payload: { title: "Database-only cleanup" }
      });
      expect(created.statusCode).toBeLessThan(300);
      const conversationId = asConversationId(created.json<{ id: string }>().id);
      const runs = instance.stores.operationRuns;
      const output = { value: { sensitive: "conversation output" } };
      const run = await runs.create({
        id: createPlatformId<"OperationRunId">("oprun"),
        clientInstanceId,
        conversationId,
        operation: "items.create",
        effect: "changing",
        target: "live",
        actor: { kind: "user", id: "user-1", label: "One" },
        origin: { kind: "user" },
        inputHash: "a".repeat(64),
        correlationId: "corr_cleanup_without_storage",
        startedAt: new Date().toISOString()
      });
      if (!run) throw new Error("The operation must start a run");
      await runs.finish({
        clientInstanceId,
        id: run.id,
        end: { status: "done", finishedAt: new Date().toISOString(), output }
      });
      const storedRun = () => runs.get({ clientInstanceId, id: run.id });
      const pending = () =>
        instance.stores.files.listConversationsPendingObjectCleanup({
          clientInstanceId,
          limit: 100
        });
      const removeRuns = vi.spyOn(runs, "deleteOfConversations");
      if (throws)
        removeRuns.mockRejectedValueOnce(new Error("Transient Operation Run cleanup failure"));
      else removeRuns.mockResolvedValueOnce(0); // A run kept while its request is still settling.

      try {
        const deleted = await instance.call("conversations.delete", {
          params: { conversationId }
        });
        expect(deleted.statusCode).toBeLessThan(300);
        expect(removeRuns).toHaveBeenCalledTimes(1);
        expect(
          await instance.stores.conversations.getConversation(clientInstanceId, conversationId)
        ).toMatchObject({ status: "deleted" });
        await expect(storedRun()).resolves.toMatchObject({ output });
        await expect(pending()).resolves.toContain(conversationId);

        // Age pruning deliberately leaves conversation-linked runs for conversation cleanup.
        await runs.deleteWithoutConversationOlderThan({ clientInstanceId, days: 0, limit: 100 });
        await expect(storedRun()).resolves.toMatchObject({ output });

        await instance.stores.jobs.enqueue(
          expireConversationsJob,
          {},
          {
            clientInstanceId,
            dedupeKey: scheduleDedupeKey(expireConversationsJob.kind)
          }
        );
        await getTestJobs(instance).runDue();

        await expect(storedRun()).resolves.toBeUndefined();
        expect(removeRuns).toHaveBeenCalledTimes(2);
        await expect(pending()).resolves.not.toContain(conversationId);
      } finally {
        removeRuns.mockRestore();
      }
    }
  );
});

/** The retention period of every instance in this file. */
const CONVERSATION_DAYS = 30;

describe("retention counts from the last message", () => {
  it("moves the date with an accepted message and with nothing else", async () => {
    const app = await createApp({ extendOnActivity: true });
    const conversation = await createConversation(app, "Quarterly offer");
    await setDaysLeft(conversation.id, 10);

    const renamed = await app.call("conversations.rename", {
      params: { conversationId: conversation.id },
      payload: { title: "Renamed" }
    });
    expect(renamed.statusCode).toBe(200);
    const read = await app.call("conversations.thread.get", {
      params: { conversationId: conversation.id }
    });
    expect(read.statusCode).toBe(200);
    await expect(daysLeft(conversation.id)).resolves.toBeCloseTo(10, 1);

    // Day 20 of 30: the date moves to day 50.
    const sent = await injectStartConversationRun(app, conversation.id, "Still needed");
    await drainRunEvents(app, conversation.id, sent.run.id);
    await expect(daysLeft(conversation.id)).resolves.toBeCloseTo(CONVERSATION_DAYS, 1);

    // The title job belongs to that first message and runs later. It is not activity.
    await setDaysLeft(conversation.id, 10);
    await getTestJobs(app).runDue();
    await expect(titleJobStatus(conversation.id)).resolves.toBe("succeeded");
    await expect(daysLeft(conversation.id)).resolves.toBeCloseTo(10, 1);
  });

  it("keeps the date set at creation when the instance does not extend on activity", async () => {
    const app = await createApp({ extendOnActivity: false });
    const conversation = await createConversation(app, "Fixed maximum age");
    await setDaysLeft(conversation.id, 10);

    const sent = await injectStartConversationRun(app, conversation.id, "A later message");
    await drainRunEvents(app, conversation.id, sent.run.id);
    await getTestJobs(app).runDue();

    await expect(daysLeft(conversation.id)).resolves.toBeCloseTo(10, 1);
  });

  it("extends by default and says so in the config the interface loads", async () => {
    expect(createTestConfig().retention.extendOnActivity).toBe(true);
    const app = await createApp({ extendOnActivity: true });
    const answer = await app.call("config.get", {});
    expect(answer.json<SafeConfig>().retention.extendOnActivity).toBe(true);
  });

  it("loads the config answer of an API from before the setting", async () => {
    const app = await createApp({ extendOnActivity: true });
    const current = (await app.call("config.get", {})).json<SafeConfig>();
    // The previous release answers these four retention keys and no other.
    const { conversationDays, expireConversations, auditDays, allowUserDelete } = current.retention;
    const previous = {
      ...current,
      retention: { conversationDays, expireConversations, auditDays, allowUserDelete }
    };
    const client = createApiClient({
      baseUrl: "http://api.test",
      fetchImpl: async () => Response.json(previous)
    });

    const loaded = await client.config.get();
    expect(loaded.retention).toEqual(previous.retention);
    // The interface reads the missing key as false and promises nothing.
    expect(loaded.retention.extendOnActivity).toBeUndefined();
  });

  it("keeps a due conversation with all its files when a message arrives before the claim", async () => {
    const clientInstanceId = asClientInstanceId("retention-extension-claim");
    const store = (await createTestInstance()).stores;
    const byteStore = new RecordingByteStore();
    const managedObjects = createTestManagedObjectAccess({
      clientInstanceId,
      files: store.files,
      byteStore
    });
    const options = createRetentionOptions({
      clientInstanceId,
      store,
      attachments: createManagedObjectAttachmentService({ managedObjects }),
      workspaceObjects: byteStore
    });
    const conversation = await store.createConversationForTesting({
      clientInstanceId,
      createdByUserId: "user-1",
      createdByExternalUserId: "external-user-1",
      title: "Due",
      retainedUntil: "2024-01-01T00:00:00.000Z"
    });
    await store.conversations.appendMessage({
      clientInstanceId,
      conversationId: conversation.id,
      role: "user",
      text: "The first message"
    });
    const objects = await createAttachedObjects({
      store: store.files,
      managedObjects,
      clientInstanceId,
      conversation
    });

    // The job has read its list of due conversations; the message lands before the claim.
    let listedAsDue: string[] = [];
    const workflow = new ConversationRetentionWorkflow({
      ...options,
      stores: {
        ...options.stores,
        conversations: {
          ...options.stores.conversations,
          async listExpiredConversations(input) {
            const due = await options.stores.conversations.listExpiredConversations(input);
            listedAsDue = due.map((listed) => listed.id);
            await acceptMessage(store, clientInstanceId, conversation, CONVERSATION_DAYS);
            return due;
          }
        }
      }
    });

    await expect(workflow.expireDueConversations()).resolves.toEqual({
      expiredCount: 0,
      failedCount: 0,
      cleanupPendingCount: 0
    });
    expect(listedAsDue).toEqual([conversation.id]);
    await expect(
      store.conversations.getConversation(clientInstanceId, conversation.id)
    ).resolves.toMatchObject({ status: "active" });
    await expect(daysLeft(conversation.id)).resolves.toBeCloseTo(CONVERSATION_DAYS, 1);
    await expect(
      store.conversations.listMessages({ clientInstanceId, conversationId: conversation.id })
    ).resolves.toHaveLength(2);
    await expect(
      store.files.getConversationAttachment({
        clientInstanceId,
        attachmentId: objects.attachment.id
      })
    ).resolves.toMatchObject({ id: objects.attachment.id });
    await expect(
      store.files.getManagedFile({ clientInstanceId, fileId: objects.file.id })
    ).resolves.toMatchObject({ id: objects.file.id });
    await expect(
      store.files.getManagedArtifact({ clientInstanceId, artifactId: objects.artifact.id })
    ).resolves.toMatchObject({ status: "available" });
    expect(byteStore.has(objects.file.objectKey)).toBe(true);
    expect(byteStore.has(objects.artifact.objectKey)).toBe(true);
    expect(byteStore.deleteAttempts).toEqual([]);
  });

  it("leaves the later date when two messages are accepted at once", async () => {
    const clientInstanceId = asClientInstanceId("retention-extension-race");
    const store = (await createTestInstance()).stores;
    const conversation = await store.createConversationForTesting({
      clientInstanceId,
      createdByUserId: "user-1",
      createdByExternalUserId: "external-user-1",
      title: "Two at once",
      retainedUntil: new Date().toISOString()
    });

    // Both wait for the Conversation row lock. A Conversation runs one message at a time, so
    // the second is accepted only if the first one's run has ended by then.
    const periods = [60, CONVERSATION_DAYS];
    const outcomes = await Promise.allSettled(
      periods.map((days) => acceptMessage(store, clientInstanceId, conversation, days))
    );
    const accepted = periods.filter((_, index) => outcomes[index]?.status === "fulfilled");
    expect(accepted.length).toBeGreaterThan(0);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(outcome.reason).toMatchObject({ code: "CONFLICT" });
      }
    }
    await expect(daysLeft(conversation.id)).resolves.toBeCloseTo(Math.max(...accepted), 1);

    // Whatever the order, the date only moves later: a shorter period never takes it back.
    await acceptMessage(store, clientInstanceId, conversation, 60);
    await acceptMessage(store, clientInstanceId, conversation, CONVERSATION_DAYS);
    await expect(daysLeft(conversation.id)).resolves.toBeCloseTo(60, 1);
  });
});

function createApp(retention: { extendOnActivity: boolean }): Promise<TestInstance> {
  const config = createTestConfig();
  config.retention.conversationDays = CONVERSATION_DAYS;
  config.retention.extendOnActivity = retention.extendOnActivity;
  return createTestInstance({ config, env: {}, tools: [] });
}

async function createConversation(app: TestInstance, title: string): Promise<{ id: string }> {
  const created = await app.call("conversations.create", { payload: { title } });
  expect(created.statusCode).toBe(200);
  return created.json<{ id: string }>();
}

/** Accepts a user message and ends its run, so the Conversation is idle afterwards. */
async function acceptMessage(
  store: PlatformStores,
  clientInstanceId: ClientInstanceId,
  conversation: Conversation,
  extendRetentionDays: number
): Promise<void> {
  const id = globalThis.crypto.randomUUID();
  const inputMessageId = asMessageId(`msg_${id}`);
  const { run } = await store.agentRuns.prepareConversationRunStart({
    clientInstanceId,
    conversationId: conversation.id,
    ownerUserId: conversation.createdByUserId,
    userMessage: { id: inputMessageId, text: "Still needed" },
    run: {
      id: asAgentRunId(`run_${id}`),
      clientInstanceId,
      conversationId: conversation.id,
      ownerUserId: conversation.createdByUserId,
      inputMessageId,
      agentName: "test_agent",
      correlationId: `corr_${id}`
    },
    extendRetentionDays
  });
  const endedAt = new Date().toISOString();
  await store.agentRuns.updateAgentRunStatus({
    clientInstanceId,
    runId: run.id,
    status: "completed",
    updatedAt: endedAt,
    completedAt: endedAt
  });
}

async function withSql<Result>(run: (sql: postgres.Sql) => Promise<Result>): Promise<Result> {
  const sql = postgres(await fileTestDatabaseUrl(), { max: 1 });
  try {
    return await run(sql);
  } finally {
    await sql.end();
  }
}

/** Puts the Conversation that many days before its date, as on a later day of its period. */
function setDaysLeft(conversationId: string, days: number): Promise<void> {
  return withSql(async (sql) => {
    await sql`
      update conversations set retained_until = now() + make_interval(days => ${days})
      where id = ${conversationId}`;
  });
}

/** Days from the database's present to the retention date, on the clock the store uses. */
function daysLeft(conversationId: string): Promise<number> {
  return withSql(async (sql) => {
    const [row] = await sql<{ days: number }[]>`
      select (extract(epoch from retained_until - now()) / 86400)::float8 as days
      from conversations where id = ${conversationId}`;
    if (!row) throw new Error("Conversation row is missing");
    return row.days;
  });
}

function titleJobStatus(conversationId: string): Promise<string | undefined> {
  return withSql(async (sql) => {
    const [row] = await sql<{ status: string }[]>`
      select status from platform_jobs
      where kind = 'conversation.generate_title' and subject = ${conversationId}`;
    return row?.status;
  });
}
