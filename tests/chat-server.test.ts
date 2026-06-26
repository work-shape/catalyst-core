import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AddressInfo } from "net";
import {
  createClientInstanceApp,
  type ClientInstanceCapability
} from "@vivd-catalyst/client-assembly";
import {
  createPlatformId,
  type ConversationAttachment,
  type DraftAttachment,
  type FileAttachmentFormat,
  type ImageFileFormat,
  type ManagedFileId,
  type SupportedImageMimeType
} from "@vivd-catalyst/core";
import { parseClientInstanceConfig, type UsageSafeguardsConfig } from "@vivd-catalyst/config-schema";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";

describe("client instance app vertical slice", () => {
  it("creates a user-scoped conversation and runs a configured tool", async () => {
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
    const app = await createClientInstanceApp({
      config,
      env: {},
      storeMode: "memory",
      tools: [tool]
    });

    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Tool test" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    const sent = await app.server.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        conversationId: conversation.id,
        messages: [createUserUiMessage('/tool demo.echo {"text":"hello"}')]
      }
    });

    expect(sent.statusCode).toBe(200);
    expect(parseSseChunks(sent.payload).some((chunk) => chunk.type === "finish")).toBe(true);

    const messages = await app.server.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/messages`
    });
    expect(messages.statusCode).toBe(200);
    const persistedMessages = messages.json() as Array<{ role: string; text: string }>;
    expect(persistedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          text: expect.stringContaining('"echoed": "hello"')
        })
      ])
    );

    const audit = await app.server.inject({
      method: "GET",
      url: "/api/audit-events"
    });
    expect(audit.statusCode).toBe(200);
    expect((audit.json() as Array<{ type: string }>).some((event) => event.type === "tool.completed")).toBe(
      true
    );

    const usage = await app.server.inject({
      method: "GET",
      url: "/api/superadmin/usage"
    });
    expect(usage.statusCode).toBe(200);
    const usageBody = usage.json() as {
      today: { modelCallCount: number; cost: { totalCostMicros: number } };
    };
    expect(usageBody.today).toMatchObject({
      cost: {
        totalCostMicros: 0
      }
    });
    expect(usageBody.today.modelCallCount).toBeGreaterThan(0);

    await app.close();
  });

  it("exposes active chat runs as resumable streams", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Resume test" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    await app.server.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const sent = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        conversationId: conversation.id,
        messages: [createUserUiMessage("resume this response while it is active")]
      })
    });
    expect(sent.status).toBe(200);
    const streamId = sent.headers.get("x-resumable-stream-id");
    expect(streamId).toEqual(expect.stringMatching(/^run_/));

    const resumed = await fetch(`${baseUrl}/api/chat/runs/${streamId}/stream`);
    expect(resumed.status).toBe(200);
    expect(resumed.headers.get("x-resumable-stream-id")).toBe(streamId);
    const [sentPayload, resumedPayload] = await Promise.all([sent.text(), resumed.text()]);
    expect(parseSseChunks(sentPayload).some((chunk) => chunk.type === "finish")).toBe(true);
    const resumedChunks = parseSseChunks(resumedPayload);
    expect(resumedChunks.some((chunk) => chunk.type === "text-delta")).toBe(true);
    expect(resumedChunks.some((chunk) => chunk.type === "finish")).toBe(true);

    const completedResume = await fetch(`${baseUrl}/api/chat/runs/${streamId}/stream`);
    expect(completedResume.status).toBe(200);
    expect(parseSseChunks(await completedResume.text()).some((chunk) => chunk.type === "finish")).toBe(
      true
    );

    await app.close();
  });

  it("resumes completed runs from a cursor and keeps terminal observations available", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Abandoned resume test" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    await app.server.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const sent = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        conversationId: conversation.id,
        messages: [createUserUiMessage("complete after abandoned stream")]
      })
    });
    expect(sent.status).toBe(200);
    const streamId = sent.headers.get("x-resumable-stream-id");
    expect(streamId).toEqual(expect.stringMatching(/^run_/));
    const sentChunks = parseSseChunks(await sent.text());
    const sentTextDeltas = sentChunks
      .filter((chunk) => chunk.type === "text-delta")
      .map((chunk) => chunk.delta ?? "");
    expect(sentTextDeltas.length).toBeGreaterThan(1);

    const cursorResume = await fetch(`${baseUrl}/api/chat/runs/${streamId}/stream?after=1`);
    expect(cursorResume.status).toBe(200);
    const cursorDeltas = parseSseChunks(await cursorResume.text())
      .filter((chunk) => chunk.type === "text-delta")
      .map((chunk) => chunk.delta ?? "");
    expect(cursorDeltas.join("")).toBe(sentTextDeltas.slice(1).join(""));

    const terminalAfter = sentTextDeltas.length + 1;
    const terminalResume = await fetch(`${baseUrl}/api/chat/runs/${streamId}/stream`, {
      headers: {
        "last-event-id": String(terminalAfter)
      }
    });
    expect(terminalResume.status).toBe(200);
    expect(parseSseChunks(await terminalResume.text()).some((chunk) => chunk.type === "finish")).toBe(
      true
    );

    const caughtUpResume = await fetch(
      `${baseUrl}/api/chat/runs/${streamId}/stream?after=${sentTextDeltas.length + 2}`
    );
    expect(caughtUpResume.status).toBe(204);

    await app.close();
  });

  it("does not expose or mutate another user's resumable run", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig({
        developmentAuth: {
          enabled: true,
          defaultUserId: "user-1",
          users: [
            {
              id: "user-1",
              externalUserId: "user-1",
              displayLabel: "User One",
              roles: ["user"],
              permissionRefs: ["demo-tools"]
            },
            {
              id: "user-2",
              externalUserId: "user-2",
              displayLabel: "User Two",
              roles: ["user"],
              permissionRefs: ["demo-tools"]
            }
          ]
        }
      }),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      headers: {
        "x-dev-user-id": "user-1"
      },
      payload: { title: "Owner mismatch" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    await app.server.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const sent = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dev-user-id": "user-1"
      },
      body: JSON.stringify({
        conversationId: conversation.id,
        messages: [createUserUiMessage("owner mismatch should not clear this run")]
      })
    });
    expect(sent.status).toBe(200);
    const streamId = sent.headers.get("x-resumable-stream-id");
    expect(streamId).toEqual(expect.stringMatching(/^run_/));
    await sent.text();

    const wrongOwnerResume = await fetch(`${baseUrl}/api/chat/runs/${streamId}/stream`, {
      headers: {
        "x-dev-user-id": "user-2"
      }
    });
    expect(wrongOwnerResume.status).toBe(204);

    const rightfulResume = await fetch(`${baseUrl}/api/chat/runs/${streamId}/stream`, {
      headers: {
        "x-dev-user-id": "user-1"
      }
    });
    expect(rightfulResume.status).toBe(200);
    expect(parseSseChunks(await rightfulResume.text()).some((chunk) => chunk.type === "finish")).toBe(
      true
    );

    await app.close();
  });

  it("cancels a backend run through the cancel route and records cancellation", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Cancel test" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    await app.server.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const sent = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        conversationId: conversation.id,
        messages: [createUserUiMessage("cancel this deliberately long enough response")]
      })
    });
    expect(sent.status).toBe(200);
    const streamId = sent.headers.get("x-resumable-stream-id");
    expect(streamId).toEqual(expect.stringMatching(/^run_/));

    const cancelled = await fetch(
      `${baseUrl}/api/chat/conversations/${conversation.id}/runs/${streamId}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ reason: "test cancellation" })
      }
    );
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json()) as { run: { status: string } }).toMatchObject({
      run: {
        status: "cancelled"
      }
    });
    await sent.text();

    const auditEvents = await waitForAuditEvents(app.server, "message.cancelled");
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        type: "message.cancelled",
        metadata: expect.objectContaining({
          runId: streamId,
          reason: "test cancellation"
        })
      })
    );

    await app.close();
  });

  it("rejects messages after the configured daily model call limit is reached", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig({
        usageSafeguards: {
          modelCallsPerDay: 1
        }
      }),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Usage limit test" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    const firstMessage = await app.server.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        conversationId: conversation.id,
        messages: [createUserUiMessage("hello")]
      }
    });
    expect(firstMessage.statusCode).toBe(200);

    const secondMessage = await app.server.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        conversationId: conversation.id,
        messages: [createUserUiMessage("hello again")]
      }
    });
    expect(secondMessage.statusCode).toBe(200);
    expect(parseSseChunks(secondMessage.payload)).toContainEqual(
      expect.objectContaining({
        type: "error",
        errorText: "Daily model call safeguard has been reached"
      })
    );

    const audit = await app.server.inject({
      method: "GET",
      url: "/api/audit-events"
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json()).toContainEqual(
      expect.objectContaining({
        type: "message.failed",
        metadata: expect.objectContaining({
          errorCategory: "app_error",
          errorCode: "FORBIDDEN"
        })
      })
    );

    await app.close();
  });

  it("exposes configured agent welcome message and initial prompts through safe config", async () => {
    const initialPrompts = [
      {
        title: "Review release",
        prompt: "Summarize release readiness."
      }
    ];
    const welcomeMessage = "What should we review first?";
    const app = await createClientInstanceApp({
      config: createTestConfig({ welcomeMessage, initialPrompts }),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const response = await app.server.inject({
      method: "GET",
      url: "/api/config"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      agents: [
        expect.objectContaining({
          name: "test_agent",
          welcomeMessage,
          initialPrompts
        })
      ]
    });

    await app.close();
  });

  it("resolves localized agent content in safe config", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig({
        displayName: {
          en: "Application Assistant",
          de: "Antragsassistent"
        },
        welcomeMessage: {
          en: "How can I help with the financing workflow?",
          de: "Wie kann ich beim Finanzierungsworkflow helfen?"
        },
        initialPrompts: [
          {
            title: {
              en: "Summarize documents",
              de: "Dokumente zusammenfassen"
            },
            prompt: {
              en: "Summarize the documents.",
              de: "Fasse die Dokumente zusammen."
            }
          }
        ]
      }),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const response = await app.server.inject({
      method: "GET",
      url: "/api/config?locale=de"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      localization: {
        locale: "de",
        defaultLocale: "en",
        supportedLocales: ["en", "de"]
      },
      agents: [
        expect.objectContaining({
          displayName: "Antragsassistent",
          welcomeMessage: "Wie kann ich beim Finanzierungsworkflow helfen?",
          initialPrompts: [
            {
              title: "Dokumente zusammenfassen",
              prompt: "Fasse die Dokumente zusammen."
            }
          ]
        })
      ]
    });

    await app.close();
  });

  it("generates a short conversation headline from the first user message", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      capabilities: [createTestAttachmentCapability()],
      tools: []
    });
    const firstMessage = "Please summarize the release notes";
    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: firstMessage }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    const sent = await app.server.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        conversationId: conversation.id,
        messages: [createUserUiMessage(firstMessage)]
      }
    });
    expect(sent.statusCode).toBe(200);
    expect(parseSseChunks(sent.payload), sent.payload).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "finish" })])
    );

    const generatedTitle = await app.server.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/title`
    });
    expect(generatedTitle.statusCode).toBe(200);
    expect(generatedTitle.json()).toMatchObject({
      id: conversation.id,
      title: "Please Summarize The Release Notes"
    });

    const listed = await app.server.inject({
      method: "GET",
      url: "/api/conversations"
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toContainEqual(
      expect.objectContaining({
        id: conversation.id,
        title: "Please Summarize The Release Notes"
      })
    );

    const audit = await app.server.inject({
      method: "GET",
      url: "/api/audit-events"
    });
    expect(audit.statusCode).toBe(200);
    expect((audit.json() as Array<{ type: string }>).some((event) => event.type === "conversation.title_generated")).toBe(
      true
    );

    await app.close();
  });

  it("replaces a file-drop placeholder title from the first user message", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      capabilities: [createTestAttachmentCapability()],
      tools: []
    });
    const filenameTitle = "Theo - Boardingpass - Y123.txt";
    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: filenameTitle }
    });
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
        await app.server.inject({
          method: "POST",
          url: `/api/conversations/${conversation.id}/draft-attachments`,
          headers: upload.headers,
          payload: upload.payload
        })
      ).statusCode
    ).toBe(200);
    await waitForReadyDraftAttachment(app.server, conversation.id);

    const sent = await app.server.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        conversationId: conversation.id,
        messages: [createUserUiMessage("Please summarize this boarding pass")]
      }
    });
    expect(sent.statusCode).toBe(200);
    expect(parseSseChunks(sent.payload), sent.payload).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "finish" })])
    );

    const listed = await app.server.inject({
      method: "GET",
      url: "/api/conversations"
    });
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
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      capabilities: [createTestAttachmentCapability()],
      tools: []
    });
    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Image upload" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };
    const upload = createMultipartFilePayload({
      fieldName: "file",
      filename: "receipt.gif",
      contentType: "image/gif",
      content: "GIF89a"
    });

    const uploaded = await app.server.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/draft-attachments`,
      headers: upload.headers,
      payload: upload.payload
    });
    expect(uploaded.statusCode).toBe(200);
    const body = uploaded.json() as { attachment: { fileId: string; status: string; format: string } };
    expect(body.attachment).toMatchObject({
      status: "ready",
      format: "gif"
    });

    const content = await app.server.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/files/${body.attachment.fileId}/content`
    });

    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toContain("image/gif");
    expect(content.payload).toBe("GIF89a");

    await app.close();
  });

  it("deletes attachment bytes when deleting a conversation", async () => {
    const deletedFileObjectKeys: string[] = [];
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      capabilities: [
        createTestAttachmentCapability({
          onConversationAttachmentsDeleted(deletion) {
            deletedFileObjectKeys.push(...deletion.fileObjectKeys);
          }
        })
      ],
      tools: []
    });
    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Attachment retention" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };
    const upload = createMultipartFilePayload({
      fieldName: "file",
      filename: "retention.gif",
      contentType: "image/gif",
      content: "GIF89a"
    });

    const uploaded = await app.server.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/draft-attachments`,
      headers: upload.headers,
      payload: upload.payload
    });
    expect(uploaded.statusCode).toBe(200);
    const body = uploaded.json() as { attachment: { fileId: string } };
    const contentBeforeDelete = await app.server.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/files/${body.attachment.fileId}/content`
    });
    expect(contentBeforeDelete.statusCode).toBe(200);

    const deleted = await app.server.inject({
      method: "DELETE",
      url: `/api/conversations/${conversation.id}`
    });
    expect(deleted.statusCode).toBe(200);
    const audit = await app.server.inject({
      method: "GET",
      url: "/api/audit-events"
    });
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

    const contentAfterDelete = await app.server.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/files/${body.attachment.fileId}/content`
    });
    expect(contentAfterDelete.statusCode).toBe(404);

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
    const app = await createClientInstanceApp({
      config,
      env: {},
      storeMode: "memory",
      tools: [tool]
    });
    const firstMessage = '/tool demo.echo {"text":"boarding pass"}';
    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: firstMessage }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    const sent = await app.server.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        conversationId: conversation.id,
        messages: [createUserUiMessage(firstMessage)]
      }
    });
    expect(sent.statusCode).toBe(200);
    expect(parseSseChunks(sent.payload), sent.payload).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "finish" })])
    );

    const listed = await app.server.inject({
      method: "GET",
      url: "/api/conversations"
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toContainEqual(
      expect.objectContaining({
        id: conversation.id,
        title: "Tool result review"
      })
    );

    await app.close();
  });

  it("switches between configured development users without exposing a dev-user listing route", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig({
        developmentAuth: {
          enabled: true,
          defaultUserId: "superadmin-1",
          users: [
            {
              id: "superadmin-1",
              externalUserId: "superadmin-1",
              displayLabel: "Superadmin",
              roles: ["user", "admin", "superadmin"],
              permissionRefs: ["demo-tools"]
            },
            {
              id: "user-1",
              externalUserId: "user-1",
              displayLabel: "Normal User",
              roles: ["user"],
              permissionRefs: ["demo-tools"]
            }
          ]
        }
      }),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const developmentUsersRoute = await app.server.inject({
      method: "GET",
      url: "/auth/development/users"
    });
    expect(developmentUsersRoute.statusCode).toBe(404);

    const defaultMe = await app.server.inject({
      method: "GET",
      url: "/api/me"
    });
    expect(defaultMe.statusCode).toBe(200);
    expect(defaultMe.json()).toMatchObject({
      displayLabel: "Superadmin",
      externalUserId: "superadmin-1",
      roles: ["user", "admin", "superadmin"]
    });

    const normalMe = await app.server.inject({
      method: "GET",
      url: "/api/me",
      headers: {
        "x-dev-user-id": "user-1"
      }
    });
    expect(normalMe.statusCode).toBe(200);
    expect(normalMe.json()).toMatchObject({
      displayLabel: "Normal User",
      externalUserId: "user-1",
      roles: ["user"]
    });

    const normalUsage = await app.server.inject({
      method: "GET",
      url: "/api/superadmin/usage",
      headers: {
        "x-dev-user-id": "user-1"
      }
    });
    expect(normalUsage.statusCode).toBe(403);

    const unknownUser = await app.server.inject({
      method: "GET",
      url: "/api/me",
      headers: {
        "x-dev-user-id": "missing-user"
      }
    });
    expect(unknownUser.statusCode).toBe(401);

    await app.close();
  });

  it("lets a user update their own profile without changing authorization fields", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig({
        developmentAuth: {
          enabled: true,
          defaultUserId: "superadmin-1",
          users: [
            {
              id: "superadmin-1",
              externalUserId: "superadmin-1",
              displayLabel: "Superadmin",
              roles: ["user", "admin", "superadmin"],
              permissionRefs: ["demo-tools"]
            },
            {
              id: "user-1",
              externalUserId: "user-1",
              displayLabel: "Normal User",
              roles: ["user"],
              permissionRefs: ["demo-tools"]
            }
          ]
        }
      }),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const updated = await app.server.inject({
      method: "PATCH",
      url: "/api/me",
      headers: {
        "x-dev-user-id": "user-1"
      },
      payload: {
        displayLabel: "Updated User",
        email: "escalation@example.test",
        roles: ["superadmin"]
      }
    });
    expect(updated.statusCode).toBe(200);
    const updatedBody = updated.json() as { displayLabel: string; email?: string; roles: string[] };
    expect(updatedBody).toMatchObject({
      displayLabel: "Updated User",
      roles: ["user"]
    });
    expect(updatedBody.email).not.toBe("escalation@example.test");

    const audit = await app.server.inject({
      method: "GET",
      url: "/api/audit-events",
      headers: {
        "x-dev-user-id": "superadmin-1"
      }
    });
    expect(audit.statusCode).toBe(200);
    expect((audit.json() as Array<{ type: string }>).map((event) => event.type)).toEqual(
      expect.arrayContaining(["user.profile_updated"])
    );

    await app.close();
  });

  it("rejects self-service password changes outside standalone auth", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const changed = await app.server.inject({
      method: "POST",
      url: "/api/me/password",
      payload: {
        currentPassword: "old-password",
        newPassword: "new-password"
      }
    });
    expect(changed.statusCode).toBe(422);
    expect((changed.json() as { error: { message: string } }).error.message).toContain(
      "standalone auth"
    );

    await app.close();
  });

  it("administers users and shares conversations across linked auth identities", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig({
        sessionToken: {
          issuer: "demo-client-instance",
          ttlSeconds: 900
        },
        developmentAuth: {
          enabled: true,
          defaultUserId: "superadmin-1",
          users: [
            {
              id: "superadmin-1",
              externalUserId: "superadmin-1",
              displayLabel: "Superadmin",
              roles: ["user", "admin", "superadmin"],
              permissionRefs: ["demo-tools"]
            },
            {
              id: "jane-dev-source",
              externalUserId: "jane-dev",
              displayLabel: "Jane Standalone",
              email: "jane@example.test",
              emailVerified: true,
              roles: ["user"],
              permissionRefs: ["demo-tools"]
            }
          ]
        }
      }),
      env: {
        CHAT_SESSION_TOKEN_SECRET: "a-development-session-token-secret",
        CHAT_SERVER_CREDENTIAL: "server-credential"
      },
      storeMode: "memory",
      tools: []
    });

    const usersBefore = await app.server.inject({
      method: "GET",
      url: "/api/superadmin/users",
      headers: {
        "x-dev-user-id": "superadmin-1"
      }
    });
    expect(usersBefore.statusCode).toBe(200);
    expect(usersBefore.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayLabel: "Superadmin",
          identities: [
            expect.objectContaining({
              authSource: "development",
              externalUserId: "superadmin-1"
            })
          ]
        })
      ])
    );

    const created = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/users",
      headers: {
        "x-dev-user-id": "superadmin-1"
      },
      payload: {
        displayLabel: "Jane Reviewer",
        email: "jane@example.test",
        roles: ["user"],
        permissionRefs: ["demo-tools"]
      }
    });
    expect(created.statusCode).toBe(200);
    const administeredUser = created.json() as { id: string };

    for (const identity of [
      {
        authSource: "session-token",
        externalUserId: "customer-jane",
        displayLabel: "Jane Reviewer",
        email: "jane@example.test",
        emailVerified: true
      },
      {
        authSource: "development",
        externalUserId: "jane-dev",
        displayLabel: "Jane Standalone",
        email: "jane@example.test",
        emailVerified: true
      }
    ]) {
      const linked = await app.server.inject({
        method: "PUT",
        url: `/api/superadmin/users/${administeredUser.id}/identities`,
        headers: {
          "x-dev-user-id": "superadmin-1"
        },
        payload: identity
      });
      expect(linked.statusCode).toBe(200);
    }

    const issued = await app.server.inject({
      method: "POST",
      url: "/auth/session-token",
      headers: {
        "x-server-credential": "server-credential"
      },
      payload: {
        externalUserId: "customer-jane",
        displayLabel: "Jane Reviewer",
        email: "jane@example.test",
        emailVerified: true,
        roles: ["user"],
        permissionRefs: ["demo-tools"]
      }
    });
    expect(issued.statusCode).toBe(200);
    const token = (issued.json() as { chatSessionToken: string }).chatSessionToken;

    const createdConversation = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        title: "Shared context"
      }
    });
    expect(createdConversation.statusCode).toBe(200);
    const conversation = createdConversation.json() as { id: string; ownerUserId: string };
    expect(conversation.ownerUserId).toBe(administeredUser.id);

    const standaloneConversations = await app.server.inject({
      method: "GET",
      url: "/api/conversations",
      headers: {
        "x-dev-user-id": "jane-dev-source"
      }
    });
    expect(standaloneConversations.statusCode).toBe(200);
    expect(standaloneConversations.json()).toEqual([
      expect.objectContaining({
        id: conversation.id,
        ownerUserId: administeredUser.id
      })
    ]);

    const audit = await app.server.inject({
      method: "GET",
      url: "/api/audit-events",
      headers: {
        "x-dev-user-id": "superadmin-1"
      }
    });
    expect(audit.statusCode).toBe(200);
    expect((audit.json() as Array<{ type: string }>).map((event) => event.type)).toEqual(
      expect.arrayContaining(["user.created", "user.identity_upserted"])
    );

    await app.close();
  });

  it("automatically links identities with a matching verified email to one shared user", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig({
        sessionToken: {
          issuer: "demo-client-instance",
          ttlSeconds: 900
        },
        developmentAuth: {
          enabled: true,
          defaultUserId: "superadmin-1",
          users: [
            {
              id: "superadmin-1",
              externalUserId: "superadmin-1",
              displayLabel: "Superadmin",
              roles: ["user", "admin", "superadmin"],
              permissionRefs: ["demo-tools"]
            },
            {
              id: "jane-dev-source",
              externalUserId: "jane-dev",
              displayLabel: "Jane Standalone",
              email: "jane@example.test",
              emailVerified: true,
              roles: ["user"],
              permissionRefs: ["demo-tools"]
            }
          ]
        }
      }),
      env: {
        CHAT_SESSION_TOKEN_SECRET: "a-development-session-token-secret",
        CHAT_SERVER_CREDENTIAL: "server-credential"
      },
      storeMode: "memory",
      tools: []
    });

    const created = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/users",
      headers: {
        "x-dev-user-id": "superadmin-1"
      },
      payload: {
        displayLabel: "Jane Reviewer",
        email: "jane@example.test",
        roles: ["user"],
        permissionRefs: ["demo-tools"]
      }
    });
    expect(created.statusCode).toBe(200);
    const administeredUser = created.json() as { id: string };

    const issued = await app.server.inject({
      method: "POST",
      url: "/auth/session-token",
      headers: {
        "x-server-credential": "server-credential"
      },
      payload: {
        externalUserId: "customer-jane",
        displayLabel: "Jane Reviewer",
        email: "jane@example.test",
        emailVerified: true,
        roles: ["user"],
        permissionRefs: ["demo-tools"]
      }
    });
    expect(issued.statusCode).toBe(200);
    const token = (issued.json() as { chatSessionToken: string }).chatSessionToken;

    const createdConversation = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        title: "Shared by verified email"
      }
    });
    expect(createdConversation.statusCode).toBe(200);
    const conversation = createdConversation.json() as { id: string; ownerUserId: string };
    expect(conversation.ownerUserId).toBe(administeredUser.id);

    const standaloneConversations = await app.server.inject({
      method: "GET",
      url: "/api/conversations",
      headers: {
        "x-dev-user-id": "jane-dev-source"
      }
    });
    expect(standaloneConversations.statusCode).toBe(200);
    expect(standaloneConversations.json()).toEqual([
      expect.objectContaining({
        id: conversation.id,
        ownerUserId: administeredUser.id
      })
    ]);

    const audit = await app.server.inject({
      method: "GET",
      url: "/api/audit-events",
      headers: {
        "x-dev-user-id": "superadmin-1"
      }
    });
    expect(audit.statusCode).toBe(200);
    expect((audit.json() as Array<{ type: string }>).map((event) => event.type)).toEqual(
      expect.arrayContaining(["user.identity_linked"])
    );

    const duplicate = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/users",
      headers: {
        "x-dev-user-id": "superadmin-1"
      },
      payload: {
        displayLabel: "Jane Duplicate",
        email: "jane@example.test",
        roles: ["user"],
        permissionRefs: ["demo-tools"]
      }
    });
    expect(duplicate.statusCode).toBe(200);

    const ambiguousIssued = await app.server.inject({
      method: "POST",
      url: "/auth/session-token",
      headers: {
        "x-server-credential": "server-credential"
      },
      payload: {
        externalUserId: "customer-jane-other",
        displayLabel: "Jane Other",
        email: "jane@example.test",
        emailVerified: true,
        roles: ["user"],
        permissionRefs: ["demo-tools"]
      }
    });
    expect(ambiguousIssued.statusCode).toBe(200);
    const ambiguousToken = (ambiguousIssued.json() as { chatSessionToken: string }).chatSessionToken;

    const ambiguousConversation = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      headers: {
        authorization: `Bearer ${ambiguousToken}`
      },
      payload: {
        title: "Ambiguous email must not share history"
      }
    });
    expect(ambiguousConversation.statusCode).toBe(200);
    expect((ambiguousConversation.json() as { ownerUserId: string }).ownerUserId).not.toBe(
      administeredUser.id
    );

    await app.close();
  });

  it("rejects password resets when standalone auth is not enabled", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const created = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/users",
      payload: {
        displayLabel: "Jane Reviewer",
        roles: ["user"]
      }
    });
    expect(created.statusCode).toBe(200);
    const administeredUser = created.json() as { id: string };

    const reset = await app.server.inject({
      method: "POST",
      url: `/api/superadmin/users/${administeredUser.id}/password`,
      payload: {
        password: "replacement-password"
      }
    });
    expect(reset.statusCode).toBe(422);
    expect((reset.json() as { error: { message: string } }).error.message).toContain(
      "standalone auth"
    );

    await app.close();
  });

  it("rejects startup when an agent references an unregistered tool implementation", async () => {
    await expect(
      createClientInstanceApp({
        config: createTestConfig({
          tools: [{ name: "demo.echo", enabled: true }],
          toolNames: ["demo.echo"]
        }),
        env: {},
        storeMode: "memory",
        tools: []
      })
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Client instance assembly is invalid"
    });
  });

  it("rejects startup without DATABASE_URL unless memory mode is explicit", async () => {
    await expect(
      createClientInstanceApp({
        config: createTestConfig(),
        env: {},
        tools: []
      })
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message:
        "DATABASE_URL is required for the platform store; set STORE=memory only for explicit local/test memory mode"
    });
  });

  it("rejects startup when an enabled tool requires approval before resume support exists", async () => {
    const approvalTool = defineTool({
      name: "demo.approval",
      description: "Approval-only test tool.",
      inputSchema: z.object({}),
      permission: {
        mode: "approval_required",
        reason: "Needs approval"
      },
      async execute() {
        return toolSuccess({});
      }
    });

    await expect(
      createClientInstanceApp({
        config: createTestConfig({
          tools: [{ name: "demo.approval", enabled: true }],
          toolNames: ["demo.approval"]
        }),
        env: {},
        storeMode: "memory",
        tools: [approvalTool]
      })
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Client instance assembly is invalid"
    });
  });

  it("rejects spend budgets without pricing for configured provider models", () => {
    expect(() =>
      createTestConfig({
        modelProviders: [
          {
            id: "openai",
            type: "openai-compatible",
            model: "gpt-4.1",
            baseUrl: "https://api.openai.com/v1",
            apiKeyEnvName: "OPENAI_API_KEY"
          }
        ],
        usageBudget: {
          monthlySpendLimit: 200,
          costSafetyMultiplier: 1.3
        },
        usagePricing: {
          currency: "USD",
          models: []
        }
      })
    ).toThrow("Monthly spend budget requires configured pricing for model openai/gpt-4.1");
  });
});

