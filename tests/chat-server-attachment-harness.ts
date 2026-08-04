import { expect } from "vitest";
import type { ClientInstanceCapability } from "@vivd-catalyst/client-assembly";
import {
  createPlatformId,
  type AttachmentManifestEntry,
  type ConversationAttachment,
  type DraftAttachment,
  type FileAttachmentFormat,
  type ImageFileFormat,
  type ManagedFileId,
  type SupportedImageMimeType
} from "@vivd-catalyst/core";
import type { TestServer } from "./chat-server-harness";

export function createMultipartFilePayload(input: {
  fieldName: string;
  filename: string;
  contentType: string;
  content: string;
}): { headers: Record<string, string>; payload: Buffer } {
  const boundary = `vivd-test-${Math.random().toString(36).slice(2)}`;
  const payload = Buffer.from(
    [
      `--${boundary}`,
      `Content-Disposition: form-data; name="${input.fieldName}"; filename="${input.filename}"`,
      `Content-Type: ${input.contentType}`,
      "",
      input.content,
      `--${boundary}--`,
      ""
    ].join("\r\n")
  );
  return {
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(payload.byteLength)
    },
    payload
  };
}

export function createManagedObjectTestAttachmentCapability(): {
  capability: ClientInstanceCapability;
  objects: Map<string, Uint8Array>;
  deletedObjectKeys: string[];
} {
  const objects = new Map<string, Uint8Array>();
  const deletedObjectKeys: string[] = [];
  return {
    objects,
    deletedObjectKeys,
    capability: {
      name: "managed-object-test-attachments",
      create(context) {
        const managedObjects = context.managedObjectAccess.createAccess({
          byteStore: {
            async putObject(input) {
              objects.set(input.key, input.body);
            },
            async getObject(key) {
              const bytes = objects.get(key);
              if (!bytes) {
                throw new Error("Object is not available");
              }
              return bytes;
            },
            async deleteObject(key) {
              deletedObjectKeys.push(key);
              objects.delete(key);
            }
          },
          keyFactory: {
            createFileObjectKey(input) {
              return `test-files/${input.conversationId}/${input.checksum}`;
            },
            createArtifactObjectKey(input) {
              return `test-artifacts/${input.conversationId}/${input.checksum}`;
            }
          }
        });
        return {
          attachments: [
            {
              name: "managed-object-test-attachments",
              maxFileBytes: 1024 * 1024,
              acceptedFileTypes: ["text/plain"],
              acceptsFile() {
                return true;
              },
              listDraftAttachments(conversationId) {
                return context.files.listDraftAttachments({
                  clientInstanceId: context.clientInstanceId,
                  conversationId
                });
              },
              async uploadDraftAttachment(input) {
                const file = await managedObjects.createFile({
                  ownerUserId: input.ownerUserId,
                  conversationId: input.conversationId,
                  filename: input.filename,
                  mimeType: input.mimeType,
                  bytes: input.bytes
                });
                const attachment = await context.files.createConversationAttachment({
                  clientInstanceId: context.clientInstanceId,
                  conversationId: input.conversationId,
                  fileId: file.id,
                  filename: input.filename,
                  mimeType: input.mimeType,
                  byteSize: input.bytes.byteLength,
                  checksum: file.checksum,
                  status: "ready"
                });
                return { attachment, outcome: "created" };
              },
              async retryDraftAttachment() {
                throw new Error("Retry is not used by this test");
              },
              deleteDraftAttachment(input) {
                return context.files.deleteDraftAttachment({
                  clientInstanceId: context.clientInstanceId,
                  conversationId: input.conversationId,
                  attachmentId: input.attachmentId as DraftAttachment["id"],
                  deletedAt: new Date().toISOString()
                });
              },
              deleteConversationAttachments(input) {
                return managedObjects.deleteConversationObjects(input);
              },
              async readConversationFile(input) {
                const file = await managedObjects.readFile({
                  fileId: input.fileId as ManagedFileId
                });
                return {
                  fileId: file.record.id,
                  filename: file.record.filename,
                  mimeType: file.record.mimeType,
                  byteSize: file.record.byteSize,
                  bytes: file.bytes
                };
              },
              blockingDraftAttachmentMessage() {
                return undefined;
              },
              createAttachmentManifest() {
                return { version: 1, attachments: [] };
              },
              isInlineDisplayMimeType() {
                return false;
              }
            }
          ]
        };
      }
    }
  };
}

