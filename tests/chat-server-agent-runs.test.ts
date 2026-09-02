import { describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import { asAgentRunId, asClientInstanceId } from "@vivd-catalyst/core";
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
