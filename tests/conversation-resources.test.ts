import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  HmacSessionTokenAuthAdapter,
  HmacSessionTokenIssuer
} from "@vivd-catalyst/auth";
import {
  createChatServer,
  type ChatAttachmentService
} from "@vivd-catalyst/chat-server";
import {
  AppError,
  NoopAuditRecorder,
  asClientInstanceId,
  asMessageId,
  createToolResultMetadata,
  type AgentRuntime,
  type ClientInstanceId,
  type ManagedFileId,
  type RuntimeCallContext,
  type ToolExecutionResult
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { ModelProvider } from "@vivd-catalyst/model-provider";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";

describe("conversation resource store queries", () => {
  it("lists sent attachments and available conversation artifacts newest-first", async () => {
    const clientInstanceId = asClientInstanceId("conversation-resource-store-test");
    const store = new InMemoryPlatformStore();
    const conversation = await createConversation(store, clientInstanceId, "owner");
    const otherConversation = await createConversation(store, clientInstanceId, "owner");

    const first = await createAttachment(store, {
      clientInstanceId,
      conversationId: conversation.id,
      filename: "first.txt"
    });
    await tick();
    const second = await createAttachment(store, {
      clientInstanceId,
      conversationId: conversation.id,
      filename: "second.txt"
    });
    await tick();
    const deleted = await createAttachment(store, {
      clientInstanceId,
      conversationId: conversation.id,
      filename: "deleted.txt"
    });
    await store.claimReadyDraftAttachmentsForMessage({
      clientInstanceId,
      conversationId: conversation.id,
      messageId: asMessageId("msg_sent"),
      claimedAt: new Date().toISOString()
    });
    await store.updateConversationAttachment({
      clientInstanceId,
      attachmentId: deleted.id,
      status: "deleted"
    });
    await createAttachment(store, {
      clientInstanceId,
      conversationId: conversation.id,
      filename: "draft.txt"
    });

    const firstArtifact = await createArtifact(store, clientInstanceId, conversation.id, "first.csv");
    await tick();
    const secondArtifact = await createArtifact(store, clientInstanceId, conversation.id, "second.csv");
    await createArtifact(store, clientInstanceId, otherConversation.id, "other.csv");

    await expect(
      store.listSentConversationAttachments({ clientInstanceId, conversationId: conversation.id })
    ).resolves.toEqual([
      expect.objectContaining({ id: second.id }),
      expect.objectContaining({ id: first.id })
    ]);
    await expect(
      store.listConversationManagedArtifacts({ clientInstanceId, conversationId: conversation.id })
    ).resolves.toEqual([
      expect.objectContaining({ id: secondArtifact.id }),
      expect.objectContaining({ id: firstArtifact.id })
    ]);
  });

});

describe("conversation resource routes", () => {
  it("projects structured data and resolves source filenames on the detail endpoint", async () => {
    const fixture = await createFixture();
    try {
      const conversation = await createConversation(
        fixture.store,
        fixture.clientInstanceId,
        `${fixture.clientInstanceId}:owner`
      );
      const attachment = await createAttachment(fixture.store, {
        clientInstanceId: fixture.clientInstanceId,
        conversationId: conversation.id,
        filename: "claim.pdf"
      });
      await fixture.store.claimReadyDraftAttachmentsForMessage({
        clientInstanceId: fixture.clientInstanceId,
        conversationId: conversation.id,
        messageId: asMessageId("msg_structured_source"),
        claimedAt: new Date().toISOString()
      });
      await tick();
      const resource = await fixture.store.publishStructuredDataResource({
        clientInstanceId: fixture.clientInstanceId,
        conversationId: conversation.id,
        resourceKey: "claim_data",
        title: "Claim data",
        state: {
          title: "Claim data",
          sections: [
            {
              key: "person",
              label: "Person",
              fields: [
                {
                  key: "name",
                  label: "Name",
                  value: "Ada",
                  sources: [{ attachmentId: attachment.id, page: 2 }]
                }
              ]
            }
          ]
        }
      });

      const resources = await request(
        fixture.server,
        fixture.ownerToken,
        `/api/conversations/${conversation.id}/resources`
      );
      expect(resources.statusCode).toBe(200);
      expect(resources.json()).toEqual({
        resources: [
          {
            resourceType: "structured_data",
            resourceId: `structured_data:${resource.id}`,
            title: "Claim data",
            createdAt: resource.createdAt,
            updatedAt: resource.updatedAt,
            preview: {
              kind: "structured_data",
              structuredDataResourceId: resource.id
            }
          },
          expect.objectContaining({
            resourceType: "source_file",
            attachmentId: attachment.id
          })
        ]
      });

      const detail = await request(
        fixture.server,
        fixture.ownerToken,
        `/api/conversations/${conversation.id}/structured-data/${resource.id}`
      );
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toEqual({
        id: resource.id,
        resourceKey: "claim_data",
        title: "Claim data",
        revision: 1,
        createdAt: resource.createdAt,
        updatedAt: resource.updatedAt,
        sections: [
          {
            key: "person",
            label: "Person",
            fields: [
              {
                key: "name",
                label: "Name",
                value: "Ada",
                sources: [
                  {
                    attachmentId: attachment.id,
                    page: 2,
                    filename: "claim.pdf"
                  }
                ]
              }
            ]
          }
        ]
      });
      expect(detail.payload).not.toContain("objectKey");
      const otherUser = await request(
        fixture.server,
        fixture.otherToken,
        `/api/conversations/${conversation.id}/structured-data/${resource.id}`
      );
      expect(otherUser.statusCode).toBe(404);
    } finally {
      await fixture.server.close();
    }
  });

  it("publishes only the newest successful marked display per analysis key", async () => {
    const fixture = await createFixture();
    try {
      const conversation = await createConversation(
        fixture.store,
        fixture.clientInstanceId,
        `${fixture.clientInstanceId}:owner`
      );
      await appendToolResult(fixture.store, fixture.clientInstanceId, conversation.id, {
        status: "success",
        display: analysisDisplay("report", "Old report", "old")
      });
      await tick();
      await appendToolResult(fixture.store, fixture.clientInstanceId, conversation.id, {
        status: "success",
        display: {
          kind: "chart",
          version: 1,
          mode: "side_panel",
          title: "Preview only",
          data: { value: "unmarked" }
        }
      });
      await tick();
      const failedResult = {
        status: "failed" as const,
        error: { code: "handler_failed" as const, message: "Failed" },
        display: analysisDisplay("failed", "Failed report", "failed")
      };
      await appendToolResult(
        fixture.store,
        fixture.clientInstanceId,
        conversation.id,
        failedResult
      );
      await tick();
      const newest = await appendToolResult(
        fixture.store,
        fixture.clientInstanceId,
        conversation.id,
        {
          status: "success",
          display: analysisDisplay("report", "Current report", "new")
        }
      );

      const response = await request(
        fixture.server,
        fixture.ownerToken,
        `/api/conversations/${conversation.id}/resources`
      );
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        resources: [
          {
            resourceType: "analysis",
            resourceId: "analysis:report",
            title: "Current report",
            createdAt: newest.createdAt,
            updatedAt: newest.createdAt,
            preview: {
              kind: "typed_display",
              display: analysisDisplay("report", "Current report", "new")
            }
          }
        ]
      });
    } finally {
      await fixture.server.close();
    }
  });

  it("previews an uploaded PDF from its source instead of internal preprocessing JSON", async () => {
    const fixture = await createFixture();
    try {
      const ownerId = `${fixture.clientInstanceId}:owner`;
      const conversation = await createConversation(
        fixture.store,
        fixture.clientInstanceId,
        ownerId
      );
      const pdfBytes = new TextEncoder().encode("%PDF-1.4 original");
      const file = await fixture.store.createManagedFile({
        clientInstanceId: fixture.clientInstanceId,
        ownerUserId: ownerId,
        filename: "input.pdf",
        mimeType: "application/pdf",
        byteSize: pdfBytes.byteLength,
        checksum: "sha256:input-pdf",
        objectKey: "private/source/input.pdf"
      });
      fixture.files.set(file.id, {
        filename: file.filename,
        mimeType: file.mimeType,
        bytes: pdfBytes
      });
      const canonicalPdf = await fixture.store.createManagedArtifact({
        clientInstanceId: fixture.clientInstanceId,
        conversationId: conversation.id,
        sourceFileId: file.id,
        kind: "document.canonical_pdf",
        objectKey: "private/prepared/input.canonical.pdf",
        filename: "input.canonical.pdf",
        mimeType: "application/pdf",
        byteSize: 10,
        checksum: "sha256:input-canonical"
      });
      const pagesJson = await fixture.store.createManagedArtifact({
        clientInstanceId: fixture.clientInstanceId,
        conversationId: conversation.id,
        sourceFileId: file.id,
        kind: "document.pages_json",
        objectKey: "private/prepared/input.pages.json",
        filename: "input.pdf.pages.json",
        mimeType: "application/json",
        byteSize: 10,
        checksum: "sha256:input-pages"
      });
      const sent = await fixture.store.createConversationAttachment({
        clientInstanceId: fixture.clientInstanceId,
        conversationId: conversation.id,
        fileId: file.id,
        filename: file.filename,
        mimeType: file.mimeType,
        byteSize: file.byteSize,
        checksum: file.checksum,
        status: "ready",
        format: "pdf",
        artifactRefs: {
          "document.pages_json": pagesJson.id,
          "document.canonical_pdf": canonicalPdf.id
        }
      });
      await fixture.store.claimReadyDraftAttachmentsForMessage({
        clientInstanceId: fixture.clientInstanceId,
        conversationId: conversation.id,
        messageId: asMessageId("msg_pdf"),
        claimedAt: new Date().toISOString()
      });

      const response = await request(
        fixture.server,
        fixture.ownerToken,
        `/api/conversations/${conversation.id}/resources`
      );

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        resources: [
          expect.objectContaining({
            resourceId: `source_file:${sent.id}`,
            preview: { kind: "source_file", fileId: file.id }
          })
        ]
      });
      const inline = await request(
        fixture.server,
        fixture.ownerToken,
        `/api/conversations/${conversation.id}/files/${file.id}/content`
      );
      expect(inline.statusCode).toBe(200);
      expect(inline.headers["content-disposition"]).toContain('inline; filename="input.pdf"');
      expect(inline.rawPayload).toEqual(Buffer.from(pdfBytes));
    } finally {
      await fixture.server.close();
    }
  });

  it("projects owned sent files and deduplicated promoted artifacts without leaking internals", async () => {
    const fixture = await createFixture();
    try {
      const ownerId = `${fixture.clientInstanceId}:owner`;
      const conversation = await createConversation(
        fixture.store,
        fixture.clientInstanceId,
        ownerId
      );
      const sourceBytes = new TextEncoder().encode("source document");
      const file = await fixture.store.createManagedFile({
        clientInstanceId: fixture.clientInstanceId,
        ownerUserId: ownerId,
        filename: "brief.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        byteSize: sourceBytes.byteLength,
        checksum: "sha256:brief",
        objectKey: "private/source/brief.docx"
      });
      fixture.files.set(file.id, {
        filename: file.filename,
        mimeType: file.mimeType,
        bytes: sourceBytes
      });
      const prepared = await fixture.store.createManagedArtifact({
        clientInstanceId: fixture.clientInstanceId,
        conversationId: conversation.id,
        sourceFileId: file.id,
        kind: "document.canonical_pdf",
        objectKey: "private/prepared/brief.pdf",
        filename: "brief.pdf",
        mimeType: "application/pdf",
        byteSize: 10,
        checksum: "sha256:prepared"
      });
      const sent = await fixture.store.createConversationAttachment({
        clientInstanceId: fixture.clientInstanceId,
        conversationId: conversation.id,
        fileId: file.id,
        filename: file.filename,
        mimeType: file.mimeType,
        byteSize: file.byteSize,
        checksum: file.checksum,
        status: "ready",
        format: "docx",
        artifactRefs: { "document.canonical_pdf": prepared.id }
      });
      await fixture.store.claimReadyDraftAttachmentsForMessage({
        clientInstanceId: fixture.clientInstanceId,
        conversationId: conversation.id,
        messageId: asMessageId("msg_sent"),
        claimedAt: new Date().toISOString()
      });
      await createAttachment(fixture.store, {
        clientInstanceId: fixture.clientInstanceId,
        conversationId: conversation.id,
        filename: "unsent.txt"
      });

      await tick();
      const oldPromotion = await createArtifact(
        fixture.store,
        fixture.clientInstanceId,
        conversation.id,
        "old-report.csv",
        {
          source: "execution_workspace",
          workspaceId: "workspace-secret",
          workspacePath: "private/results/report.csv",
          commandId: "command-secret"
        }
      );
      await tick();
      const newPromotion = await createArtifact(
        fixture.store,
        fixture.clientInstanceId,
        conversation.id,
        "report.csv",
        {
          source: "execution_workspace",
          workspaceId: "workspace-secret",
          workspacePath: "private/results/report.csv",
          commandId: "new-command-secret",
          renderer: "private-renderer"
        }
      );

      const response = await request(
        fixture.server,
        fixture.ownerToken,
        `/api/conversations/${conversation.id}/resources`
      );
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        resources: [
          {
            resourceType: "generated_file",
            resourceId: `generated_file:${newPromotion.id}`,
            title: "report.csv",
            createdAt: newPromotion.createdAt,
            updatedAt: newPromotion.createdAt,
            preview: { kind: "artifact", artifactId: newPromotion.id },
            download: {
              kind: "artifact",
              artifactId: newPromotion.id,
              filename: "report.csv"
            }
          },
          {
            resourceType: "source_file",
            resourceId: `source_file:${sent.id}`,
            attachmentId: sent.id,
            mimeType: sent.mimeType,
            title: "brief.docx",
            createdAt: sent.createdAt,
            updatedAt: expect.any(String),
            preview: {
              kind: "source_file",
              fileId: file.id
            },
            download: {
              kind: "source_file",
              fileId: file.id,
              filename: "brief.docx"
            }
          }
        ]
      });
      expect(response.payload).not.toContain(oldPromotion.id);
      expect(response.payload).not.toContain(prepared.id);
      expect(response.payload).not.toContain("workspace-secret");
      expect(response.payload).not.toContain("private/results");
      expect(response.payload).not.toContain("command-secret");
      expect(response.payload).not.toContain("renderer");

      const download = await request(
        fixture.server,
        fixture.ownerToken,
        `/api/conversations/${conversation.id}/files/${file.id}/content?download=true`
      );
      expect(download.statusCode).toBe(200);
      expect(download.headers["content-disposition"]).toContain('attachment; filename="brief.docx"');
      expect(download.rawPayload).toEqual(Buffer.from(sourceBytes));

      const otherUser = await request(
        fixture.server,
        fixture.otherToken,
        `/api/conversations/${conversation.id}/resources`
      );
      expect(otherUser.statusCode).toBe(404);
    } finally {
      await fixture.server.close();
    }
  });
});