export function createTestAttachmentCapability(
  options: {
    onConversationAttachmentsDeleted?(deletion: {
      attachmentCount: number;
      fileObjectKeys: string[];
      artifactObjectKeys: string[];
    }): void;
  } = {}
): ClientInstanceCapability {
  const attachmentsByConversation = new Map<string, DraftAttachment[]>();
  const files = new Map<
    string,
    {
      filename: string;
      mimeType?: string;
      bytes: Uint8Array;
    }
  >();

  return {
    name: "test-attachments",
    create(context) {
      return {
        attachments: [
          {
            name: "test-attachments",
            maxFileBytes: 1024 * 1024,
            acceptedFileTypes: ["text/plain", "image/gif"],
            acceptsFile() {
              return true;
            },
            async listDraftAttachments(conversationId) {
              return attachmentsByConversation.get(conversationId) ?? [];
            },
            async uploadDraftAttachment(input) {
              const fileId = createPlatformId<"ManagedFileId">("file");
              const attachment: DraftAttachment = {
                id: createPlatformId<"ConversationAttachmentId">("att"),
                clientInstanceId: context.clientInstanceId,
                conversationId: input.conversationId,
                fileId,
                filename: input.filename,
                mimeType: input.mimeType,
                byteSize: input.bytes.byteLength,
                checksum: "test-checksum",
                status: "ready",
                format: formatForMimeType(input.mimeType),
                artifactRefs: {},
                processingMetadata: {},
                warnings: [],
                error: null,
                processingAttempts: 0,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
              };
              files.set(fileId, {
                filename: input.filename,
                mimeType: input.mimeType,
                bytes: input.bytes
              });
              const conversationAttachments =
                attachmentsByConversation.get(input.conversationId) ?? [];
              conversationAttachments.push(attachment);
              attachmentsByConversation.set(input.conversationId, conversationAttachments);
              return {
                attachment,
                outcome: "created"
              };
            },
            async retryDraftAttachment() {
              throw new Error("Retry is not implemented by the test attachment capability");
            },
            async deleteDraftAttachment(input) {
              const conversationAttachments =
                attachmentsByConversation.get(input.conversationId) ?? [];
              const remaining = conversationAttachments.filter(
                (attachment) => attachment.id !== input.attachmentId
              );
              attachmentsByConversation.set(input.conversationId, remaining);
              const deleted = conversationAttachments.find(
                (attachment) => attachment.id === input.attachmentId
              );
              if (!deleted) {
                throw new Error("Attachment is not available");
              }
              return {
                ...deleted,
                deletedAt: new Date().toISOString()
              };
            },
            async deleteConversationAttachments(input) {
              const conversationAttachments =
                attachmentsByConversation.get(input.conversationId) ?? [];
              attachmentsByConversation.set(input.conversationId, []);
              for (const attachment of conversationAttachments) {
                files.delete(attachment.fileId);
              }
              const deletion = {
                attachmentCount: conversationAttachments.length,
                fileObjectKeys: conversationAttachments.map((attachment) => attachment.fileId),
                artifactObjectKeys: []
              };
              options.onConversationAttachmentsDeleted?.(deletion);
              return deletion;
            },
            async readConversationFile(input) {
              const file = files.get(input.fileId);
              if (!file) {
                throw new Error("File is not available");
              }
              return {
                fileId: input.fileId as ManagedFileId,
                filename: file.filename,
                mimeType: file.mimeType,
                byteSize: file.bytes.byteLength,
                bytes: file.bytes
              };
            },
            blockingDraftAttachmentMessage() {
              return undefined;
            },
            createAttachmentManifest(attachments) {
              return {
                version: 1,
                attachments: attachments.flatMap((attachment) =>
                  manifestEntryForAttachment(attachment)
                )
              };
            },
            isInlineDisplayMimeType(mimeType) {
              return mimeType === "image/gif";
            }
          }
        ]
      };
    }
  };
}

function manifestEntryForAttachment(attachment: ConversationAttachment): AttachmentManifestEntry[] {
  if (attachment.mimeType === "image/gif") {
    return [
      {
        kind: "image" as const,
        fileId: attachment.fileId,
        attachmentId: attachment.id,
        filename: attachment.filename,
        mimeType: "image/gif" as SupportedImageMimeType,
        byteSize: attachment.byteSize,
        status: "ready" as const,
        readable: false as const,
        modelVisibility: {
          type: "image" as const,
          mimeType: "image/gif" as SupportedImageMimeType
        },
        modelContext: {
          section: "Attached images",
          text: `- ${attachment.filename} (fileId: ${attachment.fileId}, status: ready, mimeType: image/gif, size: ${attachment.byteSize} bytes). The image is loaded directly into visual context when the provider supports image inputs.`
        },
        metadata: {
          fileId: attachment.fileId,
          filename: attachment.filename,
          mimeType: "image/gif" as SupportedImageMimeType,
          byteSize: attachment.byteSize,
          format: "gif" as ImageFileFormat,
          checksum: attachment.checksum
        }
      }
    ];
  }

  return [
    {
      kind: "document" as const,
      fileId: attachment.fileId,
      attachmentId: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      byteSize: attachment.byteSize,
      status: "ready" as const,
      readable: true as const,
      modelContext: {
        section: "Attached files",
        text: `- ${attachment.filename} (fileId: ${attachment.fileId}, status: ready, size: ${attachment.byteSize} bytes).`
      },
      metadata: {
        fileId: attachment.fileId,
        filename: attachment.filename,
        mimeType: attachment.mimeType ?? null,
        byteSize: attachment.byteSize,
        format: attachment.format === "txt" ? "txt" : null,
        warnings: []
      }
    }
  ];
}

function formatForMimeType(mimeType: string | undefined): FileAttachmentFormat | undefined {
  if (mimeType === "image/gif") {
    return "gif";
  }
  if (mimeType === "text/plain") {
    return "txt";
  }
  return undefined;
}

export async function waitForReadyDraftAttachment(
  server: TestServer,
  conversationId: string
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await server.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/draft-attachments`
    });
    expect(response.statusCode).toBe(200);
    const attachments = response.json() as Array<{ status: string }>;
    if (attachments.some((attachment) => attachment.status === "ready")) {
      return;
    }
    await delay(10);
  }
  throw new Error("Timed out waiting for draft attachment preprocessing");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
