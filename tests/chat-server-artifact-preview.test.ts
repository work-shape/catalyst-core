import { describe, expect, it } from "vitest";
import { createChatServer } from "@vivd-catalyst/chat-server";
import {
  AppError,
  NoopAuditRecorder,
  asClientInstanceId,
  type AgentRuntime,
  type AuthenticatedUser,
  type ClientInstanceId,
  type RuntimeCallContext
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { ModelProvider } from "@vivd-catalyst/model-provider";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";

describe("artifact preview routes", () => {
  it("serves artifact preview state without exposing renderer or storage internals", async () => {
    const { clientInstanceId, owner, server, store } = await createPreviewServer();
    try {
      const conversation = await store.createConversation({
        clientInstanceId,
        ownerUserId: owner.id,
        ownerExternalUserId: owner.externalUserId,
        title: "Artifact preview",
        retainedUntil: "2030-01-01T00:00:00.000Z"
      });
      const otherConversation = await store.createConversation({
        clientInstanceId,
        ownerUserId: owner.id,
        ownerExternalUserId: owner.externalUserId,
        title: "Other preview conversation",
        retainedUntil: "2030-01-01T00:00:00.000Z"
      });
      const previewPage = await store.createManagedArtifact({
        clientInstanceId,
        conversationId: conversation.id,
        kind: "document.preview_page_image",
        objectKey: "artifact-previews/private/page-1.png",
        filename: "page-1.png",
        mimeType: "image/png",
        byteSize: 10,
        checksum: "sha256:page-1"
      });
      const readyArtifact = await store.createManagedArtifact({
        clientInstanceId,
        conversationId: conversation.id,
        kind: "document.docx",
        objectKey: "execution-workspaces/private/report.docx",
        filename: "report.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        byteSize: 128,
        checksum: "sha256:ready-docx"
      });
      await store.writeArtifactPreviewManifest({
        clientInstanceId,
        conversationId: conversation.id,
        sourceArtifactId: readyArtifact.id,
        status: "ready",
        type: "image_pages",
        format: "png",
        pages: [
          {
            artifactId: previewPage.id,
            mimeType: "image/png",
            filename: "page-1.png",
            pageNumber: 1,
            width: 1200,
            height: 1600
          }
        ]
      });
      const pendingArtifact = await store.createManagedArtifact({
        clientInstanceId,
        conversationId: conversation.id,
        kind: "presentation.pptx",
        objectKey: "execution-workspaces/private/deck.pptx",
        filename: "deck.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        byteSize: 256,
        checksum: "sha256:pending-pptx"
      });
      await store.enqueueArtifactPreviewJob({
        clientInstanceId,
        conversationId: conversation.id,
        sourceArtifactId: pendingArtifact.id,
        sourceChecksum: pendingArtifact.checksum,
        sourceMimeType: pendingArtifact.mimeType,
        queuedAt: "2026-07-01T12:00:00.000Z"
      });
      const failedArtifact = await store.createManagedArtifact({
        clientInstanceId,
        conversationId: conversation.id,
        kind: "document.doc",
        objectKey: "execution-workspaces/private/failed.doc",
        filename: "failed.doc",
        mimeType: "application/msword",
        byteSize: 64,
        checksum: "sha256:failed-doc"
      });
      await store.writeArtifactPreviewManifest({
        clientInstanceId,
        conversationId: conversation.id,
        sourceArtifactId: failedArtifact.id,
        status: "failed",
        errorCode: "conversion_failed"
      });
      const unsupportedManifestArtifact = await store.createManagedArtifact({
        clientInstanceId,
        conversationId: conversation.id,
        kind: "presentation.ppt",
        objectKey: "execution-workspaces/private/legacy.ppt",
        filename: "legacy.ppt",
        mimeType: "application/vnd.ms-powerpoint",
        byteSize: 64,
        checksum: "sha256:unsupported-ppt"
      });
      await store.writeArtifactPreviewManifest({
        clientInstanceId,
        conversationId: conversation.id,
        sourceArtifactId: unsupportedManifestArtifact.id,
        status: "unsupported",
        errorCode: "unsupported_type"
      });
      const spreadsheetArtifact = await store.createManagedArtifact({
        clientInstanceId,
        conversationId: conversation.id,
        kind: "spreadsheet.xlsx",
        objectKey: "execution-workspaces/private/sheet.xlsx",
        filename: "sheet.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        byteSize: 64,
        checksum: "sha256:sheet"
      });
      const embeddedArtifact = await store.createManagedArtifact({
        clientInstanceId,
        conversationId: conversation.id,
        kind: "presentation.pptx",
        objectKey: "execution-workspaces/private/embedded.pptx",
        filename: "embedded.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        byteSize: 64,
        checksum: "sha256:embedded-pptx",
        metadata: {
          preview: {
            type: "image_pages",
            format: "png",
            pages: [
              {
                artifactId: previewPage.id,
                kind: "document.preview_page_image",
                mimeType: "image/png",
                filename: "embedded-page.png",
                pageNumber: 1,
                width: 1024,
                height: 768,
                objectKey: "must-not-leak",
                workspacePath: "scratch/preview.png",
                commandId: "wcmd_secret"
              }
            ]
          }
        }
      });

      const ready = await server.inject({
        method: "GET",
        url: `/api/conversations/${conversation.id}/artifacts/${readyArtifact.id}/preview`
      });
      expect(ready.statusCode).toBe(200);
      expect(ready.headers["cache-control"]).toBe("private, no-store, max-age=0");
      expect(ready.json()).toEqual({
        status: "ready",
        artifactId: readyArtifact.id,
        type: "image_pages",
        format: "png",
        pages: [
          {
            artifactId: previewPage.id,
            mimeType: "image/png",
            filename: "page-1.png",
            pageNumber: 1,
            width: 1200,
            height: 1600
          }
        ]
      });
      expect(ready.payload).not.toContain("artifact-previews/private");
      expect(ready.payload).not.toContain("renderer");

      const pending = await server.inject({
        method: "GET",
        url: `/api/conversations/${conversation.id}/artifacts/${pendingArtifact.id}/preview`
      });
      expect(pending.statusCode).toBe(200);
      expect(pending.headers["cache-control"]).toBe("private, no-store, max-age=0");
      expect(pending.json()).toEqual({
        status: "pending",
        artifactId: pendingArtifact.id,
        queuedAt: "2026-07-01T12:00:00.000Z"
      });
      await expect(
        server.inject({
          method: "GET",
          url: `/api/conversations/${conversation.id}/artifacts/${failedArtifact.id}/preview`
        })
      ).resolves.toMatchObject({
        statusCode: 200,
        payload: JSON.stringify({
          status: "failed",
          artifactId: failedArtifact.id,
          errorCode: "conversion_failed"
        })
      });
      await expect(
        server.inject({
          method: "GET",
          url: `/api/conversations/${conversation.id}/artifacts/${unsupportedManifestArtifact.id}/preview`
        })
      ).resolves.toMatchObject({
        statusCode: 200,
        payload: JSON.stringify({
          status: "unsupported",
          artifactId: unsupportedManifestArtifact.id,
          errorCode: "unsupported_type"
        })
      });
      const spreadsheetPending = await server.inject({
        method: "GET",
        url: `/api/conversations/${conversation.id}/artifacts/${spreadsheetArtifact.id}/preview`
      });
      expect(spreadsheetPending.statusCode).toBe(200);
      expect(spreadsheetPending.json()).toMatchObject({
        status: "pending",
        artifactId: spreadsheetArtifact.id,
        queuedAt: expect.any(String)
      });

      const embedded = await server.inject({
        method: "GET",
        url: `/api/conversations/${conversation.id}/artifacts/${embeddedArtifact.id}/preview`
      });
      expect(embedded.statusCode).toBe(200);
      expect(embedded.json()).toEqual({
        status: "ready",
        artifactId: embeddedArtifact.id,
        type: "image_pages",
        format: "png",
        pages: [
          {
            artifactId: previewPage.id,
            mimeType: "image/png",
            filename: "embedded-page.png",
            pageNumber: 1,
            width: 1024,
            height: 768
          }
        ]
      });
      expect(embedded.payload).not.toContain("objectKey");
      expect(embedded.payload).not.toContain("workspacePath");
      expect(embedded.payload).not.toContain("wcmd_secret");
      expect(embedded.payload).not.toContain("document.preview_page_image");

      const wrongConversation = await server.inject({
        method: "GET",
        url: `/api/conversations/${otherConversation.id}/artifacts/${readyArtifact.id}/preview`
      });
      expect(wrongConversation.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("requires conversation read scope for artifact previews", async () => {
    const clientInstanceId = asClientInstanceId("demo-local");
    const owner: AuthenticatedUser = {
      ...createTestUser("user-1", clientInstanceId),
      scopes: ["conversation:write"]
    };
    const { server, store } = await createPreviewServer({ clientInstanceId, owner });
    try {
      const conversation = await store.createConversation({
        clientInstanceId,
        ownerUserId: owner.id,
        ownerExternalUserId: owner.externalUserId,
        title: "Artifact preview forbidden",
        retainedUntil: "2030-01-01T00:00:00.000Z"
      });
      const artifact = await store.createManagedArtifact({
        clientInstanceId,
        conversationId: conversation.id,
        kind: "document.docx",
        objectKey: "execution-workspaces/private/report.docx",
        filename: "report.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        byteSize: 128,
        checksum: "sha256:forbidden-docx"
      });

      const preview = await server.inject({
        method: "GET",
        url: `/api/conversations/${conversation.id}/artifacts/${artifact.id}/preview`
      });

      expect(preview.statusCode).toBe(403);
    } finally {
      await server.close();
    }
  });
});

async function createPreviewServer(input: {
  clientInstanceId?: ClientInstanceId;
  owner?: AuthenticatedUser;
} = {}) {
  const clientInstanceId = input.clientInstanceId ?? asClientInstanceId("demo-local");
  const store = new InMemoryPlatformStore();
  const config = createPreviewConfig(clientInstanceId);
  const owner = input.owner ?? createTestUser("user-1", clientInstanceId);
  const usageGovernance = new ModelUsageGovernance({
    store,
    budget: config.usage.budget,
    safeguards: config.usage.safeguards,
    pricing: config.usage.pricing
  });
  const server = await createChatServer({
    config,
    clientInstanceId,
    authAdapter: {
      id: "test-auth",
      async authenticate() {
        return owner;
      }
    },
    conversationStore: store,
    auditEventStore: store,
    userStore: store,
    usageGovernance,
    auditRecorder: new NoopAuditRecorder(),
    agentRuntime: createMissingRuntime(),
    modelProvider: createUnusedModelProvider()
  });
  return { clientInstanceId, owner, server, store };
}

function createPreviewConfig(clientInstanceId: ClientInstanceId) {
  return parseClientInstanceConfig({
    version: 1,
    clientInstance: {
      id: clientInstanceId,
      displayName: "Preview Test",
      environment: "development"
    },
    auth: {
      development: {
        enabled: true
      }
    },
    defaultAgentName: "test_agent",
    agents: [
      {
        name: "test_agent",
        displayName: "Test Agent",
        instructions: "Test only.",
        toolNames: []
      }
    ],
    modelProviders: [{ id: "local", type: "deterministic", model: "local" }],
    usage: {
      budget: {},
      safeguards: {}
    },
    tools: []
  });
}

function createTestUser(id: string, clientInstanceId: ClientInstanceId): AuthenticatedUser {
  return {
    id,
    externalUserId: id,
    displayLabel: id === "user-1" ? "User" : "Other user",
    roles: ["user", "admin", "superadmin"],
    permissionRefs: ["demo-tools"],
    clientInstanceId,
    authSource: "test",
    scopes: ["*"]
  };
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
      throw new AppError("INTERNAL", "Model provider should not be used by artifact preview tests");
    }
  };
}