async function createFixture() {
  const clientInstanceId = asClientInstanceId("conversation-resource-route-test");
  const store = new InMemoryPlatformStore();
  const config = parseClientInstanceConfig({
    version: 1,
    clientInstance: {
      id: clientInstanceId,
      displayName: "Conversation resources test",
      environment: "development"
    },
    auth: {},
    modelProviders: [{ id: "local", type: "deterministic", model: "local" }],
    tools: []
  });
  const authOptions = {
    secret: "conversation-resource-test-secret",
    clientInstanceId,
    issuer: "conversation-resource-test",
    ttlSeconds: 900
  };
  const issuer = new HmacSessionTokenIssuer(authOptions);
  const files = new Map<
    string,
    { filename: string; mimeType?: string; bytes: Uint8Array }
  >();
  const attachments: ChatAttachmentService = {
    maxFileBytes: 1024,
    acceptedFileTypes: [],
    listDraftAttachments: (conversationId) =>
      store.listDraftAttachments({ clientInstanceId, conversationId }),
    async uploadDraftAttachment() {
      throw new AppError("INTERNAL", "Uploads are not used by this test");
    },
    async retryDraftAttachment() {
      throw new AppError("INTERNAL", "Retries are not used by this test");
    },
    async deleteDraftAttachment() {
      throw new AppError("INTERNAL", "Deletion is not used by this test");
    },
    deleteConversationAttachments: (input) =>
      store.markConversationManagedObjectsDeleted({
        clientInstanceId,
        conversationId: input.conversationId,
        deletedAt: input.deletedAt
      }),
    async readConversationFile(input) {
      const file = files.get(input.fileId);
      if (!file) {
        throw new AppError("NOT_FOUND", "File is not available");
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
    createAttachmentManifest() {
      return { version: 1, attachments: [] };
    },
    isInlineDisplayMimeType() {
      return false;
    }
  };
  const server = await createChatServer({
    config,
    clientInstanceId,
    authAdapter: new HmacSessionTokenAuthAdapter(authOptions),
    conversationStore: store,
    auditEventStore: store,
    userStore: store,
    apiAccessStore: store,
    usageGovernance: new ModelUsageGovernance({
      store,
      budget: config.usage.budget,
      safeguards: config.usage.safeguards,
      costs: config.usage.costs
    }),
    auditRecorder: new NoopAuditRecorder(),
    configAssets: {
      store,
      source: {
        async getSnapshot() {
          return { version: 0, agents: [], skills: [] };
        }
      },
      validationRefs: {
        modelProviderIds: ["local"],
        modelBindingIds: [],
        modelBindings: [],
        reasoningEfforts: [],
        enabledToolNames: []
      }
    },
    agentRuntime: createMissingRuntime(),
    attachments,
    modelProvider: createUnusedModelProvider()
  });
  return {
    clientInstanceId,
    files,
    server,
    store,
    ownerToken: issuer.issue({ externalUserId: "owner", displayLabel: "Owner" }).chatSessionToken,
    otherToken: issuer.issue({ externalUserId: "other", displayLabel: "Other" }).chatSessionToken
  };
}

async function createConversation(
  store: InMemoryPlatformStore,
  clientInstanceId: ClientInstanceId,
  ownerUserId: string
) {
  return store.createConversation({
    clientInstanceId,
    ownerUserId,
    ownerExternalUserId: ownerUserId,
    title: "Resources",
    retainedUntil: "2030-01-01T00:00:00.000Z"
  });
}

async function createAttachment(
  store: InMemoryPlatformStore,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: Parameters<InMemoryPlatformStore["createConversationAttachment"]>[0]["conversationId"];
    filename: string;
  }
) {
  const file = await store.createManagedFile({
    clientInstanceId: input.clientInstanceId,
    ownerUserId: "owner",
    filename: input.filename,
    mimeType: "text/plain",
    byteSize: 1,
    checksum: `sha256:${input.filename}`,
    objectKey: `private/${input.filename}`
  });
  return store.createConversationAttachment({
    clientInstanceId: input.clientInstanceId,
    conversationId: input.conversationId,
    fileId: file.id,
    filename: input.filename,
    mimeType: file.mimeType,
    byteSize: file.byteSize,
    checksum: file.checksum,
    status: "ready",
    format: "txt"
  });
}

function createArtifact(
  store: InMemoryPlatformStore,
  clientInstanceId: ClientInstanceId,
  conversationId: Parameters<InMemoryPlatformStore["createManagedArtifact"]>[0]["conversationId"],
  filename: string,
  metadata: Record<string, string> = {}
) {
  return store.createManagedArtifact({
    clientInstanceId,
    conversationId,
    kind: "text/csv",
    objectKey: `private/${filename}`,
    filename,
    mimeType: "text/csv",
    byteSize: 1,
    checksum: `sha256:${filename}`,
    metadata
  });
}

function appendToolResult(
  store: InMemoryPlatformStore,
  clientInstanceId: ClientInstanceId,
  conversationId: Parameters<InMemoryPlatformStore["appendMessage"]>[0]["conversationId"],
  result: ToolExecutionResult
) {
  return store.appendMessage({
    clientInstanceId,
    conversationId,
    role: "tool",
    text: JSON.stringify({ status: result.status }),
    metadata: createToolResultMetadata({
      runId: "run_resources",
      toolCall: {
        toolCallId: "call_resources",
        toolName: "test.display",
        input: {}
      },
      result,
      modelOutput: { text: JSON.stringify({ status: result.status }) }
    })
  });
}

function analysisDisplay(key: string, title: string, value: string) {
  return {
    kind: "chart",
    version: 1,
    mode: "side_panel" as const,
    title,
    resource: { category: "analysis" as const, key },
    data: { value }
  };
}

function request(server: FastifyInstance, token: string, url: string) {
  return server.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}` }
  });
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 2));
}

function createMissingRuntime(): AgentRuntime {
  return {
    async start() {
      throw new AppError("NOT_FOUND", "Agent runtime has no local run state");
    },
    async *observe() {
      throw new AppError("NOT_FOUND", "Agent runtime has no local run state");
    },
    async getStatus() {
      throw new AppError("NOT_FOUND", "Agent runtime has no local run state");
    },
    async resume() {
      throw new AppError("NOT_FOUND", "Agent runtime has no local run state");
    },
    async cancel() {
      throw new AppError("NOT_FOUND", "Agent runtime has no local run state");
    }
  };
}

function createUnusedModelProvider(): ModelProvider {
  return {
    id: "unused",
    async complete(_request, _context: RuntimeCallContext) {
      throw new AppError("INTERNAL", "Model provider should not be used by this test");
    }
  };
}
