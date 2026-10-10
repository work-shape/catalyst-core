import type { TestInstance as TestServer } from "./test-instance";

import { expect } from "vitest";

import { AppError, type AgentRuntime, type RuntimeCallContext } from "@vivd-catalyst/core";

import type { FakeModelProvider as ModelProvider } from "./model-gateway";

export function createMissingRuntime(): AgentRuntime {
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

export function createUnusedModelProvider(): ModelProvider {
  return {
    id: "unused",
    async complete(_request, _context: RuntimeCallContext) {
      throw new AppError("INTERNAL", "Model provider should not be used by recovery tests");
    }
  };
}

interface StartedRunBody {
  conversation: { id: string };
  userMessage: { id: string; text: string };
  run: { id: string; status: string; lastSequence: number };
  eventsUrl: string;
}

export async function injectStartConversationRun(
  server: TestServer,
  conversationId: string,
  text: string,
  options: {
    headers?: Record<string, string>;
    idempotencyKey?: string;
  } = {}
): Promise<StartedRunBody> {
  const response = await server.call("conversations.runs.start", {
    params: { conversationId: conversationId },
    headers: options.headers,
    payload: {
      idempotencyKey: options.idempotencyKey ?? `test-run-${Math.random().toString(36).slice(2)}`,
      message: {
        text
      }
    }
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<StartedRunBody>();
}

export async function drainRunEvents(
  server: TestServer,
  conversationId: string,
  runId: string,
  options: {
    headers?: Record<string, string>;
    afterSequence?: number;
  } = {}
): Promise<string> {
  const response = await server.call("conversations.runs.observe", {
    params: { conversationId, runId },
    query: { after: options.afterSequence },
    headers: options.headers
  });
  expect(response.statusCode).toBe(200);
  return response.payload;
}

export async function fetchStartConversationRun(
  baseUrl: string,
  conversationId: string,
  text: string,
  options: {
    headers?: Record<string, string>;
    idempotencyKey?: string;
  } = {}
): Promise<StartedRunBody> {
  const response = await fetch(`${baseUrl}/api/v1/conversations/${conversationId}/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...options.headers
    },
    body: JSON.stringify({
      idempotencyKey: options.idempotencyKey ?? `test-run-${Math.random().toString(36).slice(2)}`,
      message: {
        text
      }
    })
  });
  expect(response.status).toBe(200);
  return (await response.json()) as StartedRunBody;
}

export async function fetchRunEvents(
  baseUrl: string,
  conversationId: string,
  runId: string
): Promise<string> {
  const response = await fetch(
    `${baseUrl}/api/v1/conversations/${conversationId}/runs/${runId}/events`
  );
  expect(response.status).toBe(200);
  return response.text();
}

export function parseSseChunks(text: string): Array<{
  type?: string;
  sequence?: number;
  runId?: string;
  conversationId?: string;
  payload?: {
    type?: string;
    delta?: string;
    error?: {
      code?: string;
      category?: string;
      message?: string;
    };
  };
}> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line !== "[DONE]")
    .map(
      (line) =>
        JSON.parse(line) as {
          type?: string;
          payload?: { type?: string; delta?: string };
        }
    );
}
