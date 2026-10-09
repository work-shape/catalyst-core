import { createTestInstance } from "./support/test-instance";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  StoreBackedAuditRecorder,
  asConversationId,
  asClientInstanceId,
  asManagedFileId
} from "@vivd-catalyst/core";

import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import {
  createTestConfig,
  createTestUser,
  personalConversationListInput
} from "./support/fixtures";
import {
  createMissingRuntime,
  createUnusedModelProvider,
  injectStartConversationRun,
  drainRunEvents
} from "./support/chat-server-run-harness";
import {
  createMultipartFilePayload,
  createManagedObjectTestAttachmentCapability,
  createTestAttachmentCapability,
  waitForReadyDraftAttachment
} from "./support/chat-server-attachment-harness";

describe("client instance app vertical slice", () => {
  it("generates a short conversation headline from the first user message", async () => {
    const app = await createTestInstance({
      config: createTestConfig(),
      env: {},
      capabilities: [createTestAttachmentCapability()],
      tools: []
    });
    const firstMessage = "Please summarize the release notes";
    const created = await app.call("createConversation", { payload: { title: firstMessage } });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    const sent = await injectStartConversationRun(app, conversation.id, firstMessage, {
      idempotencyKey: "title-generation-run"
    });
    await drainRunEvents(app, conversation.id, sent.run.id);

    const generatedTitle = await app.call("generateConversationTitle", {
      params: { conversationId: conversation.id }
    });
    expect(generatedTitle.statusCode).toBe(200);
    expect(generatedTitle.json()).toMatchObject({
      id: conversation.id,
      title: "Please Summarize The Release Notes"
    });

    const listed = await app.call("listConversations", await personalConversationListInput(app));
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toContainEqual(
      expect.objectContaining({
        id: conversation.id,
        title: "Please Summarize The Release Notes"
      })
    );

    const audit = await app.call("listAuditEvents", {});
    expect(audit.statusCode).toBe(200);
    expect(
      (audit.json() as Array<{ type: string }>).some(
        (event) => event.type === "conversation.title_generated"
      )
    ).toBe(true);

    await app.close();
  });

  it("lets a user rename an owned conversation", async () => {
    const app = await createTestInstance({
      config: createTestConfig(),
      env: {},
      tools: []
    });
    const created = await app.call("createConversation", { payload: { title: "Temporary title" } });
    const conversation = created.json() as { id: string };

    const renamed = await app.call("renameConversation", {
      params: { conversationId: conversation.id },
      payload: { title: "  Lars Schmitt – Finanzierung  " }
    });

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({
      id: conversation.id,
      title: "Lars Schmitt – Finanzierung"
    });

    const invalid = await app.call("renameConversation", {
      params: { conversationId: conversation.id },
      payload: { title: "   " }
    });
    expect(invalid.statusCode).toBe(422);

    const audit = await app.call("listAuditEvents", {});
    expect(audit.json()).toContainEqual(
      expect.objectContaining({
        type: "conversation.renamed",
        subject: conversation.id,
        metadata: {
          previousTitleLength: "Temporary title".length,
          titleLength: "Lars Schmitt – Finanzierung".length
        }
      })
    );

    await app.close();
  });

  it("replaces a file-drop placeholder title from the first user message", async () => {
    const app = await createTestInstance({
      config: createTestConfig(),
      env: {},
      capabilities: [createTestAttachmentCapability()],
      tools: []
    });
    const filenameTitle = "Theo - Boardingpass - Y123.txt";
    const created = await app.call("createConversation", { payload: { title: filenameTitle } });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    const upload = createMultipartFilePayload({
      fieldName: "file",
      filename: filenameTitle,
      contentType: "text/plain",
      content: "Boarding pass fixture"
    });
    expect(
      (
        await app.call("uploadDraftAttachment", {
          params: { conversationId: conversation.id },
          headers: upload.headers,
          payload: upload.payload
        })
      ).statusCode
    ).toBe(200);
    await waitForReadyDraftAttachment(app, conversation.id);

    const sent = await injectStartConversationRun(
      app,
      conversation.id,
      "Please summarize this boarding pass",
      {
        idempotencyKey: "attachment-title-generation-run"
      }
    );
    await drainRunEvents(app, conversation.id, sent.run.id);

    const listed = await app.call("listConversations", await personalConversationListInput(app));
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toContainEqual(
      expect.objectContaining({
        id: conversation.id,
        title: "Please Summarize This Boarding Pass"
      })
    );

    await app.close();
  });

  it("serves authenticated inline content for ready image attachments", async () => {
    const app = await createTestInstance({
      config: createTestConfig(),
      env: {},
      capabilities: [createTestAttachmentCapability()],
      tools: []
    });
    const created = await app.call("createConversation", { payload: { title: "Image upload" } });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };
    const upload = createMultipartFilePayload({
      fieldName: "file",
      filename: "receipt.gif",
      contentType: "image/gif",
      content: "GIF89a"
    });

    const uploaded = await app.call("uploadDraftAttachment", {
      params: { conversationId: conversation.id },
      headers: upload.headers,
      payload: upload.payload
    });
    expect(uploaded.statusCode).toBe(200);
    const body = uploaded.json() as {
      attachment: { fileId: string; status: string; format: string };
    };
    expect(body.attachment).toMatchObject({
      status: "ready",
      format: "gif"
    });

    const content = await app.call("getConversationFileContent", {
      params: { conversationId: conversation.id, fileId: body.attachment.fileId }
    });

    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toContain("image/gif");
    expect(content.payload).toBe("GIF89a");

    await app.close();
  });

  it("serves promoted managed artifacts as conversation-scoped downloads", async () => {
    const clientInstanceId = asClientInstanceId("demo-local");
    const store = createTestInstance().stores;
    const config = createTestConfig();
    const owner = createTestUser("user-1", clientInstanceId);
    const usageGovernance = new ModelUsageGovernance({
      store,
      budget: config.usage.budget,
      safeguards: config.usage.safeguards,
      costs: config.usage.costs
    });
    const readArtifacts: Array<{ clientInstanceId: string; artifactId: string }> = [];
    const server = await createTestInstance({
      server: {
        config,
        clientInstanceId,
        authAdapter: {
          credentialMode: "ambient",
          id: "test-auth",
          async authenticate() {
            return owner;
          }
        },
        conversationStore: store,
        auditEventStore: store,
        userStore: store,
        usageGovernance,
        auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store }),
        agentRuntime: createMissingRuntime(),
        modelProvider: createUnusedModelProvider(),
        managedObjects: {
          async readArtifact(input) {
            readArtifacts.push(input);
            return {
              bytes: new TextEncoder().encode("final,report\n"),
              mimeType: "text/csv"
            };
          }
        }
      }
    });
    try {
      const conversation = await store.createConversationForTesting({
        clientInstanceId,
        createdByUserId: owner.id,
        createdByExternalUserId: owner.externalUserId,
        title: "Artifact download",
        retainedUntil: "2030-01-01T00:00:00.000Z"
      });
      const otherConversation = await store.createConversationForTesting({
        clientInstanceId,
        createdByUserId: owner.id,
        createdByExternalUserId: owner.externalUserId,
        title: "Other conversation",
        retainedUntil: "2030-01-01T00:00:00.000Z"
      });
      const artifact = await store.createManagedArtifact({
        clientInstanceId,
        conversationId: conversation.id,
        kind: "document.csv",
        objectKey: "execution-workspaces/private/final.csv",
        filename: "final \u00e4.csv",
        mimeType: "text/csv",
        byteSize: 13,
        checksum: "sha256:final",
        metadata: {
          source: "execution_workspace"
        }
      });

      const content = await server.call("getConversationArtifactContent", {
        params: { conversationId: conversation.id, artifactId: artifact.id }
      });

      expect(content.statusCode).toBe(200);
      expect(content.headers["content-type"]).toContain("text/csv");
      expect(content.headers["content-disposition"]).toBe(
        "attachment; filename=\"final _.csv\"; filename*=UTF-8''final%20%C3%A4.csv"
      );
      expect(content.payload).toBe("final,report\n");
      expect(JSON.stringify(content.headers)).not.toContain("execution-workspaces/private");
      expect(readArtifacts).toEqual([
        {
          clientInstanceId,
          artifactId: artifact.id
        }
      ]);

      const wrongConversation = await server.call("getConversationArtifactContent", {
        params: { conversationId: otherConversation.id, artifactId: artifact.id }
      });
      expect(wrongConversation.statusCode).toBe(404);
      expect(readArtifacts).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("deletes attachment bytes when deleting a conversation", async () => {
    const deletedFileObjectKeys: string[] = [];
    const app = await createTestInstance({
      config: createTestConfig(),
      env: {},
      capabilities: [
        createTestAttachmentCapability({
          onConversationAttachmentsDeleted(deletion) {
            deletedFileObjectKeys.push(...deletion.fileObjectKeys);
          }
        })
      ],
      tools: []
    });
    const created = await app.call("createConversation", {
      payload: { title: "Attachment retention" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };
    const structuredData = await app.stores.publishStructuredDataResource({
      clientInstanceId: asClientInstanceId("demo-local"),
      conversationId: asConversationId(conversation.id),
      resourceKey: "retention_data",
      title: "Retention data",
      state: { title: "Retention data", sections: [] }
    });
    const upload = createMultipartFilePayload({
      fieldName: "file",
      filename: "retention.gif",
      contentType: "image/gif",
      content: "GIF89a"
    });

    const uploaded = await app.call("uploadDraftAttachment", {
      params: { conversationId: conversation.id },
      headers: upload.headers,
      payload: upload.payload
    });
    expect(uploaded.statusCode).toBe(200);
    const body = uploaded.json() as { attachment: { fileId: string } };
    const contentBeforeDelete = await app.call("getConversationFileContent", {
      params: { conversationId: conversation.id, fileId: body.attachment.fileId }
    });
    expect(contentBeforeDelete.statusCode).toBe(200);

    const deleted = await app.call("deleteConversation", {
      params: { conversationId: conversation.id }
    });
    expect(deleted.statusCode).toBe(200);
    await expect(
      app.stores.getStructuredDataResource({
        clientInstanceId: asClientInstanceId("demo-local"),
        conversationId: asConversationId(conversation.id),
        structuredDataResourceId: structuredData.id
      })
    ).resolves.toBeUndefined();
    const audit = await app.call("listAuditEvents", {});
    expect(audit.statusCode).toBe(200);
    expect(audit.json()).toContainEqual(
      expect.objectContaining({
        type: "conversation.deleted",
        metadata: expect.objectContaining({
          attachmentCount: 1,
          fileCount: 1
        })
      })
    );
    expect(deletedFileObjectKeys).toEqual([body.attachment.fileId]);

    const contentAfterDelete = await app.call("getConversationFileContent", {
      params: { conversationId: conversation.id, fileId: body.attachment.fileId }
    });
    expect(contentAfterDelete.statusCode).toBe(404);

    await app.close();
  });

  it("deletes composer-removed draft bytes when deleting a conversation", async () => {
    const fixture = createManagedObjectTestAttachmentCapability();
    const app = await createTestInstance({
      config: createTestConfig(),
      env: {},
      capabilities: [fixture.capability],
      tools: []
    });
    const created = await app.call("createConversation", {
      payload: { title: "Removed attachment retention" }
    });
    const conversation = created.json() as { id: string };
    const upload = createMultipartFilePayload({
      fieldName: "file",
      filename: "removed.txt",
      contentType: "text/plain",
      content: "delete these bytes"
    });
    const uploaded = await app.call("uploadDraftAttachment", {
      params: { conversationId: conversation.id },
      headers: upload.headers,
      payload: upload.payload
    });
    expect(uploaded.statusCode).toBe(200);
    const attachment = (uploaded.json() as { attachment: { id: string; fileId: string } })
      .attachment;
    const [objectKey] = [...fixture.objects.keys()];
    expect(objectKey).toBeDefined();

    const removed = await app.call("deleteDraftAttachment", {
      params: { conversationId: conversation.id, attachmentId: attachment.id }
    });
    expect(removed.statusCode).toBe(200);
    expect(fixture.objects.has(objectKey!)).toBe(true);

    const deleted = await app.call("deleteConversation", {
      params: { conversationId: conversation.id }
    });
    expect(deleted.statusCode).toBe(200);
    expect(fixture.objects.has(objectKey!)).toBe(false);
    expect(fixture.deletedObjectKeys).toContain(objectKey);
    await expect(
      app.stores.getManagedFile({
        clientInstanceId: asClientInstanceId("demo-local"),
        fileId: asManagedFileId(attachment.fileId)
      })
    ).resolves.toBeUndefined();

    const audit = await app.call("listAuditEvents", {});
    expect(audit.json()).toContainEqual(
      expect.objectContaining({
        type: "conversation.deleted",
        metadata: expect.objectContaining({
          attachmentCount: 1,
          fileCount: 1
        })
      })
    );
    await app.close();
  });

  it("stores no bytes when the conversation is deleted while an upload is still arriving", async () => {
    const fixture = createManagedObjectTestAttachmentCapability();
    const app = await createTestInstance({
      config: createTestConfig(),
      env: {},
      capabilities: [fixture.capability],
      tools: []
    });
    const created = await app.call("createConversation", {
      payload: { title: "Deleted during upload" }
    });
    const conversation = created.json() as { id: string };
    const upload = createMultipartFilePayload({
      fieldName: "file",
      filename: "late.txt",
      contentType: "text/plain",
      content: "bytes that arrive after the conversation is gone"
    });
    const splitAt = upload.payload.byteLength - 20;
    let bodyIsBeingRead!: () => void;
    const bodyRead = new Promise<void>((resolve) => {
      bodyIsBeingRead = resolve;
    });
    let sendRest!: () => void;
    const restReleased = new Promise<void>((resolve) => {
      sendRest = resolve;
    });
    const slowBody = Readable.from(
      (async function* () {
        yield upload.payload.subarray(0, splitAt);
        // The route asks for more only after it has accepted the request.
        bodyIsBeingRead();
        await restReleased;
        yield upload.payload.subarray(splitAt);
      })()
    );

    const uploading = app.call("uploadDraftAttachment", {
      params: { conversationId: conversation.id },
      headers: { "content-type": upload.headers["content-type"]! },
      payload: slowBody
    });
    await bodyRead;
    const deleted = await app.call("deleteConversation", {
      params: { conversationId: conversation.id }
    });
    expect(deleted.statusCode).toBe(200);
    sendRest();

    expect((await uploading).statusCode).toBe(404);
    expect(fixture.objects.size).toBe(0);
    await app.close();
  });

  it("generates a title when the first user message invokes a tool", async () => {
    const config = createTestConfig({
      tools: [{ name: "demo.echo", enabled: true }],
      toolNames: ["demo.echo"]
    });
    const tool = defineTool({
      name: "demo.echo",
      description: "Echo text for tests.",
      inputSchema: z.object({ text: z.string() }),
      outputSchema: z.object({ echoed: z.string() }),
      async execute(input) {
        return toolSuccess({ echoed: input.text });
      }
    });
    const app = await createTestInstance({
      config,
      env: {},
      tools: [tool]
    });
    const firstMessage = '/tool demo.echo {"text":"boarding pass"}';
    const created = await app.call("createConversation", { payload: { title: firstMessage } });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    const sent = await injectStartConversationRun(app, conversation.id, firstMessage, {
      idempotencyKey: "tool-title-generation-run"
    });
    await drainRunEvents(app, conversation.id, sent.run.id);

    const listed = await app.call("listConversations", await personalConversationListInput(app));
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toContainEqual(
      expect.objectContaining({
        id: conversation.id,
        title: "Tool result review"
      })
    );

    await app.close();
  });
});
