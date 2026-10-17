import { afterEach, describe, expect, it } from "vitest";
import { beforeAllWithPostgres as beforeAll } from "./support/postgres-hooks";
import { required } from "./support/assertions";
import {
  asClientInstanceId,
  asMessageId,
  type CollaborationWorkspaceId,
  type Conversation,
  type ManagedFileRecord,
  type UserId
} from "@work-shape/catalyst-core";
import { createTestInstance, type TestInstance, type TestStore } from "./support/test-instance";
import { claimAttachmentsForStoredMessage } from "./support/test-store";
import { withTestSql } from "./support/test-sql";

// Every list ordered by a timestamp ends in a unique key. Two rows written in the same instant
// share the timestamp, and without the key Postgres answers them in whatever order it meets
// them. Each test gives two rows one timestamp and writes them so that a scan meets them in
// the order opposite to their key, with index scans off for the file's database: an index
// that holds the key would otherwise put them right by chance. Only the key's place in
// ORDER BY then puts them right.

const clientInstanceId = asClientInstanceId("timestamp-order-ties");
const AT = "2026-10-17T00:00:00.000Z";

beforeAll(async () => {
  // Read by every connection opened later, which is every connection of a test's instance.
  await withTestSql(async (sql) => {
    const [row] = await sql<{ name: string }[]>`select current_database() as name`;
    const database = sql(required(row).name);
    await sql`alter database ${database} set enable_indexscan = off`;
    await sql`alter database ${database} set enable_indexonlyscan = off`;
    await sql`alter database ${database} set enable_bitmapscan = off`;
  });
});

const started: TestInstance<TestStore>[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((instance) => instance.close()));
});

async function stores(): Promise<TestStore> {
  const instance = await createTestInstance();
  started.push(instance);
  return instance.stores;
}

/**
 * Gives the rows named by `keys` the timestamp `AT` in `column` and answers the keys in the
 * order the list must show them: by `key`, in `direction`, compared by the database. The rows,
 * and those of `joined` that hold the same keys, are written last to first, so a scan meets
 * them in the opposite order.
 */
async function tie(input: {
  table: string;
  column: string;
  key: string;
  keys: readonly string[];
  direction: "asc" | "desc";
  scope?: { column: string; value: string };
  joined?: { table: string; key: string };
}): Promise<string[]> {
  return withTestSql(async (sql) => {
    const ordered = (
      await sql<{ key: string }[]>`
        select key from unnest(${input.keys}::text[]) as key
        order by key ${input.direction === "asc" ? sql`asc` : sql`desc`}`
    ).map((row) => row.key);
    for (const key of [...ordered].reverse()) {
      await sql`
        update ${sql(input.table)} set ${sql(input.column)} = ${AT}
        where ${sql(input.key)} = ${key}
          ${input.scope ? sql`and ${sql(input.scope.column)} = ${input.scope.value}` : sql``}`;
      if (input.joined) {
        const { table, key: column } = input.joined;
        await sql`update ${sql(table)} set ${sql(column)} = ${sql(column)} where ${sql(column)} = ${key}`;
      }
    }
    return ordered;
  });
}

/** The keys of `rows` that are among `keys`, in the order of `rows`. */
function among<Row>(rows: readonly Row[], keys: readonly string[], keyOf: (row: Row) => string) {
  return rows.map(keyOf).filter((key) => keys.includes(key));
}

async function user(store: TestStore, label: string): Promise<UserId> {
  return (await store.users.createUser({ clientInstanceId, displayLabel: label })).id;
}

async function sharedWorkspace(
  store: TestStore,
  creatorUserId: UserId,
  name: string
): Promise<CollaborationWorkspaceId> {
  const workspace = await store.workspaces.createWorkspace({
    clientInstanceId,
    kind: "shared",
    name,
    visibility: "discoverable",
    creatorUserId
  });
  return workspace.id;
}

