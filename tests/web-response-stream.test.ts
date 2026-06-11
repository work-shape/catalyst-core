import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createClientInstanceApp } from "@vivd-catalyst/client-assembly";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import { sendWebResponse } from "../packages/chat-server/src/routes/better-auth-routes";

describe("web response bridge", () => {
  it("streams response bodies without buffering them first", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      tools: []
    });
    app.server.get("/stream", async (_request, reply) => {
      return sendWebResponse(
        reply,
        new Response(createDelayedStream(), {
          headers: {
            "content-type": "text/plain; charset=utf-8"
          }
        })
      );
    });

    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const address = app.server.server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected Fastify to listen on a TCP port");
      }

      const streamed = await Promise.race([
        openStreamAndReadFirstChunk(`http://127.0.0.1:${address.port}/stream`),
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
        return toolSuccess({ text: input.text }, { modelSummary: input.text });
      }
    });
    const app = await createClientInstanceApp({
      config: createTestConfig({
        toolNames: ["demo.echo"],
        tools: [{ name: "demo.echo", enabled: true }]
      }),
      env: {},
      storeMode: "memory",
      tools: [tool]
    });

    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const address = app.server.server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected Fastify to listen on a TCP port");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const conversationResponse = await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Streaming test" })
      });
      expect(conversationResponse.ok).toBe(true);
      const conversation = (await conversationResponse.json()) as { id: string };

      const chatResponse = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: conversation.id,
          messages: [
            {
              id: "user-message-1",
              role: "user",
              parts: [
                {
                  type: "text",
                  text:
                    "hello streaming one two three four five six seven eight nine ten eleven twelve thirteen fourteen"
                }
              ]
            }
          ]
        })
      });

      expect(chatResponse.ok).toBe(true);
      const reader = chatResponse.body?.getReader();
      expect(reader).toBeDefined();
      const firstChunk = await Promise.race([
        readChunk(reader!),
        delay(250).then(() => undefined)
      ]);
      expect(firstChunk).toContain('"type":"start"');

      const streamText = `${firstChunk}${await readRemaining(reader!)}`;
      const textDeltas = parseSseChunks(streamText)
        .filter((chunk) => chunk.type === "text-delta")
        .map((chunk) => chunk.delta);

      expect(textDeltas.length).toBeGreaterThan(1);
      expect(textDeltas.join("")).toContain("Local agent response");
    } finally {
      await app.close();
    }
  });
});

function parseSseChunks(text: string): Array<{ type?: string; delta?: string }> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line !== "[DONE]")
    .map((line) => JSON.parse(line) as { type?: string; delta?: string });
}

function createTestConfig(input: {
  toolNames?: string[];
  tools?: Array<{ name: string; enabled?: boolean }>;
} = {}) {
  return parseClientInstanceConfig({
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
    defaultAgentName: "test_agent",
    agents: [
      {
        name: "test_agent",
        displayName: "Test Agent",
        instructions: "Test.",
        modelProviderId: "local",
        toolNames: input.toolNames ?? []
      }
    ],
    modelProviders: [{ id: "local", type: "deterministic", model: "deterministic-local" }],
    tools: input.tools ?? []
  });
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
