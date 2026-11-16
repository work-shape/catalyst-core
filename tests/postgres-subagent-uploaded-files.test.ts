import { describe, expect, it } from "vitest";
import {
  asManagedFileId,
  createPlatformId,
  createUserMessageMetadata,
  type AttachmentManifestEntry,
  type Conversation,
  readUserMessageMetadata,
  type JsonObject
} from "@work-shape/catalyst-core";
import { usePostgresSuite } from "./support/postgres-suite";
import { createSubagentFixture } from "./support/subagent-runs";

// Check 169 of events-workflows-and-guardrails.md (CR-1, files): uploaded files reach a
// subagent by name. Its first message carries its root's attachment manifest, and every tool
// that takes a conversation file looks a run thread's file up in its root conversation.

describe("Postgres uploaded files of a subagent's root conversation", () => {
  const db = usePostgresSuite("subagent_files");

  /** Sends a message with these PDFs in the conversation, as a person's upload does. */
  async function attach(
    fixture: Awaited<ReturnType<typeof createSubagentFixture>>,
    conversation: Conversation,
    names: string[]
  ) {
    const entries: AttachmentManifestEntry[] = [];
    for (const name of names) {
      const file = await db.store.files.createManagedFile({
        ...fixture.scope,
        ownerUserId: fixture.user.id,
        filename: name,
        mimeType: "application/pdf",
        byteSize: 10,
        checksum: `sha256:${name}`,
        objectKey: `private/source/${name}`
      });
      const attachment = await db.store.files.createConversationAttachment({
        ...fixture.scope,
        conversationId: conversation.id,
        fileId: file.id,
        filename: name,
        mimeType: "application/pdf",
        byteSize: 10,
        checksum: `sha256:${name}`,
        status: "ready",
        format: "pdf",
        artifactRefs: {}
      });
      entries.push({
        kind: "document",
        fileId: file.id,
        attachmentId: attachment.id,
        filename: name,
        mimeType: "application/pdf",
        byteSize: 10,
        status: "ready",
        readable: true,
        modelContext: {
          section: "Attached files",
          text: `- ${name} (fileId: ${file.id}, size: 10 bytes, pages: 2)`
        }
      });
    }
    const messageId = createPlatformId<"MessageId">("msg");
    await db.store.conversations.appendMessage({
      ...fixture.scope,
      id: messageId,
      conversationId: conversation.id,
      role: "user",
      text: "Here are the contracts",
      metadata: createUserMessageMetadata({
        attachmentManifest: { version: 1, attachments: entries }
      })
    });
    await db.store.files.claimReadyDraftAttachmentsForMessage({
      ...fixture.scope,
      conversationId: conversation.id,
      messageId,
      claimedAt: new Date().toISOString()
    });
    return entries;
  }

  /** The manifest of a thread's first message, the child's input, as it was stored. */
  async function inputManifest(conversationId: string) {
    const [row] = await db.sql<Array<{ metadata: JsonObject }>>`
      select metadata from messages where conversation_id = ${conversationId}
      order by created_at, id limit 1`;
    return readUserMessageMetadata(row?.metadata)?.attachmentManifest;
  }

  it("lists the root's files in the child's input and finds them from its thread (check 169)", async () => {
    const fixture = await createSubagentFixture(db, "check_169");
    const root = await fixture.createConversation("three contracts");
    const files = await attach(fixture, root, ["lease.pdf", "deed.pdf", "survey.pdf"]);
    const other = await fixture.createConversation("another chat");
    const [foreign] = await attach(fixture, other, ["foreign.pdf"]);
    const parent = await fixture.startParent(root);
    const child = await fixture.startChild(parent.run, "compare lease.pdf and deed.pdf");

    // Its input lists all three files, as the parent reads them.
    expect(await inputManifest(child.threadId)).toEqual({ version: 1, attachments: files });

    // The child names two by file name and finds their ids in its input; `read_document`,
    // `view_document_page` and `document.extract_structured` look them up as ready files,
    // `workspace.import_files` as any file of the conversation.
    for (const name of ["lease.pdf", "deed.pdf"]) {
      const entry = files.find((attachment) => attachment.filename === name);
      if (!entry) throw new Error(`${name} is not in the child's input`);
      const lookup = { ...fixture.scope, conversationId: child.threadId, fileId: entry.fileId };
      await expect(
        db.store.files.findReadyConversationAttachmentByFile(lookup)
      ).resolves.toMatchObject({ conversationId: root.id, fileId: entry.fileId, filename: name });
      await expect(db.store.files.findConversationAttachmentByFile(lookup)).resolves.toMatchObject({
        conversationId: root.id,
        fileId: entry.fileId
      });
    }

    // A file of another conversation answers not found.
    const elsewhere = {
      ...fixture.scope,
      conversationId: child.threadId,
      fileId: asManagedFileId(foreign?.fileId ?? "")
    };
    await expect(
      db.store.files.findReadyConversationAttachmentByFile(elsewhere)
    ).resolves.toBeUndefined();
    await expect(
      db.store.files.findConversationAttachmentByFile(elsewhere)
    ).resolves.toBeUndefined();
  });

  it("gives a child of a conversation without files no manifest", async () => {
    const fixture = await createSubagentFixture(db, "no_files");
    const root = await fixture.createConversation("no files");
    const parent = await fixture.startParent(root);
    const child = await fixture.startChild(parent.run, "look something up");

    expect(await inputManifest(child.threadId)).toBeUndefined();
  });

  it("leaves a deleted file out of the child's input", async () => {
    const fixture = await createSubagentFixture(db, "deleted_file");
    const root = await fixture.createConversation("two files");
    const [kept, deleted] = await attach(fixture, root, ["kept.pdf", "deleted.pdf"]);
    await db.sql`
      update conversation_attachments set status = 'deleted'
      where id = ${deleted?.attachmentId ?? ""}`;
    const parent = await fixture.startParent(root);
    const child = await fixture.startChild(parent.run, "read the kept file");

    expect(await inputManifest(child.threadId)).toEqual({ version: 1, attachments: [kept] });
  });
});
