import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_BASE_ASSET_KIND,
  asConversationId,
  asUserId,
  KnowledgeExtractionError,
  defineKnowledgeExtractHandler,
  type AuthenticatedUser,
  type KnowledgeExtractor,
  type Logger
} from "@work-shape/catalyst-core";
import { eventually, required } from "./support/assertions";
import { clientInstanceId, type DataStoreInstance } from "./support/data-store-instance";
import {
  FILE_NAME,
  FILE_TEXT,
  KB,
  addedSchema,
  asMember,
  useKnowledgeFiles,
  developmentAuth
} from "./support/knowledge-files";
import { getTestJobs } from "./support/test-instance";
import { createJobWorker } from "@work-shape/catalyst-client-assembly";
import { createFilesystemObjectStorage } from "@work-shape/catalyst-object-storage";
import { createManagedObjectTestAttachmentCapability } from "./support/chat-server-attachment-harness";

// `knowledge_bases.open_document`: who may open a cited original. A reader with a right of
// their own opens it anywhere; a member opens it only through a conversation they can open in
// a workspace the Knowledge Base is available to. Spec: data-stores-and-knowledge-bases.md, E6.

describe("opening a cited Knowledge Base document", () => {
  const { instanceWithFiles, assetId, conversationWithFile, addFiles } = useKnowledgeFiles();

  it("E6 opens a cited original only for a Knowledge Base user and refuses removed or mismatched documents", async () => {
    const { instance } = await instanceWithFiles();
    const source = await conversationWithFile(instance, {
      filename: FILE_NAME,
      contentType: "text/plain",
      content: FILE_TEXT
    });
    const added = await addFiles(instance, [source]);
    const documentId = required(addedSchema.parse(added.json()).documents[0]).id;
    await eventually(async () => {
      await getTestJobs(instance.api).runDue();
      const opened = await instance.api.call("knowledge_bases.open_document", {
        params: { knowledgeBase: KB, documentId }
      });
      expect(opened.statusCode, opened.body).toBe(200);
      expect(opened.body).toBe(FILE_TEXT);
      expect(opened.headers["content-disposition"]).toMatch(/^inline;/);
      expect(opened.headers["x-content-type-options"]).toBe("nosniff");
      expect(opened.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(opened.headers["cache-control"]).toBe("private, no-store");
    });
    const denied = await instance.api.call("knowledge_bases.open_document", {
      params: { knowledgeBase: KB, documentId },
      headers: asMember
    });
    expect(denied.statusCode).toBe(403);
    const memberRead = await instance.api.call("conversations.create", {
      payload: { title: "Source reader" },
      headers: asMember
    });
    expect(memberRead.statusCode).toBe(200);
    const memberConversationId = z.object({ id: z.string() }).parse(memberRead.json()).id;
    const memberConversation = required(
      await instance.stores.conversations.getConversation(
        clientInstanceId,
        asConversationId(memberConversationId)
      )
    );
    const granted = await instance.api.call("permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: memberConversation.createdByUserId,
        action: KNOWLEDGE_BASE_ACTIONS.use,
        scopeKind: "asset",
        scopeId: await assetId(instance)
      }
    });
    expect(granted.statusCode, granted.body).toBe(200);
    const permitted = await instance.api.call("knowledge_bases.open_document", {
      params: { knowledgeBase: KB, documentId },
      headers: asMember
    });
    expect(permitted.statusCode, permitted.body).toBe(200);
    expect(permitted.body).toBe(FILE_TEXT);
    // A direct grant needs no conversation, and its revocation ends it.
    const grantId = z.object({ id: z.string() }).parse(granted.json()).id;
    const revoked = await instance.api.call("permissions.revoke", { params: { grantId } });
    expect(revoked.statusCode, revoked.body).toBe(200);
    const afterRevoke = await instance.api.call("knowledge_bases.open_document", {
      params: { knowledgeBase: KB, documentId },
      headers: asMember
    });
    expect(afterRevoke.statusCode).toBe(403);
    const wrong = await instance.api.call("knowledge_bases.open_document", {
      params: { knowledgeBase: "another-base", documentId }
    });
    expect(wrong.statusCode).toBe(404);
    const removed = await instance.api.call("knowledge_bases.remove_documents", {
      params: { knowledgeBase: KB },
      payload: { documentIds: [documentId] }
    });
    expect(removed.statusCode, removed.body).toBe(200);
    const gone = await instance.api.call("knowledge_bases.open_document", {
      params: { knowledgeBase: KB, documentId }
    });
    expect(gone.statusCode).toBe(404);
  });

  it("E6 opens a cited original for a member through the citing conversation's workspace availability only", async () => {
    const { instance } = await instanceWithFiles();
    const source = await conversationWithFile(instance, {
      filename: FILE_NAME,
      contentType: "text/plain",
      content: FILE_TEXT
    });
    const added = await addFiles(instance, [source]);
    const documentId = required(addedSchema.parse(added.json()).documents[0]).id;
    await eventually(async () => {
      await getTestJobs(instance.api).runDue();
      const opened = await instance.api.call("knowledge_bases.open_document", {
        params: { knowledgeBase: KB, documentId }
      });
      expect(opened.statusCode, opened.body).toBe(200);
    });
    const idOf = (headers: Record<string, string>) =>
      instance.api
        .call("me.get", { headers })
        .then((me) => z.object({ id: z.string() }).parse(me.json()).id);
    const memberId = await idOf(asMember);
    const adminId = await idOf({});
    const workspace = async (name: string, member: boolean) => {
      const made = await instance.stores.workspaces.createWorkspace({
        clientInstanceId,
        name,
        kind: "shared",
        creatorUserId: asUserId(adminId)
      });
      if (member) {
        await instance.stores.workspaces.addMembership({
          clientInstanceId,
          collaborationWorkspaceId: made.id,
          userId: asUserId(memberId),
          role: "member"
        });
      }
      return made.id;
    };
    const nordlicht = await workspace("Nordlicht", true);
    const other = await workspace("Other team", true);
    const foreign = await workspace("Foreign team", false);
    const conversationIn = async (workspaceId: string, headers: Record<string, string>) => {
      const created = await instance.api.call("conversations.create", {
        payload: { title: "Citations", collaborationWorkspaceId: workspaceId },
        headers
      });
      expect(created.statusCode, created.body).toBe(200);
      return z.object({ id: z.string() }).parse(created.json()).id;
    };
    const available = await instance.api.call("assets.set_availability", {
      params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
      payload: { mode: "selected", collaborationWorkspaceIds: [nordlicht] }
    });
    expect(available.statusCode, available.body).toBe(200);
    const open = (conversationId?: string) =>
      instance.api
        .call("knowledge_bases.open_document", {
          params: { knowledgeBase: KB, documentId },
          ...(conversationId === undefined ? {} : { query: { conversationId } }),
          headers: asMember
        })
        .then((answer) => answer.statusCode);
    const cited = await conversationIn(nordlicht, asMember);
    // Availability alone grants nothing outside the citing conversation's workspace.
    expect(await open()).toBe(403);
    expect(await open(cited)).toBe(200);
    expect(await open(await conversationIn(other, asMember))).toBe(403);
    // A workspace conversation of another person lends its workspace; once private, a foreign
    // workspace's conversation and one that does not exist lend nothing.
    expect(await open(await conversationIn(nordlicht, {}))).toBe(200);
    const shared = await conversationIn(other, {});
    const hidden = await instance.api.call("conversations.move", {
      params: { conversationId: shared },
      payload: { collaborationWorkspaceId: nordlicht, visibility: "private" }
    });
    expect(hidden.statusCode, hidden.body).toBe(200);
    expect(await open(shared)).toBe(404);
    expect(await open(await conversationIn(foreign, {}))).toBe(404);
    expect(await open("conv_missing")).toBe(404);
    const denied = await instance.api.call("permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: memberId,
        action: KNOWLEDGE_BASE_ACTIONS.use,
        scopeKind: "asset",
        scopeId: await assetId(instance),
        effect: "deny"
      }
    });
    expect(denied.statusCode, denied.body).toBe(200);
    expect(await open(cited)).toBe(403);
    const deniedId = z.object({ id: z.string() }).parse(denied.json()).id;
    const lifted = await instance.api.call("permissions.revoke", { params: { grantId: deniedId } });
    expect(lifted.statusCode, lifted.body).toBe(200);
    expect(await open(cited)).toBe(200);
    const withdrawn = await instance.api.call("assets.set_availability", {
      params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
      payload: { mode: "selected", collaborationWorkspaceIds: [other] }
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect(await open(cited)).toBe(403);
  });
});