describe("collaboration workspace lists", () => {
  async function twoWorkspaces(store: TestStore) {
    const owner = await user(store, "Owner");
    const ids = [
      await sharedWorkspace(store, owner, "First"),
      await sharedWorkspace(store, owner, "Second")
    ];
    const order = await tie({
      table: "collaboration_workspaces",
      column: "created_at",
      key: "id",
      keys: ids,
      direction: "asc",
      joined: { table: "collaboration_workspace_memberships", key: "collaboration_workspace_id" }
    });
    return { owner, ids, order };
  }

  it("lists a member's workspaces of one creation time by id", async () => {
    const store = await stores();
    const { owner, ids, order } = await twoWorkspaces(store);
    const listed = await store.workspaces.listWorkspacesForUser({
      clientInstanceId,
      userId: owner
    });
    expect(among(listed, ids, (workspace) => workspace.id)).toEqual(order);
  });

  it("lists discoverable workspaces of one creation time by id", async () => {
    const store = await stores();
    const { ids, order } = await twoWorkspaces(store);
    const listed = await store.workspaces.listDiscoverableWorkspaces({ clientInstanceId });
    expect(among(listed, ids, (workspace) => workspace.id)).toEqual(order);
  });

  it("lists shared workspaces of one creation time by id", async () => {
    const store = await stores();
    const { ids, order } = await twoWorkspaces(store);
    const listed = await store.workspaces.listSharedWorkspaces({ clientInstanceId });
    expect(among(listed, ids, (workspace) => workspace.id)).toEqual(order);
  });

  async function twoMembers(store: TestStore) {
    const owner = await user(store, "Owner");
    const workspaceId = await sharedWorkspace(store, owner, "Members");
    const members = [await user(store, "Ada"), await user(store, "Bo")];
    for (const userId of members) {
      await store.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: workspaceId,
        userId,
        role: "member"
      });
    }
    const order = await tie({
      table: "collaboration_workspace_memberships",
      column: "created_at",
      key: "user_id",
      keys: members,
      direction: "asc",
      scope: { column: "collaboration_workspace_id", value: workspaceId }
    });
    return { workspaceId, members, order };
  }

  it("lists memberships of one creation time by user", async () => {
    const store = await stores();
    const { workspaceId, members, order } = await twoMembers(store);
    const listed = await store.workspaces.listMemberships({
      clientInstanceId,
      collaborationWorkspaceId: workspaceId
    });
    expect(among(listed, members, (membership) => membership.userId)).toEqual(order);
  });

  it("lists the memberships of a workspace in deletion of one creation time by user", async () => {
    const store = await stores();
    const { workspaceId, members, order } = await twoMembers(store);
    await store.workspaces.markWorkspaceDeletionRequested({
      clientInstanceId,
      collaborationWorkspaceId: workspaceId
    });
    const found = await store.workspaces.getWorkspaceInDeletion({
      clientInstanceId,
      collaborationWorkspaceId: workspaceId
    });
    expect(among(found?.memberships ?? [], members, (membership) => membership.userId)).toEqual(
      order
    );
  });

  it("lists access requests of one creation time by id", async () => {
    const store = await stores();
    const owner = await user(store, "Owner");
    const workspaceId = await sharedWorkspace(store, owner, "Requests");
    const ids: string[] = [];
    for (const label of ["Ada", "Bo"]) {
      const request = await store.workspaces.createAccessRequest({
        clientInstanceId,
        collaborationWorkspaceId: workspaceId,
        userId: await user(store, label)
      });
      ids.push(request.id);
    }
    const order = await tie({
      table: "collaboration_workspace_access_requests",
      column: "created_at",
      key: "id",
      keys: ids,
      direction: "asc"
    });
    const listed = await store.workspaces.listAccessRequestsForWorkspace({
      clientInstanceId,
      collaborationWorkspaceId: workspaceId
    });
    expect(among(listed, ids, (request) => request.id)).toEqual(order);
  });
});

async function conversationOf(store: TestStore): Promise<Conversation> {
  return store.createConversationForTesting({
    clientInstanceId,
    createdByUserId: "user_ties",
    createdByExternalUserId: "ties",
    title: "Ties",
    retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
  });
}

async function managedFile(store: TestStore, name: string) {
  return store.files.createManagedFile({
    clientInstanceId,
    ownerUserId: "user_ties",
    filename: `${name}.pdf`,
    mimeType: "application/pdf",
    byteSize: 10,
    checksum: "sha256:ties",
    objectKey: `private/source/${name}.pdf`
  });
}

describe("conversation attachment lists and lookups", () => {
  async function twoAttachments(store: TestStore, fileOf: () => Promise<ManagedFileRecord>) {
    const conversation = await conversationOf(store);
    const ids: string[] = [];
    for (const name of ["first", "second"]) {
      const file = await fileOf();
      const attachment = await store.files.createConversationAttachment({
        clientInstanceId,
        conversationId: conversation.id,
        fileId: file.id,
        filename: `${name}.pdf`,
        mimeType: "application/pdf",
        byteSize: 10,
        checksum: "sha256:ties",
        status: "ready",
        format: "pdf",
        artifactRefs: {}
      });
      ids.push(attachment.id);
    }
    return { conversation, ids };
  }

  it("lists draft attachments of one creation time by id", async () => {
    const store = await stores();
    const { conversation, ids } = await twoAttachments(store, () => managedFile(store, "draft"));
    const order = await tie({
      table: "conversation_attachments",
      column: "created_at",
      key: "id",
      keys: ids,
      direction: "asc"
    });
    const listed = await store.files.listDraftAttachments({
      clientInstanceId,
      conversationId: conversation.id
    });
    expect(among(listed, ids, (attachment) => attachment.id)).toEqual(order);
  });

  it("lists sent attachments of one creation time by id, newest first", async () => {
    const store = await stores();
    const { conversation, ids } = await twoAttachments(store, () => managedFile(store, "sent"));
    await claimAttachmentsForStoredMessage(store, {
      clientInstanceId,
      conversationId: conversation.id,
      messageId: asMessageId("msg_ties"),
      claimedAt: new Date().toISOString()
    });
    const order = await tie({
      table: "conversation_attachments",
      column: "created_at",
      key: "id",
      keys: ids,
      direction: "desc"
    });
    const listed = await store.files.listSentConversationAttachments({
      clientInstanceId,
      conversationId: conversation.id
    });
    expect(among(listed, ids, (attachment) => attachment.id)).toEqual(order);
  });

  it("finds of two attachments with one checksum and creation time the one with the last id", async () => {
    const store = await stores();
    const { conversation, ids } = await twoAttachments(store, () => managedFile(store, "same"));
    const [last] = await tie({
      table: "conversation_attachments",
      column: "created_at",
      key: "id",
      keys: ids,
      direction: "desc"
    });
    const found = await store.files.findConversationAttachmentByChecksum({
      clientInstanceId,
      conversationId: conversation.id,
      checksum: "sha256:ties"
    });
    expect(found?.id).toBe(last);
  });

  async function twoOfOneFile(store: TestStore) {
    const file = await managedFile(store, "shared");
    const { conversation, ids } = await twoAttachments(store, async () => file);
    const [last] = await tie({
      table: "conversation_attachments",
      column: "updated_at",
      key: "id",
      keys: ids,
      direction: "desc"
    });
    return { conversation, fileId: file.id, last };
  }

  it("finds of two ready attachments of one file and update time the one with the last id", async () => {
    const store = await stores();
    const { conversation, fileId, last } = await twoOfOneFile(store);
    const found = await store.files.findReadyConversationAttachmentByFile({
      clientInstanceId,
      conversationId: conversation.id,
      fileId
    });
    expect(found?.id).toBe(last);
  });

  it("finds of two attachments of one file and update time the one with the last id", async () => {
    const store = await stores();
    const { conversation, fileId, last } = await twoOfOneFile(store);
    const found = await store.files.findConversationAttachmentByFile({
      clientInstanceId,
      conversationId: conversation.id,
      fileId
    });
    expect(found?.id).toBe(last);
  });
});

