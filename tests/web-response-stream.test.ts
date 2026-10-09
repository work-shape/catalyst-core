import {
  fetchTestOperation,
  addTestRoute,
  listenTestInstance,
  createTestInstance
} from "./support/test-instance";

import { setTestAgent } from "./support/fixtures";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import { sendWebResponse } from "../packages/chat-server/src/routes/better-auth-routes";

describe("web response bridge", () => {
  it("streams response bodies without buffering them first", async () => {
    const app = await createTestInstance({
      config: createTestConfig(),
      env: {},
      tools: []
    });
    addTestRoute(app, "/stream", async (_request, reply) => {
      return sendWebResponse(
        reply,
        new Response(createDelayedStream(), {
          headers: {
            "content-type": "text/plain; charset=utf-8"
          }
        })
      );
    });

    const baseUrl = await listenTestInstance(app);
    try {
      const streamed = await Promise.race([
        openStreamAndReadFirstChunk(`${baseUrl}/stream`),
        delay(250).then(() => undefined)
      ]);

      expect(streamed?.firstChunk).toBe("first\n");
      if (streamed) {
        await drain(streamed.reader);
      }
    } finally {
      await app.close();
    }
  });

  it("streams multiple chat text deltas for tool-capable agents", async () => {
    const tool = defineTool({
      name: "demo.echo",
      description: "Echo text for tests.",
      inputSchema: z.object({ text: z.string() }),
      async execute(input) {
        return toolSuccess({ text: input.text });
      }
    });
    const app = await createTestInstance({
      config: createTestConfig({
        toolNames: ["demo.echo"],
        tools: [{ name: "demo.echo", enabled: true }]
      }),
      env: {},
      tools: [tool]
    });

    const baseUrl = await listenTestInstance(app);
    try {
      const conversationResponse = await fetchTestOperation(baseUrl, "createConversation", {
        ...{
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Streaming test" })
        }
      });
      expect(conversationResponse.ok).toBe(true);
      const conversation = (await conversationResponse.json()) as { id: string };

      const startResponse = await fetchTestOperation(baseUrl, "startConversationRun", {
        params: { conversationId: conversation.id },
        ...{
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            idempotencyKey: "streaming-deltas-run",
            message: {
              text: "hello streaming one two three four five six seven eight nine ten eleven twelve thirteen fourteen"
            }
          })
        }
      });

      expect(startResponse.ok).toBe(true);
      const started = (await startResponse.json()) as { run: { id: string } };
      const eventsResponse = await fetchTestOperation(baseUrl, "observeConversationRun", {
        params: { conversationId: conversation.id, runId: started.run.id }
      });
      expect(eventsResponse.ok).toBe(true);
      const reader = eventsResponse.body?.getReader();
      expect(reader).toBeDefined();
      const firstChunk = await Promise.race([readChunk(reader!), delay(250).then(() => undefined)]);
      expect(firstChunk).toContain('"type":"message_delta"');

      const streamText = `${firstChunk}${await readRemaining(reader!)}`;
      const textDeltas = parseSseChunks(streamText)
        .filter((chunk) => chunk.type === "message_delta")
        .map((chunk) => chunk.payload?.delta);

      expect(textDeltas.length).toBeGreaterThan(1);
      expect(textDeltas.join("")).toContain("Local agent response");
    } finally {
      await app.close();
    }
  });

  it("streams model text and tool inputs for tool-call turns", async () => {
    const tool = defineTool({
      name: "demo.echo",
      description: "Echo text for tests.",
      inputSchema: z.object({ text: z.string() }),
      async execute(input) {
        return toolSuccess({ text: input.text });
      }
    });
    const app = await createTestInstance({
      config: createTestConfig({
        toolNames: ["demo.echo"],
        tools: [{ name: "demo.echo", enabled: true }]
      }),
      env: {},
      tools: [tool]
    });

    const baseUrl = await listenTestInstance(app);
    try {
      const conversationResponse = await fetchTestOperation(baseUrl, "createConversation", {
        ...{
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Tool streaming test" })
        }
      });
      expect(conversationResponse.ok).toBe(true);
      const conversation = (await conversationResponse.json()) as { id: string };

      const startResponse = await fetchTestOperation(baseUrl, "startConversationRun", {
        params: { conversationId: conversation.id },
        ...{
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            idempotencyKey: "streaming-tool-run",
            message: {
              text: '/tool demo.echo {"text":"hello"}'
            }
          })
        }
      });

      expect(startResponse.ok).toBe(true);
      const started = (await startResponse.json()) as { run: { id: string } };
      const eventsResponse = await fetchTestOperation(baseUrl, "observeConversationRun", {
        params: { conversationId: conversation.id, runId: started.run.id }
      });
      expect(eventsResponse.ok).toBe(true);
      const reader = eventsResponse.body?.getReader();
      expect(reader).toBeDefined();
      const streamText = await readRemaining(reader!);
      const chunks = parseSseChunks(streamText);
      const textDeltas = chunks
        .filter((chunk) => chunk.type === "message_delta")
        .map((chunk) => chunk.payload?.delta);
      const toolInputs = chunks
        .filter((chunk) => chunk.type === "tool_call_started")
        .map((chunk) => chunk.payload?.input);

      expect(textDeltas.join("")).toContain("I will run demo.echo with the provided input.");
      expect(toolInputs).toEqual([{ text: "hello" }]);
    } finally {
      await app.close();
    }
  });
});

function parseSseChunks(
  text: string
): Array<{ type?: string; payload?: { delta?: string; input?: unknown } }> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line !== "[DONE]")
    .map(
      (line) => JSON.parse(line) as { type?: string; payload?: { delta?: string; input?: unknown } }
    );
}

function createTestConfig(
  input: {
    toolNames?: string[];
    tools?: Array<{ name: string; enabled?: boolean }>;
  } = {}
) {
  const config = parseClientInstanceConfig({
    version: 1,
    clientInstance: {
      id: "stream-test",
      displayName: "Stream Test",
      environment: "development"
    },
    auth: {
      development: {
        enabled: true,
        user: {
          id: "user-1",
          externalUserId: "user-1",
          displayLabel: "User",
          roles: ["user"],
          permissionRefs: []
        }
      }
    },
    modelProviders: [{ id: "local", type: "deterministic", model: "deterministic-local" }],
    tools: input.tools ?? []
  });
  setTestAgent(config, {
    name: "test_agent",
    displayName: "Test Agent",
    instructions: "Test.",
    modelProviderId: "local",
    toolNames: input.toolNames ?? []
  });
  return config;
}

async function openStreamAndReadFirstChunk(url: string): Promise<{
  firstChunk: string;
  reader: ReadableStreamDefaultReader<Uint8Array>;
}> {
  const response = await fetch(url);
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Expected a streamed response body");
  }

  const { value } = await reader.read();
  return {
    firstChunk: new TextDecoder().decode(value),
    reader
  };
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  while (true) {
    const { done } = await reader.read();
    if (done) {
      return;
    }
  }
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value } = await reader.read();
  return new TextDecoder().decode(value);
}

async function readRemaining(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return text;
    }
    text += new TextDecoder().decode(value);
  }
}

function createDelayedStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;

  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("first\n"));
      timer = setTimeout(() => {
        controller.enqueue(encoder.encode("second\n"));
        controller.close();
      }, 500);
    },
    cancel() {
      if (timer) {
        clearTimeout(timer);
      }
    }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
