import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createJobWorker } from "@work-shape/catalyst-client-assembly";
import {
  KNOWLEDGE_BASE_ACTIONS,
  KnowledgeExtractionError,
  asConversationId,
  asUserId,
  defineKnowledgeExtractHandler,
  type AuthenticatedUser,
  type KnowledgeExtractor,
  type Logger
} from "@work-shape/catalyst-core";
import { createFilesystemObjectStorage } from "@work-shape/catalyst-object-storage";
import { createManagedObjectTestAttachmentCapability } from "./support/chat-server-attachment-harness";
import { eventually, required } from "./support/assertions";
import { clientInstanceId, type DataStoreInstance } from "./support/data-store-instance";
import {
  FILE_NAME,
  FILE_TEXT,
  KB,
  addedSchema,
  asMember,
  developmentAuth,
  useKnowledgeFiles
} from "./support/knowledge-files";
import { getTestJobs } from "./support/test-instance";

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