type LocalizedTestString =
  | string
  | {
      en?: string;
      de?: string;
    };

function createTestConfig(input: {
  toolNames?: string[];
  tools?: Array<{ name: string; enabled?: boolean }>;
  displayName?: LocalizedTestString;
  welcomeMessage?: LocalizedTestString;
  initialPrompts?: Array<{ title: LocalizedTestString; prompt: LocalizedTestString }>;
  modelProviders?: Array<
    | { id: string; type: "deterministic"; model: string }
    | {
        id: string;
        type: "openai-compatible";
        model: string;
        baseUrl: string;
        apiKeyEnvName: string;
      }
  >;
  usageBudget?: {
    monthlySpendLimit?: number;
    costSafetyMultiplier?: number;
  };
  usageSafeguards?: UsageSafeguardsConfig;
  usagePricing?: {
    currency: string;
    models: Array<{
      providerId: string;
      model: string;
      inputPricePerMillionTokens: number;
      outputPricePerMillionTokens: number;
    }>;
  };
  developmentAuth?: unknown;
  sessionToken?: unknown;
} = {}) {
  return parseClientInstanceConfig({
    version: 1,
    clientInstance: {
      id: "demo-local",
      displayName: "Demo",
      environment: "development"
    },
    auth: {
      development: input.developmentAuth ?? {
        enabled: true,
        user: {
          id: "user-1",
          externalUserId: "user-1",
          displayLabel: "User",
          roles: ["user", "admin", "superadmin"],
          permissionRefs: ["demo-tools"]
        }
      },
      ...(input.sessionToken ? { sessionToken: input.sessionToken } : {})
    },
    defaultAgentName: "test_agent",
    agents: [
      {
        name: "test_agent",
        displayName: input.displayName ?? "Test Agent",
        ...(input.welcomeMessage ? { welcomeMessage: input.welcomeMessage } : {}),
        instructions: "Use configured tools only.",
        modelProviderId: input.modelProviders?.[0]?.id ?? "local",
        toolNames: input.toolNames ?? [],
        initialPrompts: input.initialPrompts ?? []
      }
    ],
    modelProviders: input.modelProviders ?? [{ id: "local", type: "deterministic", model: "local" }],
    usage: {
      budget: input.usageBudget ?? {},
      safeguards: input.usageSafeguards ?? {},
      pricing: input.usagePricing
    },
    tools: input.tools ?? []
  });
}