// KB-7c, Data Stores And Knowledge Bases check 10: the document tools read a search hit's file
// id. What the platform hands them finds the document only where the person may use its
// Knowledge Base in the workspace of the conversation the agent answers in, and reads its text
// as the index read it. Every refusal reads as a file that is not there.

const idSchema = z.object({ id: z.string() });
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent
};

/** Reads the test's own "PDF": the text after the marker, one page per form feed. */
const fakeExtractor: KnowledgeExtractor = {
  revision: 1,
  extract({ bytes }) {
    const text = new TextDecoder().decode(bytes);
    if (!text.startsWith("%FAKE-PDF\n")) {
      return Promise.reject(new KnowledgeExtractionError("knowledge_file_unreadable", "No PDF"));
    }
    return Promise.resolve({
      pages: text
        .slice("%FAKE-PDF\n".length)
        .split("\f")
        .map((page, index) => ({ page: index + 1, text: page }))
    });
  }
};

async function userOf(instance: DataStoreInstance, headers: Record<string, string>) {
  const me = await instance.api.call("me.get", { headers });
  const userId = asUserId(idSchema.parse(me.json()).id);
  const user = required(await instance.stores.users.getUser({ clientInstanceId, userId }));
  const identity: AuthenticatedUser = {
    id: user.id,
    externalUserId: user.id,
    displayLabel: user.displayLabel,
    roles: user.roles,
    permissions: user.permissions,
    permissionRefs: user.permissionRefs,
    clientInstanceId,
    authSource: "test",
    scopes: ["*"]
  };
  return identity;
}

