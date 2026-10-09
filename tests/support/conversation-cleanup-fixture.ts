import { expect } from "vitest";
import { ConversationRetentionWorkflow } from "@vivd-catalyst/chat-server";
import {
  asUserId,
  type AuthenticatedUser,
  type CollaborationWorkspace,
  type Conversation,
  type Logger,
  type UserRole
} from "@vivd-catalyst/core";
import type { PostgresSuite } from "./postgres-suite";
import {
  RecordingByteStore,
  createAttachedObjects,
  createExecutionWorkspaceData,
  createManagedObjectAttachmentService,
  createRetentionOptions,
  createTestManagedObjectAccess
} from "./retention-harness";
import { createTestInstance } from "./test-instance";

/**
 * One client instance on the test database with a recording byte store, the server options of
 * the retention and deletion workflows, and what the cleanup tests arrange and read.
 */
export async function createConversationCleanupFixture(db: PostgresSuite, label: string) {
  const { store, sql } = db;
  const clientInstanceId = db.clientInstance(label);
  const scope = { clientInstanceId };
  const byteStore = new RecordingByteStore();
  const managedObjects = createTestManagedObjectAccess({
    clientInstanceId,
    files: store.files,
    byteStore
  });
  const users = new Map<string, AuthenticatedUser>();
  const options = createRetentionOptions({
    clientInstanceId,
    store,
    attachments: createManagedObjectAttachmentService({ managedObjects }),
    workspaceObjects: byteStore,
    authenticate(userId) {
      const user = userId ? users.get(userId) : undefined;
      if (!user) {
        throw new Error("The request names no known test user");
      }
      return { ...user, scopes: ["*"] };
    }
  });

  const createUser = async (name: string, roles: UserRole[] = ["user"]) => {
    const user = await store.users.resolveUserIdentity({
      clientInstanceId,
      authSource: "development",
      externalUserId: name,
      displayLabel: name,
      roles,
      permissionRefs: [],
      permissions: [],
      correlationId: `corr_${name}`
    });
    users.set(user.id, user);
    return user;
  };
  const createSharedWorkspace = (owner: AuthenticatedUser, name: string) =>
    store.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name,
      visibility: "discoverable",
      creatorUserId: asUserId(owner.id)
    });
  const personalWorkspaceOf = (user: AuthenticatedUser) =>
    store.workspaces.ensurePersonalWorkspace({ clientInstanceId, userId: asUserId(user.id) });
  /**
   * A Conversation with a message, in the personal workspace of its author unless a workspace
   * is named.
   */
  const createConversation = async (
    author: AuthenticatedUser,
    title: string,
    input: {
      retainedUntil?: string;
      withMessage?: boolean;
      workspace?: CollaborationWorkspace;
    } = {}
  ) => {
    const workspace = input.workspace ?? (await personalWorkspaceOf(author));
    const conversation = await store.conversations.createConversation({
      visibility: "workspace",
      clientInstanceId,
      collaborationWorkspaceId: workspace.id,
      createdByUserId: author.id,
      createdByExternalUserId: author.externalUserId,
      title,
      retainedUntil: input.retainedUntil ?? "2999-01-01T00:00:00.000Z"
    });
    if (input.withMessage ?? true) {
      await store.conversations.appendMessage({
        ...scope,
        conversationId: conversation.id,
        role: "user",
        text: `message for ${title}`
      });
    }
    return conversation;
  };
  /** A file with its bytes, an artifact with its bytes and an attachment. */
  const createObjects = (conversation: Conversation) =>
    createAttachedObjects({ store: store.files, managedObjects, clientInstanceId, conversation });
  /** The same, with a preview job for the artifact. */
  const createData = async (conversation: Conversation) => {
    const objects = await createObjects(conversation);
    await store.files.enqueueArtifactPreviewJob({
      ...scope,
      conversationId: conversation.id,
      sourceArtifactId: objects.artifact.id,
      sourceChecksum: objects.artifact.checksum,
      sourceMimeType: objects.artifact.mimeType
    });
    return objects;
  };
  const createWorkspaceData = (conversation: Conversation) =>
    createExecutionWorkspaceData({ store, byteStore, clientInstanceId, conversation });
  /** What is left in the database of a workspace and the Conversations in it. */
  const rowsOf = async (workspace: CollaborationWorkspace) => {
    const [row] = await sql<
      Array<{
        workspaces: number;
        conversations: number;
        artifacts: number;
        executionWorkspaces: number;
      }>
    >`
        select
          (select count(*)::int from collaboration_workspaces where id = ${workspace.id})
            as workspaces,
          (select count(*)::int from conversations
            where collaboration_workspace_id = ${workspace.id}) as conversations,
          (select count(*)::int from managed_artifacts ma
            join conversations c on c.id = ma.conversation_id
            where c.collaboration_workspace_id = ${workspace.id}) as artifacts,
          (select count(*)::int from execution_workspaces ew
            join conversations c on c.id = ew.conversation_id
            where c.collaboration_workspace_id = ${workspace.id}) as "executionWorkspaces"
      `;
    return row;
  };
  const eventsOfType = async (type: string) =>
    (await store.audit.listAuditEvents({ ...scope, limit: 200 })).filter(
      (event) => event.type === type
    );
  type Data = Awaited<ReturnType<typeof createData>>;
  /** Read from the row: a Conversation of a deleted user is no longer readable in the store. */
  const statusOf = async (conversation: Conversation) => {
    const [row] = await sql<Array<{ status: string }>>`
        select status from conversations where id = ${conversation.id}
      `;
    return row?.status;
  };
  const pending = () => store.files.listConversationsPendingObjectCleanup({ ...scope, limit: 10 });
  const previewJobCount = async (conversation: Conversation) => {
    const [row] = await sql<Array<{ count: number }>>`
        select count(*)::int as count from artifact_preview_jobs
        where conversation_id = ${conversation.id}
      `;
    return row?.count;
  };
  const auditEvents = async (type: string, conversation: Conversation) =>
    (await store.audit.listAuditEvents({ ...scope, limit: 100 })).filter(
      (event) => event.type === type && event.subject === conversation.id
    );
  /** The Conversation is gone, and everything that was stored for it is still there. */
  const expectDataLeft = async (conversation: Conversation, data: Data) => {
    expect(byteStore.has(data.file.objectKey)).toBe(true);
    expect(byteStore.has(data.artifact.objectKey)).toBe(true);
    await expect(
      store.files.getManagedFile({ ...scope, fileId: data.file.id })
    ).resolves.toMatchObject({
      status: "available"
    });
    await expect(
      store.files.getManagedArtifact({ ...scope, artifactId: data.artifact.id })
    ).resolves.toMatchObject({ status: "available" });
    await expect(previewJobCount(conversation)).resolves.toBe(1);
  };
  const expectDataRemoved = async (conversation: Conversation, data: Data) => {
    expect(byteStore.has(data.file.objectKey)).toBe(false);
    expect(byteStore.has(data.artifact.objectKey)).toBe(false);
    await expect(
      store.files.getManagedFile({ ...scope, fileId: data.file.id })
    ).resolves.toBeUndefined();
    await expect(
      store.files.getManagedArtifact({ ...scope, artifactId: data.artifact.id })
    ).resolves.toBeUndefined();
    await expect(previewJobCount(conversation)).resolves.toBe(0);
  };
  /** One pass of the retention job: expiry, cleanup retry, orphaned files. */
  const runRetentionJob = async () => {
    const logged: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn() {},
      error(_input, message) {
        logged.push(message ?? "");
      },
      child: () => logger
    };
    // A failed step is logged and fails the run; the tests read the log.
    await new ConversationRetentionWorkflow(options).run(logger).catch(() => undefined);
    return logged;
  };

  return {
    clientInstanceId,
    scope,
    byteStore,
    options,
    /** A server on the fixture's options. It closes with the test. */
    api: () => createTestInstance({ server: options }),
    createUser,
    createSharedWorkspace,
    personalWorkspaceOf,
    createConversation,
    createObjects,
    createData,
    createWorkspaceData,
    rowsOf,
    eventsOfType,
    statusOf,
    pending,
    auditEvents,
    expectDataLeft,
    expectDataRemoved,
    runRetentionJob
  };
}