function createUserUiMessage(text: string) {
  return {
    id: `user-${Math.random().toString(36).slice(2)}`,
    role: "user",
    parts: [
      {
        type: "text",
        text
      }
    ]
  };
}

function parseSseChunks(text: string): Array<{ type?: string; errorText?: string; delta?: string }> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line !== "[DONE]")
    .map((line) => JSON.parse(line) as { type?: string; errorText?: string; delta?: string });
}

async function waitForAuditEvents(
  server: Awaited<ReturnType<typeof createClientInstanceApp>>["server"],
  type: string
): Promise<Array<{ type: string; metadata?: Record<string, unknown> }>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const audit = await server.inject({
      method: "GET",
      url: "/api/audit-events"
    });
    expect(audit.statusCode).toBe(200);
    const events = audit.json() as Array<{ type: string; metadata?: Record<string, unknown> }>;
    if (events.some((event) => event.type === type)) {
      return events;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return [];
}

function createMultipartFilePayload(input: {
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

function createTestAttachmentCapability(options: {
  onConversationAttachmentsDeleted?(deletion: {
    attachmentCount: number;
    fileObjectKeys: string[];
    artifactObjectKeys: string[];
  }): void;
} = {}): ClientInstanceCapability {
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
        attachments: [{
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
            return attachment;
          },
          async retryDraftAttachment() {
            throw new Error("Retry is not implemented by the test attachment capability");
          },
          async deleteDraftAttachment(input) {
            const conversationAttachments = attachmentsByConversation.get(input.conversationId) ?? [];
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
            const conversationAttachments = attachmentsByConversation.get(input.conversationId) ?? [];
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
        }]
      };
    }
  };
}

function manifestEntryForAttachment(attachment: ConversationAttachment) {
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
        mimeType: attachment.mimeType,
        byteSize: attachment.byteSize,
        format: attachment.format === "txt" ? "txt" : undefined,
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

async function waitForReadyDraftAttachment(
  server: Awaited<ReturnType<typeof createClientInstanceApp>>["server"],
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