async function conversationOf(instance: DataStoreInstance, headers: Record<string, string>) {
  const created = await instance.api.call("conversations.create", {
    payload: { title: "Answers" },
    headers
  });
  expect(created.statusCode, created.body).toBe(200);
  return asConversationId(idSchema.parse(created.json()).id);
}

describe("a Knowledge Base document on a search hit's file id", () => {
  const { start, published, instanceWithFiles, assetId, conversationWithFile, addFiles } =
    useKnowledgeFiles();

  it("is read by a person who may use the Knowledge Base, with the text the index read", async () => {
    const { instance, attachments } = await instanceWithFiles();
    const source = await conversationWithFile(instance, {
      filename: FILE_NAME,
      contentType: "text/plain",
      content: FILE_TEXT
    });
    const added = await addFiles(instance, [source]);
    const { id: documentId, fileId } = required(addedSchema.parse(added.json()).documents[0]);
    const hits = attachments.knowledgeDocuments();
    const admin = await userOf(instance, {});
    const answering = await conversationOf(instance, {});
    const document = await eventually(async () => {
      await getTestJobs(instance.api).runDue();
      return required(await hits.open({ user: admin, conversationId: answering, fileId }));
    });
    expect(document).toMatchObject({
      fileId,
      filename: FILE_NAME,
      knowledgeBase: KB,
      format: "txt",
      original: "available"
    });
    expect(await document.pages()).toEqual([{ page: 1, text: FILE_TEXT }]);
    // A page view reads a document added by hand from the copy its file id names (KB-14).
    expect(await document.openOriginal({ correlationId: "corr_view" })).toEqual({ kind: "copy" });

    // The file of the conversation it was added from is no Knowledge Base's.
    expect(
      await hits.open({ user: admin, conversationId: answering, fileId: source.fileId })
    ).toBeUndefined();
    expect(
      await hits.open({ user: admin, conversationId: answering, fileId: "file_missing" })
    ).toBeUndefined();

    // A member without the right reads nothing; with it, through their own conversation only.
    const member = await userOf(instance, asMember);
    const theirs = await conversationOf(instance, asMember);
    expect(await hits.open({ user: member, conversationId: theirs, fileId })).toBeUndefined();
    const granted = await instance.api.call("permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: member.id,
        action: KNOWLEDGE_BASE_ACTIONS.use,
        scopeKind: "asset",
        scopeId: await assetId(instance)
      }
    });
    expect(granted.statusCode, granted.body).toBe(200);
    expect(await hits.open({ user: member, conversationId: theirs, fileId })).toBeDefined();
    expect(await hits.open({ user: member, conversationId: answering, fileId })).toBeUndefined();

    // A removed document is no longer there.
    const removed = await instance.api.call("knowledge_bases.remove_documents", {
      params: { knowledgeBase: KB },
      payload: { documentIds: [documentId] }
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(await hits.open({ user: admin, conversationId: answering, fileId })).toBeUndefined();
  });

  it("reads an extracted PDF's pages as the extraction stored them", async () => {
    const attachments = createManagedObjectTestAttachmentCapability();
    const instance = await start(true, undefined, developmentAuth, undefined, {
      attachments: attachments.capability,
      documents: true
    });
    await published(instance);
    const extractWorker = createJobWorker({
      stores: instance.stores,
      clientInstanceId,
      logger: silent,
      handlers: [
        defineKnowledgeExtractHandler({
          clientInstanceId,
          objects: createFilesystemObjectStorage(instance.filesRoot),
          extractor: fakeExtractor,
          maxPages: 500,
          slots: 1
        })
      ]
    });
    const source = await conversationWithFile(instance, {
      filename: "Expose.pdf",
      contentType: "application/pdf",
      content: "%FAKE-PDF\nLage und Umgebung\fGrundriss Erdgeschoss"
    });
    const added = await addFiles(instance, [source]);
    const { fileId } = required(addedSchema.parse(added.json()).documents[0]);
    const admin = await userOf(instance, {});
    const answering = await conversationOf(instance, {});
    const document = await eventually(async () => {
      await getTestJobs(instance.api).runDue();
      await extractWorker.runDue();
      await getTestJobs(instance.api).runDue();
      return required(
        await attachments
          .knowledgeDocuments()
          .open({ user: admin, conversationId: answering, fileId })
      );
    });
    await extractWorker.stop();
    expect(document).toMatchObject({ format: "pdf", pageCount: 2, original: "available" });
    expect(await document.pages()).toEqual([
      { page: 1, text: "Lage und Umgebung" },
      { page: 2, text: "Grundriss Erdgeschoss" }
    ]);
  });
});