describe("managed artifact lists", () => {
  async function twoArtifacts(store: TestStore) {
    const conversation = await conversationOf(store);
    const file = await managedFile(store, "source");
    const ids: string[] = [];
    for (const name of ["first", "second"]) {
      const artifact = await store.files.createManagedArtifact({
        clientInstanceId,
        conversationId: conversation.id,
        sourceFileId: file.id,
        kind: "document.pages_json",
        objectKey: `private/prepared/${name}.json`,
        filename: `${name}.json`,
        mimeType: "application/json",
        byteSize: 10,
        checksum: `sha256:${name}`
      });
      ids.push(artifact.id);
    }
    const order = await tie({
      table: "managed_artifacts",
      column: "created_at",
      key: "id",
      keys: ids,
      direction: "desc"
    });
    return { conversation, fileId: file.id, ids, order };
  }

  it("lists a file's artifacts of one creation time by id, newest first", async () => {
    const store = await stores();
    const { conversation, fileId, ids, order } = await twoArtifacts(store);
    const listed = await store.files.listManagedArtifactsForFile({
      clientInstanceId,
      conversationId: conversation.id,
      fileId,
      kind: "document.pages_json"
    });
    expect(among(listed, ids, (artifact) => artifact.id)).toEqual(order);
  });

  it("lists a conversation's artifacts of one creation time by id, newest first", async () => {
    const store = await stores();
    const { conversation, ids, order } = await twoArtifacts(store);
    const listed = await store.files.listConversationManagedArtifacts({
      clientInstanceId,
      conversationId: conversation.id
    });
    expect(among(listed, ids, (artifact) => artifact.id)).toEqual(order);
  });
});

describe("conversation resource lists and lookups", () => {
  it("lists structured data of one update time by id, newest first", async () => {
    const store = await stores();
    const conversation = await conversationOf(store);
    const ids: string[] = [];
    for (const resourceKey of ["first", "second"]) {
      const resource = await store.structuredData.publishStructuredDataResource({
        clientInstanceId,
        conversationId: conversation.id,
        resourceKey,
        title: resourceKey,
        state: { title: resourceKey, sections: [] }
      });
      ids.push(resource.id);
    }
    const order = await tie({
      table: "structured_data_resources",
      column: "updated_at",
      key: "id",
      keys: ids,
      direction: "desc"
    });
    const listed = await store.structuredData.listStructuredDataResources({
      clientInstanceId,
      conversationId: conversation.id
    });
    expect(among(listed, ids, (resource) => resource.id)).toEqual(order);
  });

  it("answers of two runs started at one time the one with the last id as the latest", async () => {
    const store = await stores();
    const conversation = await conversationOf(store);
    const first = await store.createAgentRunForTesting(conversation);
    // A conversation holds one active run: the first ends before the second starts.
    await withTestSql(
      (sql) => sql`update agent_runs set status = 'completed' where id = ${first.id}`
    );
    const second = await store.createAgentRunForTesting(conversation);
    const [latest] = await tie({
      table: "agent_runs",
      column: "started_at",
      key: "id",
      keys: [first.id, second.id],
      direction: "desc"
    });
    const found = await store.agentRuns.getLatestConversationAgentRun({
      clientInstanceId,
      conversationId: conversation.id
    });
    expect(found?.id).toBe(latest);
  });
});
