import { describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import {
  asAgentRunId,
  asClientInstanceId,
  asCollaborationWorkspaceId,
  type AgentAvailability
} from "@vivd-catalyst/core";
import { createTestConfig, createClientInstanceApp, type TestServer } from "./chat-server-harness";
import {
  injectStartConversationRun,
  drainRunEvents,
  fetchStartConversationRun,
  fetchRunEvents,
  parseSseChunks
} from "./chat-server-run-harness";
import {
  createMultipartFilePayload,
  createTestAttachmentCapability,
  waitForReadyDraftAttachment
} from "./chat-server-attachment-harness";

describe("client instance app vertical slice", () => {
  it("queues prepared runs when the API uses the worker runtime", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      agentRuntimeMode: "worker",
      tools: []
    });
    try {
      const created = await app.server.inject({
        method: "POST",
        url: "/api/conversations",
        payload: { title: "Worker dispatch" }
      });
      const conversation = created.json() as { id: string };
      const started = await app.server.inject({
        method: "POST",
        url: `/api/conversations/${conversation.id}/runs`,
        payload: {
          idempotencyKey: "worker-dispatch-key",
          message: { text: "Queue this run" }
        }
      });

      expect(started.statusCode).toBe(200);
      const result = started.json() as { run: { id: string; status: string } };
      expect(result.run.status).toBe("queued");
      expect(
        await app.store.listRunObservations({
          clientInstanceId: asClientInstanceId(app.config.clientInstance.id),
          runId: asAgentRunId(result.run.id),
          afterSequence: 0,
          limit: 10
        })
      ).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("exposes idempotent public Agent Runs start APIs and product SSE ids", async () => {
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
      payload: { title: "Public runs API test" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    await app.server.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const missingIdempotency = await fetch(`${baseUrl}/api/conversations/${conversation.id}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        message: { text: "missing idempotency key" }
      })
    });
    expect(missingIdempotency.status).toBe(422);
    await missingIdempotency.text();

    const firstStart = await fetch(`${baseUrl}/api/conversations/${conversation.id}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        idempotencyKey: "public-existing-run-key",
        message: { text: "start through public run API" }
      })
    });
    expect(firstStart.status).toBe(200);
    const firstStartBody = (await firstStart.json()) as {
      conversation: { id: string };
      userMessage: { id: string; text: string };
      run: { id: string };
      thread: { conversation: { id: string } };
      eventsUrl: string;
    };
    expect(firstStartBody).toMatchObject({
      thread: {
        conversation: {
          id: conversation.id
        }
      }
    });
    expect(firstStartBody.eventsUrl).toContain(
      `/api/conversations/${conversation.id}/runs/${firstStartBody.run.id}/events`
    );

    const retryStart = await fetch(`${baseUrl}/api/conversations/${conversation.id}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        idempotencyKey: "public-existing-run-key",
        message: { text: "this retry must not append" }
      })
    });
    expect(retryStart.status).toBe(200);
    expect(await retryStart.json()).toMatchObject({
      conversation: { id: conversation.id },
      userMessage: {
        id: firstStartBody.userMessage.id,
        text: "start through public run API"
      },
      run: { id: firstStartBody.run.id }
    });

    const events = await fetch(
      `${baseUrl}/api/conversations/${conversation.id}/runs/${firstStartBody.run.id}/events`
    );
    expect(events.status).toBe(200);
    const eventPayload = await events.text();
    expect(eventPayload).toContain("id: 1\n");
    const observations = parseSseChunks(eventPayload);
    expect(observations).toContainEqual(
      expect.objectContaining({
        runId: firstStartBody.run.id,
        conversationId: conversation.id,
        type: "run_completed",
        payload: expect.objectContaining({
          type: "run_completed"
        })
      })
    );
    expect(observations).not.toContainEqual(
      expect.objectContaining({
        type: "text-delta"
      })
    );

    const [concurrentStartA, concurrentStartB] = await Promise.all([
      fetch(`${baseUrl}/api/conversations/${conversation.id}/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          idempotencyKey: "public-existing-run-concurrent-key",
          message: { text: "concurrent public run start should append once" }
        })
      }),
      fetch(`${baseUrl}/api/conversations/${conversation.id}/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          idempotencyKey: "public-existing-run-concurrent-key",
          message: { text: "duplicate concurrent public run start" }
        })
      })
    ]);
    expect(concurrentStartA.status).toBe(200);
    expect(concurrentStartB.status).toBe(200);
    const concurrentStartBodyA = (await concurrentStartA.json()) as {
      userMessage: { id: string; text: string };
      run: { id: string };
    };
    const concurrentStartBodyB = (await concurrentStartB.json()) as {
      userMessage: { id: string; text: string };
      run: { id: string };
    };
    expect(concurrentStartBodyB).toMatchObject({
      userMessage: {
        id: concurrentStartBodyA.userMessage.id,
        text: concurrentStartBodyA.userMessage.text
      },
      run: {
        id: concurrentStartBodyA.run.id
      }
    });
    expect([
      "concurrent public run start should append once",
      "duplicate concurrent public run start"
    ]).toContain(concurrentStartBodyA.userMessage.text);

    const concurrentEvents = await fetch(
      `${baseUrl}/api/conversations/${conversation.id}/runs/${concurrentStartBodyA.run.id}/events`
    );
    expect(concurrentEvents.status).toBe(200);
    await concurrentEvents.text();

    const messages = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`);
    expect(messages.status).toBe(200);
    const userMessages = ((await messages.json()) as Array<{ role: string; text: string }>).filter(
      (message) => message.role === "user"
    );
    expect(userMessages).toEqual([
      expect.objectContaining({
        text: "start through public run API"
      }),
      expect.objectContaining({
        text: concurrentStartBodyA.userMessage.text
      })
    ]);

    const upload = createMultipartFilePayload({
      fieldName: "file",
      filename: "different-key-race-draft.txt",
      contentType: "text/plain",
      content: "This draft should only be claimed by the accepted run start."
    });
    const uploaded = await app.server.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/draft-attachments`,
      headers: upload.headers,
      payload: upload.payload
    });
    expect(uploaded.statusCode).toBe(200);
    const uploadedBody = uploaded.json() as { attachment: { id: string } };
    await waitForReadyDraftAttachment(app.server, conversation.id);

    const differentKeyStarts = await Promise.all([
      fetch(`${baseUrl}/api/conversations/${conversation.id}/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          idempotencyKey: "public-existing-run-different-key-a",
          message: { text: "different key start accepted" }
        })
      }),
      fetch(`${baseUrl}/api/conversations/${conversation.id}/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          idempotencyKey: "public-existing-run-different-key-b",
          message: { text: "different key start rejected" }
        })
      })
    ]);
    const acceptedDifferentKeyStarts = differentKeyStarts.filter(
      (response) => response.status === 200
    );
    const rejectedDifferentKeyStarts = differentKeyStarts.filter(
      (response) => response.status === 409
    );
    expect(acceptedDifferentKeyStarts).toHaveLength(1);
    expect(rejectedDifferentKeyStarts).toHaveLength(1);
    const acceptedDifferentKeyStart = (await acceptedDifferentKeyStarts[0]?.json()) as {
      userMessage: { id: string; text: string };
      run: { id: string };
    };
    await rejectedDifferentKeyStarts[0]?.text();
    const differentKeyEvents = await fetch(
      `${baseUrl}/api/conversations/${conversation.id}/runs/${acceptedDifferentKeyStart.run.id}/events`
    );
    expect(differentKeyEvents.status).toBe(200);
    await differentKeyEvents.text();

    const afterDifferentKeyMessages = await fetch(
      `${baseUrl}/api/conversations/${conversation.id}/messages`
    );
    expect(afterDifferentKeyMessages.status).toBe(200);
    const afterDifferentKeyUserMessages = (
      (await afterDifferentKeyMessages.json()) as Array<{
        id: string;
        role: string;
        text: string;
        metadata?: {
          agentRuntime?: {
            attachmentManifest?: {
              attachments?: Array<{ attachmentId?: string }>;
            };
          };
        };
      }>
    ).filter((message) => message.role === "user");
    const racedMessages = afterDifferentKeyUserMessages.filter((message) =>
      ["different key start accepted", "different key start rejected"].includes(message.text)
    );
    expect(racedMessages).toEqual([
      expect.objectContaining({
        id: acceptedDifferentKeyStart.userMessage.id,
        text: acceptedDifferentKeyStart.userMessage.text
      })
    ]);
    expect(
      racedMessages[0]?.metadata?.agentRuntime?.attachmentManifest?.attachments
    ).toContainEqual(
      expect.objectContaining({
        attachmentId: uploadedBody.attachment.id
      })
    );

    const firstCreateAndStart = await fetch(`${baseUrl}/api/conversations/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        idempotencyKey: "public-create-run-key",
        conversation: { title: "Created through run command" },
        message: { text: "create and start through public run API" }
      })
    });
    expect(firstCreateAndStart.status).toBe(200);
    const firstCreateAndStartBody = (await firstCreateAndStart.json()) as {
      conversation: { id: string };
      userMessage: { id: string };
      run: { id: string };
    };

    const retryCreateAndStart = await fetch(`${baseUrl}/api/conversations/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        idempotencyKey: "public-create-run-key",
        conversation: { title: "Should not create another conversation" },
        message: { text: "this retry must not create another run" }
      })
    });
    expect(retryCreateAndStart.status).toBe(200);
    expect(await retryCreateAndStart.json()).toMatchObject({
      conversation: { id: firstCreateAndStartBody.conversation.id },
      userMessage: { id: firstCreateAndStartBody.userMessage.id },
      run: { id: firstCreateAndStartBody.run.id }
    });

    const [concurrentCreateA, concurrentCreateB] = await Promise.all([
      fetch(`${baseUrl}/api/conversations/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          idempotencyKey: "public-create-run-concurrent-key",
          conversation: { title: "Concurrent create run" },
          message: { text: "concurrent create and start should create once" }
        })
      }),
      fetch(`${baseUrl}/api/conversations/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          idempotencyKey: "public-create-run-concurrent-key",
          conversation: { title: "Duplicate concurrent create run" },
          message: { text: "duplicate concurrent create and start" }
        })
      })
    ]);
    expect(concurrentCreateA.status).toBe(200);
    expect(concurrentCreateB.status).toBe(200);
    const concurrentCreateBodyA = (await concurrentCreateA.json()) as {
      conversation: { id: string };
      userMessage: { id: string; text: string };
      run: { id: string };
    };
    const concurrentCreateBodyB = (await concurrentCreateB.json()) as {
      conversation: { id: string };
      userMessage: { id: string; text: string };
      run: { id: string };
    };
    expect(concurrentCreateBodyB).toMatchObject({
      conversation: {
        id: concurrentCreateBodyA.conversation.id
      },
      userMessage: {
        id: concurrentCreateBodyA.userMessage.id,
        text: "concurrent create and start should create once"
      },
      run: {
        id: concurrentCreateBodyA.run.id
      }
    });

    const command = await fetch(
      `${baseUrl}/api/conversations/${conversation.id}/runs/${firstStartBody.run.id}/commands`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ command: { type: "continue" } })
      }
    );
    expect(command.status).toBe(409);
    await command.text();

    await app.close();
  });

  it("does not disclose or mutate product run routes for the wrong owner", async () => {
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
              roles: ["user", "admin", "superadmin"],
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
      payload: { title: "Product route owner mismatch" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    await app.server.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const started = await fetchStartConversationRun(
      baseUrl,
      conversation.id,
      "wrong owner product route checks should not cancel this run",
      {
        headers: {
          "x-dev-user-id": "user-1"
        }
      }
    );
    const runId = started.run.id;

    const wrongOwnerEvents = await fetch(
      `${baseUrl}/api/conversations/${conversation.id}/runs/${runId}/events`,
      {
        headers: {
          "x-dev-user-id": "user-2"
        }
      }
    );
    expect(wrongOwnerEvents.status).toBe(404);

    const wrongOwnerCancel = await fetch(
      `${baseUrl}/api/conversations/${conversation.id}/runs/${runId}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dev-user-id": "user-2"
        },
        body: JSON.stringify({ reason: "wrong owner must not cancel" })
      }
    );
    expect(wrongOwnerCancel.status).toBe(404);
    await wrongOwnerCancel.text();

    expect(
      parseSseChunks(await fetchRunEvents(baseUrl, conversation.id, runId)).some(
        (chunk) => chunk.type === "run_completed"
      )
    ).toBe(true);
    const audit = await app.server.inject({
      method: "GET",
      url: "/api/audit-events"
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json()).not.toContainEqual(
      expect.objectContaining({
        type: "message.cancelled",
        metadata: expect.objectContaining({
          runId
        })
      })
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

    const started = await fetchStartConversationRun(
      baseUrl,
      conversation.id,
      "cancel this deliberately long enough response"
    );
    const runId = started.run.id;
    const events = await fetch(
      `${baseUrl}/api/conversations/${conversation.id}/runs/${runId}/events`
    );
    expect(events.status).toBe(200);
    const sentReader = events.body?.getReader();
    expect(sentReader).toBeDefined();
    const sentDecoder = new TextDecoder();
    let sentPayload = "";
    while (!sentPayload.includes('"type":"message_delta"')) {
      const next = await sentReader!.read();
      expect(next.done).toBe(false);
      sentPayload += sentDecoder.decode(next.value, { stream: true });
    }

    const cancelled = await fetch(
      `${baseUrl}/api/conversations/${conversation.id}/runs/${runId}/cancel`,
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
    while (true) {
      const next = await sentReader!.read();
      if (next.done) {
        sentPayload += sentDecoder.decode();
        break;
      }
      sentPayload += sentDecoder.decode(next.value, { stream: true });
    }

    const auditEvents = await waitForAuditEvents(app.server, "message.cancelled");
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        type: "message.cancelled",
        metadata: expect.objectContaining({
          runId,
          reason: "test cancellation"
        })
      })
    );

    const streamedPrefix = parseSseChunks(sentPayload)
      .filter((chunk) => chunk.type === "message_delta")
      .map((chunk) => chunk.payload?.delta ?? "")
      .join("");
    expect(streamedPrefix.length).toBeGreaterThan(0);
    const messages = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`);
    expect(messages.status).toBe(200);
    const assistantMessages = (
      (await messages.json()) as Array<{
        role: string;
        text: string;
        metadata?: { agentRuntime?: Record<string, unknown> };
      }>
    ).filter((message) => message.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]).toMatchObject({
      text: streamedPrefix,
      metadata: {
        agentRuntime: {
          kind: "assistant_final",
          runId,
          finishStatus: "cancelled",
          cancellationReason: "test cancellation"
        }
      }
    });

    const snapshot = await fetch(`${baseUrl}/api/conversations/${conversation.id}/thread`);
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({
      messages: [
        expect.objectContaining({
          role: "user"
        }),
        expect.objectContaining({
          role: "assistant",
          text: streamedPrefix
        })
      ]
    });

    await app.close();
  });

  it("rejects a second send during an active run before appending a user message or claiming drafts", async () => {
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
      payload: { title: "Active run guard" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    await app.server.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const activePrompt = Array.from({ length: 40 }, (_, index) => `token-${index}`).join(" ");
    const firstRun = await fetchStartConversationRun(baseUrl, conversation.id, activePrompt, {
      idempotencyKey: "active-run-first"
    });

    const upload = createMultipartFilePayload({
      fieldName: "file",
      filename: "second-send-draft.txt",
      contentType: "text/plain",
      content: "This draft must remain unclaimed when the send is rejected."
    });
    const uploaded = await app.server.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/draft-attachments`,
      headers: upload.headers,
      payload: upload.payload
    });
    expect(uploaded.statusCode).toBe(200);
    const uploadedBody = uploaded.json() as { attachment: { id: string } };
    await waitForReadyDraftAttachment(app.server, conversation.id);

    const rejectedSend = await fetch(`${baseUrl}/api/conversations/${conversation.id}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        idempotencyKey: "active-run-second",
        message: {
          text: "this second send should not be persisted"
        }
      })
    });
    expect(rejectedSend.status).toBe(409);
    await rejectedSend.text();
    await fetchRunEvents(baseUrl, conversation.id, firstRun.run.id);

    const messages = await app.server.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/messages`
    });
    expect(messages.statusCode).toBe(200);
    const persistedMessages = messages.json() as Array<{ role: string; text: string }>;
    const userMessages = persistedMessages.filter((message) => message.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.text).toBe(activePrompt);
    expect(persistedMessages).not.toContainEqual(
      expect.objectContaining({
        role: "user",
        text: "this second send should not be persisted"
      })
    );

    const drafts = await app.server.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/draft-attachments`
    });
    expect(drafts.statusCode).toBe(200);
    expect(drafts.json()).toContainEqual(
      expect.objectContaining({
        id: uploadedBody.attachment.id,
        status: "ready"
      })
    );

    const audit = await app.server.inject({
      method: "GET",
      url: "/api/audit-events"
    });
    expect(audit.statusCode).toBe(200);
    const messageCreatedEvents = (
      audit.json() as Array<{ type: string; metadata?: { conversationId?: string } }>
    ).filter(
      (event) =>
        event.type === "message.created" && event.metadata?.conversationId === conversation.id
    );
    expect(messageCreatedEvents).toHaveLength(1);

    await app.close();
  });

  it("cancels the current conversation run instead of letting the stream complete in the background", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      tools: []
    });

    try {
      const created = await app.server.inject({
        method: "POST",
        url: "/api/conversations",
        payload: { title: "Cancel stream test" }
      });
      expect(created.statusCode).toBe(200);
      const conversation = created.json() as { id: string };

      await app.server.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const messageTokens = Array.from({ length: 240 }, (_, index) => `cancel-token-${index}`);
      const lateToken = messageTokens.at(-1) ?? "";

      const started = await fetchStartConversationRun(
        baseUrl,
        conversation.id,
        messageTokens.join(" ")
      );
      const runId = started.run.id;

      const cancelled = await fetch(
        `${baseUrl}/api/conversations/${conversation.id}/runs/${runId}/cancel`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ reason: "test cancellation" })
        }
      );
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toMatchObject({
        run: {
          id: runId,
          status: "cancelled"
        }
      });

      const chunks = parseSseChunks(await fetchRunEvents(baseUrl, conversation.id, runId));
      expect(chunks.some((chunk) => chunk.type === "run_cancelled")).toBe(true);
      expect(chunks.map((chunk) => chunk.payload?.delta ?? "").join("")).not.toContain(lateToken);

      await new Promise((resolve) => {
        setTimeout(resolve, 6_000);
      });

      const messages = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`);
      expect(messages.status).toBe(200);
      const persistedMessages = (await messages.json()) as Array<{ role: string; text: string }>;
      const assistantText = persistedMessages
        .filter((message) => message.role === "assistant")
        .map((message) => message.text)
        .join("\n");
      expect(assistantText).not.toContain(lateToken);
    } finally {
      await app.close();
    }
  }, 12_000);

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

    const firstMessage = await injectStartConversationRun(app.server, conversation.id, "hello", {
      idempotencyKey: "usage-limit-first"
    });
    await drainRunEvents(app.server, conversation.id, firstMessage.run.id);

    const secondMessage = await injectStartConversationRun(
      app.server,
      conversation.id,
      "hello again",
      {
        idempotencyKey: "usage-limit-second"
      }
    );
    const failedEvents = parseSseChunks(
      await drainRunEvents(app.server, conversation.id, secondMessage.run.id)
    );
    expect(failedEvents).toContainEqual(
      expect.objectContaining({
        type: "run_failed",
        payload: expect.objectContaining({
          error: expect.objectContaining({
            message: "Daily model call safeguard has been reached"
          })
        })
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
});

async function waitForAuditEvents(
  server: TestServer,
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

describe("agent availability per Collaboration Workspace", () => {
  it("rejects an agent that is not available in the conversation's workspace", async () => {
    const fixture = await createAvailabilityFixture();
    const { app, sharedWorkspaceId, personalWorkspaceId } = fixture;
    try {
      const notDefined = (agentName: string) => ({
        error: { code: "NOT_FOUND", message: `Agent '${agentName}' is not defined` }
      });

      const shared = await fixture.createConversation(sharedWorkspaceId);
      // Unavailable and unknown agents are indistinguishable, and nothing is persisted.
      for (const agentName of ["personal_only", "hidden", "unknown"]) {
        const rejected = await fixture.startRun(shared, agentName);
        expect(rejected.statusCode).toBe(404);
        expect(rejected.json()).toMatchObject(notDefined(agentName));
      }
      const messages = await app.server.inject({
        method: "GET",
        url: `/api/conversations/${shared}/messages`
      });
      expect(messages.json()).toEqual([]);
      const allowed = await fixture.startRun(shared, "shared_only");
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toMatchObject({ run: { agentName: "shared_only" } });

      const personal = await fixture.createConversation();
      for (const agentName of ["shared_only", "hidden"]) {
        const rejected = await fixture.startRun(personal, agentName);
        expect(rejected.statusCode).toBe(404);
        expect(rejected.json()).toMatchObject(notDefined(agentName));
      }
      const allowedPersonal = await fixture.startRun(personal, "personal_only");
      expect(allowedPersonal.statusCode).toBe(200);
      expect(allowedPersonal.json()).toMatchObject({ run: { agentName: "personal_only" } });

      // The create-and-run entry point applies the same rule before creating anything.
      const listUrl = (workspaceId: string) =>
        `/api/conversations?collaborationWorkspaceId=${workspaceId}`;
      const personalBefore = (
        await app.server.inject({ method: "GET", url: listUrl(personalWorkspaceId) })
      ).json() as unknown[];
      const createRejected = await app.server.inject({
        method: "POST",
        url: "/api/conversations/runs",
        payload: {
          agentName: "shared_only",
          idempotencyKey: "create-rejected",
          message: { text: "Not here" }
        }
      });
      expect(createRejected.statusCode).toBe(404);
      expect(createRejected.json()).toMatchObject(notDefined("shared_only"));
      expect(
        (await app.server.inject({ method: "GET", url: listUrl(personalWorkspaceId) })).json()
      ).toHaveLength(personalBefore.length);
      const createAllowed = await app.server.inject({
        method: "POST",
        url: "/api/conversations/runs",
        payload: {
          agentName: "shared_only",
          idempotencyKey: "create-allowed",
          message: { text: "Here" },
          conversation: { collaborationWorkspaceId: sharedWorkspaceId }
        }
      });
      expect(createAllowed.statusCode).toBe(200);
      expect(createAllowed.json()).toMatchObject({
        conversation: { collaborationWorkspaceId: sharedWorkspaceId },
        run: { agentName: "shared_only" }
      });
    } finally {
      await app.close();
    }
  });

  it("resolves the default agent for the workspace", async () => {
    const fixture = await createAvailabilityFixture();
    const { app, clientInstanceId, sharedWorkspaceId } = fixture;
    try {
      const withDefault = await fixture.startRun(
        await fixture.createConversation(sharedWorkspaceId)
      );
      expect(withDefault.json()).toMatchObject({ run: { agentName: "test_agent" } });

      // Without an instance default available here, the first available agent is used.
      await app.store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [{ type: "setDefaultAgent", agentName: undefined }]
      });
      await fixture.setAvailability("test_agent", SELECTED_NOWHERE);
      const sharedFallback = await fixture.startRun(
        await fixture.createConversation(sharedWorkspaceId)
      );
      expect(sharedFallback.json()).toMatchObject({ run: { agentName: "shared_only" } });
      const personalFallback = await fixture.startRun(await fixture.createConversation());
      expect(personalFallback.json()).toMatchObject({ run: { agentName: "personal_only" } });

      await fixture.setAvailability("personal_only", SELECTED_NOWHERE);
      const nothingAvailable = await fixture.startRun(await fixture.createConversation());
      expect(nothingAvailable.statusCode).toBe(422);
      expect(nothingAvailable.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    } finally {
      await app.close();
    }
  });

  it("keeps the stored agent of a queued run when availability is revoked", async () => {
    const fixture = await createAvailabilityFixture();
    const { app, clientInstanceId, sharedWorkspaceId } = fixture;
    try {
      const started = await fixture.startRun(
        await fixture.createConversation(sharedWorkspaceId),
        "shared_only"
      );
      const { run } = started.json() as { run: { id: string; status: string } };
      expect(run.status).toBe("queued");

      await fixture.setAvailability("shared_only", SELECTED_NOWHERE);

      await expect(
        app.store.getAgentRun({ clientInstanceId, runId: asAgentRunId(run.id) })
      ).resolves.toMatchObject({ agentName: "shared_only", status: "queued" });
      const next = await fixture.startRun(
        await fixture.createConversation(sharedWorkspaceId),
        "shared_only"
      );
      expect(next.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("lists the agents of a workspace for its members only", async () => {
    const fixture = await createAvailabilityFixture();
    const { app, sharedWorkspaceId, personalWorkspaceId } = fixture;
    try {
      const shared = await app.server.inject({
        method: "GET",
        url: `/api/collaboration-workspaces/${sharedWorkspaceId}/agents`
      });
      expect(shared.statusCode).toBe(200);
      expect(shared.json()).toMatchObject({
        defaultAgentName: "test_agent",
        agents: [{ name: "shared_only" }, { name: "test_agent", displayName: "Test Agent" }]
      });
      expect(Object.keys((shared.json() as { agents: object[] }).agents[0]!).sort()).toEqual([
        "displayName",
        "initialPrompts",
        "name",
        "selectableModels"
      ]);

      const personal = await app.server.inject({
        method: "GET",
        url: `/api/collaboration-workspaces/${personalWorkspaceId}/agents`
      });
      expect(
        (personal.json() as { agents: Array<{ name: string }> }).agents.map((agent) => agent.name)
      ).toEqual(["personal_only", "test_agent"]);

      // The instance-wide list is the caller's Personal Workspace view.
      const config = await app.server.inject({ method: "GET", url: "/api/config" });
      expect(config.json()).toMatchObject({ defaultAgentName: "test_agent" });
      expect(
        (config.json() as { agents: Array<{ name: string }> }).agents.map((agent) => agent.name)
      ).toEqual(["personal_only", "test_agent"]);

      for (const url of [
        `/api/collaboration-workspaces/${sharedWorkspaceId}/agents`,
        `/api/collaboration-workspaces/${personalWorkspaceId}/agents`,
        "/api/collaboration-workspaces/cws_missing/agents"
      ]) {
        const outsider = await app.server.inject({
          method: "GET",
          url,
          headers: { "x-dev-user-id": "outsider" }
        });
        expect(outsider.statusCode).toBe(404);
        expect(outsider.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
      }
    } finally {
      await app.close();
    }
  });
});

const SELECTED_NOWHERE: AgentAvailability = {
  mode: "selected",
  personalWorkspaces: false,
  collaborationWorkspaceIds: []
};

/**
 * `test_agent` is the instance default (`all`); the other agents are restricted to the shared
 * workspace, to Personal Workspaces, and to nothing. Runs stay queued (worker runtime).
 */
async function createAvailabilityFixture() {
  const identity = (id: string, roles: string[]) => ({
    id,
    externalUserId: id,
    displayLabel: id,
    email: `${id}@example.test`,
    emailVerified: true,
    roles,
    permissionRefs: []
  });
  const app = await createClientInstanceApp({
    config: createTestConfig({
      developmentAuth: {
        enabled: true,
        defaultUserId: "owner",
        users: [identity("owner", ["user", "admin"]), identity("outsider", ["user"])]
      }
    }),
    env: {},
    storeMode: "memory",
    agentRuntimeMode: "worker",
    tools: []
  });
  const clientInstanceId = asClientInstanceId(app.config.clientInstance.id);
  const created = await app.server.inject({
    method: "POST",
    url: "/api/collaboration-workspaces",
    payload: { name: "KAI" }
  });
  expect(created.statusCode).toBe(200);
  const sharedWorkspaceId = (created.json() as { id: string }).id;
  const workspaces = (
    await app.server.inject({ method: "GET", url: "/api/collaboration-workspaces" })
  ).json() as Array<{ id: string; kind: string }>;
  const personalWorkspaceId = workspaces.find((workspace) => workspace.kind === "personal")!.id;

  const setAvailability = (agentName: string, availability: AgentAvailability) =>
    app.store.setAgentAvailability({ clientInstanceId, agentName, availability });
  const names = ["shared_only", "personal_only", "hidden"];
  await app.store.applyConfigAssetMutations({
    clientInstanceId,
    mutations: names.map((name) => ({
      type: "upsert" as const,
      kind: "agent" as const,
      name,
      config: {
        name,
        displayName: name,
        instructions: "Use configured tools only.",
        modelProviderId: "local",
        toolNames: [],
        initialPrompts: []
      }
    }))
  });
  await setAvailability("shared_only", {
    ...SELECTED_NOWHERE,
    collaborationWorkspaceIds: [asCollaborationWorkspaceId(sharedWorkspaceId)]
  });
  await setAvailability("personal_only", { ...SELECTED_NOWHERE, personalWorkspaces: true });
  await setAvailability("hidden", SELECTED_NOWHERE);

  let runCount = 0;
  return {
    app,
    clientInstanceId,
    sharedWorkspaceId,
    personalWorkspaceId,
    setAvailability,
    async createConversation(collaborationWorkspaceId?: string): Promise<string> {
      const response = await app.server.inject({
        method: "POST",
        url: "/api/conversations",
        payload: { title: "Availability", collaborationWorkspaceId }
      });
      expect(response.statusCode).toBe(200);
      return (response.json() as { id: string }).id;
    },
    startRun(conversationId: string, agentName?: string) {
      runCount += 1;
      return app.server.inject({
        method: "POST",
        url: `/api/conversations/${conversationId}/runs`,
        payload: {
          agentName,
          idempotencyKey: `availability-run-${runCount}`,
          message: { text: "Hello" }
        }
      });
    }
  };
}
