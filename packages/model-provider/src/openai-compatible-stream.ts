import { AppError } from "@vivd-stage/core";
import type { ModelCompletionStreamEvent } from "./types";
import { noReportedUsage, parseJsonObject, toModelUsage } from "./openai-compatible-mapping";
import type { OpenAiCompatibleResponse } from "./openai-compatible-types";

interface OpenAiCompatibleStreamChunk {
  usage?: OpenAiCompatibleResponse["usage"];
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
}

interface OpenAiCompatibleStreamingToolCall {
  id: string;
  name: string;
  arguments: string;
}

export async function* streamOpenAiCompatibleCompletion(
  body: ReadableStream<Uint8Array>,
  toolNameMap: Map<string, string>
): AsyncIterable<ModelCompletionStreamEvent> {
  let text = "";
  let usage = noReportedUsage();
  const toolCalls = new Map<number, Partial<OpenAiCompatibleStreamingToolCall>>();

  for await (const data of readServerSentEventData(body)) {
    if (data === "[DONE]") {
      break;
    }
    const payload = parseStreamChunk(data);
    if (payload.usage) {
      usage = toModelUsage(payload.usage);
    }

    for (const choice of payload.choices ?? []) {
      const delta = choice.delta;
      if (!delta) {
        continue;
      }

      if (delta.content) {
        text += delta.content;
        yield {
          type: "text_delta",
          delta: delta.content
        };
      }

      for (const toolCall of delta.tool_calls ?? []) {
        const existing = toolCalls.get(toolCall.index) ?? { arguments: "" };
        toolCalls.set(toolCall.index, {
          ...existing,
          id: toolCall.id ?? existing.id,
          name: toolCall.function?.name ?? existing.name,
          arguments: `${existing.arguments ?? ""}${toolCall.function?.arguments ?? ""}`
        });
      }
    }
  }

  yield {
    type: "completed",
    completion: {
      text,
      toolCalls: [...toolCalls.values()]
        .filter((toolCall): toolCall is OpenAiCompatibleStreamingToolCall =>
          Boolean(toolCall.id && toolCall.name)
        )
        .map((toolCall) => ({
          toolCallId: toolCall.id,
          toolName: toolNameMap.get(toolCall.name) ?? toolCall.name,
          input: parseJsonObject(toolCall.arguments)
        })),
      usage
    }
  };
}

function parseStreamChunk(data: string): OpenAiCompatibleStreamChunk {
  try {
    return JSON.parse(data) as OpenAiCompatibleStreamChunk;
  } catch {
    throw new AppError("INTERNAL", "Model provider returned invalid stream JSON");
  }
}

async function* readServerSentEventData(
  body: ReadableStream<Uint8Array>
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    yield* readCompleteDataLines(buffer, (remainingBuffer) => {
      buffer = remainingBuffer;
    });
  }

  buffer += decoder.decode();
  yield* readCompleteDataLines(`${buffer}\n`, () => {
    buffer = "";
  });
}

function* readCompleteDataLines(
  buffer: string,
  setRemainingBuffer: (buffer: string) => void
): Iterable<string> {
  let remainingBuffer = buffer;
  let newlineIndex = remainingBuffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = remainingBuffer.slice(0, newlineIndex).trimEnd();
    remainingBuffer = remainingBuffer.slice(newlineIndex + 1);
    if (line.startsWith("data:")) {
      yield line.slice("data:".length).trimStart();
    }
    newlineIndex = remainingBuffer.indexOf("\n");
  }
  setRemainingBuffer(remainingBuffer);
}
