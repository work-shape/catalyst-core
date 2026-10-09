import { apiOperations } from "@vivd-catalyst/api-contract";
import {
  type TestInstance as TestServer,
  fetchTestOperation,
  listenTestInstance,
  createTestInstance,
  getTestConfig
} from "./support/test-instance";

import { testOperations } from "./support/operations";

import { describe, expect, it } from "vitest";

import {
  asAgentRunId,
  asClientInstanceId,
  asCollaborationWorkspaceId,
  type AgentAvailability
} from "@vivd-catalyst/core";
import { createTestConfig } from "./support/fixtures";
import {
  injectStartConversationRun,
  drainRunEvents,
  fetchStartConversationRun,
  fetchRunEvents,
  parseSseChunks
} from "./support/chat-server-run-harness";
import {
  createMultipartFilePayload,
  createTestAttachmentCapability,
  waitForReadyDraftAttachment
} from "./support/chat-server-attachment-harness";

describe("client instance app vertical slice", () => {
  it("queues prepared runs when the API uses the worker runtime", async () => {
    const app = await createTestInstance({
      config: createTestConfig(),
      env: {},
      agentRuntimeMode: "worker",
      tools: []
    });
    try {
      const created = await app.call("conversations.create", {
        payload: { title: "Worker dispatch" }
      });
      const conversation = created.json() as { id: string };
      const started = await app.call("conversations.runs.start", {
        params: { conversationId: conversation.id },
        payload: {
          idempotencyKey: "worker-dispatch-key",
          message: { text: "Queue this run" }
        }
      });

      expect(started.statusCode).toBe(200);
      const result = started.json() as { run: { id: string; status: string } };
      expect(result.run.status).toBe("queued");
      expect(
        await app.stores.agentRuns.listRunObservations({
          clientInstanceId: asClientInstanceId(getTestConfig(app).clientInstance.id),
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
    const app = await createTestInstance({
      config: createTestConfig(),
      env: {},
      capabilities: [createTestAttachmentCapability()],
      tools: []
    });

    const created = await app.call("conversations.create", {
      payload: { title: "Public runs API test" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    const baseUrl = await listenTestInstance(app);

    const missingIdempotency = await fetchTestOperation(baseUrl, "conversations.runs.start", {
      params: { conversationId: conversation.id },
      ...{
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          message: { text: "missing idempotency key" }
        })
      }
    });
    expect(missingIdempotency.status).toBe(422);
    await missingIdempotency.text();

    const firstStart = await fetchTestOperation(baseUrl, "conversations.runs.start", {
      params: { conversationId: conversation.id },
      ...{
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          idempotencyKey: "public-existing-run-key",
          message: { text: "start through public run API" }
        })
      }
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
      testOperations["conversations.runs.observe"].buildPath({
        params: { conversationId: conversation.id, runId: firstStartBody.run.id }
      })
    );

    const retryStart = await fetchTestOperation(baseUrl, "conversations.runs.start", {
      params: { conversationId: conversation.id },
      ...{
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          idempotencyKey: "public-existing-run-key",
          message: { text: "this retry must not append" }
        })
      }
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

    const events = await fetchTestOperation(baseUrl, "conversations.runs.observe", {
      params: { conversationId: conversation.id, runId: firstStartBody.run.id }
    });
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
      fetchTestOperation(baseUrl, "conversations.runs.start", {
        params: { conversationId: conversation.id },
        ...{
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            idempotencyKey: "public-existing-run-concurrent-key",
            message: { text: "concurrent public run start should append once" }
          })
        }
      }),
      fetchTestOperation(baseUrl, "conversations.runs.start", {
        params: { conversationId: conversation.id },
        ...{
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            idempotencyKey: "public-existing-run-concurrent-key",
            message: { text: "duplicate concurrent public run start" }
          })
        }
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

    const concurrentEvents = await fetchTestOperation(baseUrl, "conversations.runs.observe", {
      params: { conversationId: conversation.id, runId: concurrentStartBodyA.run.id }
    });
    expect(concurrentEvents.status).toBe(200);
    await concurrentEvents.text();

    const messages = await fetchTestOperation(baseUrl, "conversations.messages.list", {
      params: { conversationId: conversation.id }
    });
    expect(messages.status).toBe(200);
    const userMessages = apiOperations["conversations.messages.list"].response.schema
      .parse(await messages.json())
      .items.filter((message) => message.role === "user");
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
    const uploaded = await app.call("conversations.draft_attachments.upload", {
      params: { conversationId: conversation.id },
      headers: upload.headers,
      payload: upload.payload
    });
    expect(uploaded.statusCode).toBe(200);
    const uploadedBody = uploaded.json() as { attachment: { id: string } };
    await waitForReadyDraftAttachment(app, conversation.id);

    const differentKeyStarts = await Promise.all([
      fetchTestOperation(baseUrl, "conversations.runs.start", {
        params: { conversationId: conversation.id },
        ...{
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            idempotencyKey: "public-existing-run-different-key-a",
            message: { text: "different key start accepted" }
          })
        }
      }),
      fetchTestOperation(baseUrl, "conversations.runs.start", {
        params: { conversationId: conversation.id },
        ...{
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            idempotencyKey: "public-existing-run-different-key-b",
            message: { text: "different key start rejected" }
          })
        }
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
    const differentKeyEvents = await fetchTestOperation(baseUrl, "conversations.runs.observe", {
      params: { conversationId: conversation.id, runId: acceptedDifferentKeyStart.run.id }
    });
    expect(differentKeyEvents.status).toBe(200);
    await differentKeyEvents.text();

    const afterDifferentKeyMessages = await fetchTestOperation(
      baseUrl,
      "conversations.messages.list",
      { params: { conversationId: conversation.id } }
    );
    expect(afterDifferentKeyMessages.status).toBe(200);
    const afterDifferentKeyUserMessages = apiOperations[
      "conversations.messages.list"
    ].response.schema
      .parse(await afterDifferentKeyMessages.json())
      .items.filter((message) => message.role === "user");
    const racedMessages = afterDifferentKeyUserMessages.filter((message) =>
      ["different key start accepted", "different key start rejected"].includes(message.text)
    );
    expect(racedMessages).toEqual([
      expect.objectContaining({
        id: acceptedDifferentKeyStart.userMessage.id,
        text: acceptedDifferentKeyStart.userMessage.text
      })
    ]);
    expect(racedMessages[0]?.metadata).toMatchObject({
      agentRuntime: {
        attachmentManifest: {
          attachments: expect.arrayContaining([
            expect.objectContaining({ attachmentId: uploadedBody.attachment.id })
          ])
        }
      }
    });

    const firstCreateAndStart = await fetchTestOperation(baseUrl, "conversations.runs.create", {
      ...{
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          idempotencyKey: "public-create-run-key",
          conversation: { title: "Created through run command" },
          message: { text: "create and start through public run API" }
        })
      }
    });
    expect(firstCreateAndStart.status).toBe(200);
    const firstCreateAndStartBody = (await firstCreateAndStart.json()) as {
      conversation: { id: string };
      userMessage: { id: string };
      run: { id: string };
    };

    const retryCreateAndStart = await fetchTestOperation(baseUrl, "conversations.runs.create", {
      ...{
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          idempotencyKey: "public-create-run-key",
          conversation: { title: "Should not create another conversation" },
          message: { text: "this retry must not create another run" }
        })
      }
    });
    expect(retryCreateAndStart.status).toBe(200);
    expect(await retryCreateAndStart.json()).toMatchObject({
      conversation: { id: firstCreateAndStartBody.conversation.id },
      userMessage: { id: firstCreateAndStartBody.userMessage.id },
      run: { id: firstCreateAndStartBody.run.id }
    });

    const [concurrentCreateA, concurrentCreateB] = await Promise.all([
      fetchTestOperation(baseUrl, "conversations.runs.create", {
        ...{
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            idempotencyKey: "public-create-run-concurrent-key",
            conversation: { title: "Concurrent create run" },
            message: { text: "concurrent create and start should create once" }
          })
        }
      }),
      fetchTestOperation(baseUrl, "conversations.runs.create", {
        ...{
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            idempotencyKey: "public-create-run-concurrent-key",
            conversation: { title: "Duplicate concurrent create run" },
            message: { text: "duplicate concurrent create and start" }
          })
        }
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
    // The two requests reach the database on separate connections, so either may create the
    // run. Both answer with the one that was created.
    expect([
      "concurrent create and start should create once",
      "duplicate concurrent create and start"
    ]).toContain(concurrentCreateBodyA.userMessage.text);
    expect(concurrentCreateBodyB).toMatchObject({
      conversation: {
        id: concurrentCreateBodyA.conversation.id
      },
      userMessage: {
        id: concurrentCreateBodyA.userMessage.id,
        text: concurrentCreateBodyA.userMessage.text
      },
      run: {
        id: concurrentCreateBodyA.run.id
      }
    });

    const command = await fetchTestOperation(baseUrl, "conversations.runs.command", {
      params: { conversationId: conversation.id, runId: firstStartBody.run.id },
      ...{
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ command: { type: "continue" } })
      }
    });
    expect(command.status).toBe(409);
    await command.text();

    await app.close();
  });

  it("does not disclose or mutate product run routes for the wrong owner", async () => {
    const app = await createTestInstance({
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
      tools: []
    });

    const created = await app.call("conversations.create", {
      headers: {
        "x-dev-user-id": "user-1"
      },
      payload: { title: "Product route owner mismatch" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    const baseUrl = await listenTestInstance(app);

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

    const wrongOwnerEvents = await fetchTestOperation(baseUrl, "conversations.runs.observe", {
      params: { conversationId: conversation.id, runId: runId },
      ...{
        headers: {
          "x-dev-user-id": "user-2"
        }
      }
    });
    expect(wrongOwnerEvents.status).toBe(404);

    const wrongOwnerCancel = await fetchTestOperation(baseUrl, "conversations.runs.cancel", {
      params: { conversationId: conversation.id, runId: runId },
      ...{
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dev-user-id": "user-2"
        },
        body: JSON.stringify({ reason: "wrong owner must not cancel" })
      }
    });
    expect(wrongOwnerCancel.status).toBe(404);
    await wrongOwnerCancel.text();

    expect(
      parseSseChunks(await fetchRunEvents(baseUrl, conversation.id, runId)).some(
        (chunk) => chunk.type === "run_completed"
      )
    ).toBe(true);
    const audit = await app.call("audit_events.list", {});
    expect(audit.statusCode).toBe(200);
    expect(audit.json().items).not.toContainEqual(
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
    const app = await createTestInstance({
      config: createTestConfig(),
      env: {},
      tools: []
    });

    const created = await app.call("conversations.create", { payload: { title: "Cancel test" } });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    const baseUrl = await listenTestInstance(app);

    const started = await fetchStartConversationRun(
      baseUrl,
      conversation.id,
      "cancel this deliberately long enough response"
    );
    const runId = started.run.id;
    const events = await fetchTestOperation(baseUrl, "conversations.runs.observe", {
      params: { conversationId: conversation.id, runId: runId }
    });
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

    const cancelled = await fetchTestOperation(baseUrl, "conversations.runs.cancel", {
      params: { conversationId: conversation.id, runId: runId },
      ...{
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ reason: "test cancellation" })
      }
    });
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

    const auditEvents = await waitForAuditEvents(app, "message.cancelled");
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
    const messages = await fetchTestOperation(baseUrl, "conversations.messages.list", {
      params: { conversationId: conversation.id }
    });
    expect(messages.status).toBe(200);
    const assistantMessages = apiOperations["conversations.messages.list"].response.schema
      .parse(await messages.json())
      .items.filter((message) => message.role === "assistant");
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

    const snapshot = await fetchTestOperation(baseUrl, "conversations.thread.get", {
      params: { conversationId: conversation.id }
    });
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
    const app = await createTestInstance({
      config: createTestConfig(),
      env: {},
      capabilities: [createTestAttachmentCapability()],
      tools: []
    });

    const created = await app.call("conversations.create", {
      payload: { title: "Active run guard" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    const baseUrl = await listenTestInstance(app);

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
    const uploaded = await app.call("conversations.draft_attachments.upload", {
      params: { conversationId: conversation.id },
      headers: upload.headers,
      payload: upload.payload
    });
    expect(uploaded.statusCode).toBe(200);
    const uploadedBody = uploaded.json() as { attachment: { id: string } };
    await waitForReadyDraftAttachment(app, conversation.id);

    const rejectedSend = await fetchTestOperation(baseUrl, "conversations.runs.start", {
      params: { conversationId: conversation.id },
      ...{
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
      }
    });
    expect(rejectedSend.status).toBe(409);
    await rejectedSend.text();
    await fetchRunEvents(baseUrl, conversation.id, firstRun.run.id);

    const messages = await app.call("conversations.messages.list", {
      params: { conversationId: conversation.id }
    });
    expect(messages.statusCode).toBe(200);
    const persistedMessages = messages.json<{ items: Array<{ role: string; text: string }> }>()
      .items;
    const userMessages = persistedMessages.filter((message) => message.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.text).toBe(activePrompt);
    expect(persistedMessages).not.toContainEqual(
      expect.objectContaining({
        role: "user",
        text: "this second send should not be persisted"
      })
    );

    const drafts = await app.call("conversations.draft_attachments.list", {
      params: { conversationId: conversation.id }
    });
    expect(drafts.statusCode).toBe(200);
    expect(drafts.json().items).toContainEqual(
      expect.objectContaining({
        id: uploadedBody.attachment.id,
        status: "ready"
      })
    );

    const audit = await app.call("audit_events.list", {});
    expect(audit.statusCode).toBe(200);
    const messageCreatedEvents = audit
      .json<{ items: Array<{ type: string; metadata?: { conversationId?: string } }> }>()
      .items.filter(
        (event) =>
          event.type === "message.created" && event.metadata?.conversationId === conversation.id
      );
    expect(messageCreatedEvents).toHaveLength(1);

    await app.close();
  });

  it("cancels the current conversation run instead of letting the stream complete in the background", async () => {
    const app = await createTestInstance({
      config: createTestConfig(),
      env: {},
      tools: []
    });

    try {
      const created = await app.call("conversations.create", {
        payload: { title: "Cancel stream test" }
      });
      expect(created.statusCode).toBe(200);
      const conversation = created.json() as { id: string };

      const baseUrl = await listenTestInstance(app);
      const messageTokens = Array.from({ length: 240 }, (_, index) => `cancel-token-${index}`);
      const lateToken = messageTokens.at(-1) ?? "";

      const started = await fetchStartConversationRun(
        baseUrl,
        conversation.id,
        messageTokens.join(" ")
      );
      const runId = started.run.id;

      const cancelled = await fetchTestOperation(baseUrl, "conversations.runs.cancel", {
        params: { conversationId: conversation.id, runId: runId },
        ...{
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ reason: "test cancellation" })
        }
      });
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

      const messages = await fetchTestOperation(baseUrl, "conversations.messages.list", {
        params: { conversationId: conversation.id }
      });
      expect(messages.status).toBe(200);
      const persistedMessages = apiOperations["conversations.messages.list"].response.schema.parse(
        await messages.json()
      ).items;
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
    const app = await createTestInstance({
      config: createTestConfig({
        usageSafeguards: {
          modelCallsPerDay: 1
        }
      }),
      env: {},
      tools: []
    });

    const created = await app.call("conversations.create", {
      payload: { title: "Usage limit test" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    const firstMessage = await injectStartConversationRun(app, conversation.id, "hello", {
      idempotencyKey: "usage-limit-first"
    });
    await drainRunEvents(app, conversation.id, firstMessage.run.id);

    const secondMessage = await injectStartConversationRun(app, conversation.id, "hello again", {
      idempotencyKey: "usage-limit-second"
    });
    const failedEvents = parseSseChunks(
      await drainRunEvents(app, conversation.id, secondMessage.run.id)
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

    const audit = await app.call("audit_events.list", {});
    expect(audit.statusCode).toBe(200);
    expect(audit.json().items).toContainEqual(
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
    const audit = await server.call("audit_events.list", {});
    expect(audit.statusCode).toBe(200);
    const events = audit.json<{
      items: Array<{ type: string; metadata?: Record<string, unknown> }>;
    }>().items;
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
      const messages = await app.call("conversations.messages.list", {
        params: { conversationId: shared }
      });
      expect(messages.json().items).toEqual([]);
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
      const personalBefore = (
        await app.call("conversations.list", {
          query: { collaborationWorkspaceId: personalWorkspaceId }
        })
      ).json<{ items: unknown[] }>().items;
      const createRejected = await app.call("conversations.runs.create", {
        payload: {
          agentName: "shared_only",
          idempotencyKey: "create-rejected",
          message: { text: "Not here" }
        }
      });
      expect(createRejected.statusCode).toBe(404);
      expect(createRejected.json()).toMatchObject(notDefined("shared_only"));
      expect(
        (
          await app.call("conversations.list", {
            query: { collaborationWorkspaceId: personalWorkspaceId }
          })
        ).json().items
      ).toHaveLength(personalBefore.length);
      const createAllowed = await app.call("conversations.runs.create", {
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
      await app.stores.configAssets.applyConfigAssetMutations({
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
        app.stores.agentRuns.getAgentRun({ clientInstanceId, runId: asAgentRunId(run.id) })
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
      const shared = await app.call("workspaces.agents.list", {
        params: { collaborationWorkspaceId: sharedWorkspaceId }
      });
      expect(shared.statusCode).toBe(200);
      expect(shared.json()).toMatchObject({
        defaultAgentName: "test_agent",
        items: [{ name: "shared_only" }, { name: "test_agent", displayName: "Test Agent" }]
      });
      expect(Object.keys((shared.json() as { items: object[] }).items[0]!).sort()).toEqual([
        "displayName",
        "initialPrompts",
        "name",
        "selectableModels"
      ]);

      const personal = await app.call("workspaces.agents.list", {
        params: { collaborationWorkspaceId: personalWorkspaceId }
      });
      expect(
        (personal.json() as { items: Array<{ name: string }> }).items.map((agent) => agent.name)
      ).toEqual(["personal_only", "test_agent"]);

      // The instance-wide list is the caller's Personal Workspace view.
      const config = await app.call("config.get", {});
      expect(config.json()).toMatchObject({ defaultAgentName: "test_agent" });
      expect(
        (config.json() as { agents: Array<{ name: string }> }).agents.map((agent) => agent.name)
      ).toEqual(["personal_only", "test_agent"]);

      for (const collaborationWorkspaceId of [
        sharedWorkspaceId,
        personalWorkspaceId,
        "cws_missing"
      ]) {
        const outsider = await app.call("workspaces.agents.list", {
          params: { collaborationWorkspaceId },
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
  const app = await createTestInstance({
    config: createTestConfig({
      developmentAuth: {
        enabled: true,
        defaultUserId: "owner",
        users: [identity("owner", ["user", "admin"]), identity("outsider", ["user"])]
      }
    }),
    env: {},
    agentRuntimeMode: "worker",
    tools: []
  });
  const clientInstanceId = asClientInstanceId(getTestConfig(app).clientInstance.id);
  const created = await app.call("workspaces.create", { payload: { name: "KAI" } });
  expect(created.statusCode).toBe(200);
  const sharedWorkspaceId = (created.json() as { id: string }).id;
  expect((await app.call("workspaces.ensure_personal", {})).statusCode).toBe(200);
  const workspaces = (await app.call("workspaces.list", {})).json<{
    items: Array<{
      id: string;
      kind: string;
    }>;
  }>().items;
  const personalWorkspaceId = workspaces.find((workspace) => workspace.kind === "personal")!.id;

  const setAvailability = (agentName: string, availability: AgentAvailability) =>
    app.stores.configAssets.setAgentAvailability({ clientInstanceId, agentName, availability });
  const names = ["shared_only", "personal_only", "hidden"];
  await app.stores.configAssets.applyConfigAssetMutations({
    clientInstanceId,
    mutations: names.map((name) => ({
      type: "upsert" as const,
      kind: "agent" as const,
      name,
      config: {
        skillNames: [],
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
      const response = await app.call("conversations.create", {
        payload: { title: "Availability", collaborationWorkspaceId }
      });
      expect(response.statusCode).toBe(200);
      return (response.json() as { id: string }).id;
    },
    startRun(conversationId: string, agentName?: string) {
      runCount += 1;
      return app.call("conversations.runs.start", {
        params: { conversationId: conversationId },
        payload: {
          agentName,
          idempotencyKey: `availability-run-${runCount}`,
          message: { text: "Hello" }
        }
      });
    }
  };
}
