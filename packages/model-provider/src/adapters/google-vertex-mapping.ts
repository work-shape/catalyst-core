import { randomUUID } from "node:crypto";
import type { ModelAdapterRequest, ModelCompletion, ModelContent, ModelToolCall } from "../types";
import { isModelFunctionTool } from "../types";
import type {
  VertexContent,
  VertexGenerateContentRequest,
  VertexGenerateContentResponse,
  VertexPart,
  VertexSchema,
  VertexUsageMetadata
} from "./google-vertex-wire";

/** A call that asks for an answer format is an extraction: it gets the same answer each time. */
const STRUCTURED_OUTPUT_TEMPERATURE = 0;

export function toVertexRequest(request: ModelAdapterRequest): VertexGenerateContentRequest {
  const system: VertexPart[] = [];
  const contents: VertexContent[] = [];
  // A tool result names its call by id; Vertex wants the name of the function instead.
  const toolNames = new Map<string, string>();
  const push = (role: VertexContent["role"], parts: VertexPart[]): void => {
    if (parts.length === 0) return;
    const last = contents.at(-1);
    // Vertex takes the results of calls made together as one turn, and refuses two turns of
    // one role in a row.
    if (last?.role === role) {
      last.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  };

  for (const message of request.messages) {
    if (message.role === "assistant") {
      for (const toolCall of message.toolCalls ?? []) {
        toolNames.set(toolCall.toolCallId, toolCall.toolName);
      }
      push("model", [
        ...toVertexParts(message.content),
        ...(message.toolCalls ?? []).map((toolCall) => ({
          functionCall: {
            name: toolCall.toolName,
            args: isRecord(toolCall.input) ? toolCall.input : {}
          }
        }))
      ]);
    } else if (message.role === "tool") {
      const [result, ...attached] = splitToolResult(message.content);
      push("user", [
        {
          functionResponse: {
            name: toolNames.get(message.toolCallId) ?? message.toolCallId,
            response: { output: result }
          }
        },
        ...attached
      ]);
    } else if (message.role === "system") {
      system.push(...toVertexParts(message.content));
    } else {
      push("user", toVertexParts(message.content));
    }
  }

  const functions = request.tools.filter(isModelFunctionTool);
  return {
    contents,
    ...(system.length > 0 ? { systemInstruction: { parts: system } } : {}),
    ...(functions.length > 0
      ? {
          tools: [
            {
              functionDeclarations: functions.map((tool) => ({
                name: tool.name,
                description: tool.description,
                ...(tool.inputJsonSchema
                  ? { parameters: toVertexSchema(tool.inputJsonSchema) }
                  : {})
              }))
            }
          ]
        }
      : {}),
    ...(request.output
      ? {
          generationConfig: {
            temperature: STRUCTURED_OUTPUT_TEMPERATURE,
            responseMimeType: "application/json",
            responseSchema: toVertexSchema(request.output.jsonSchema)
          }
        }
      : {})
  };
}

function toVertexParts(content: ModelContent): VertexPart[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ text: content }] : [];
  }
  return content.flatMap((part): VertexPart[] => {
    if (part.type === "text") {
      return part.text.length > 0 ? [{ text: part.text }] : [];
    }
    return [
      { inlineData: { mimeType: part.mimeType, data: Buffer.from(part.data).toString("base64") } }
    ];
  });
}

/** The text of a tool result, and what it carries besides text as parts of the same turn. */
function splitToolResult(content: ModelContent): [string, ...VertexPart[]] {
  const parts = toVertexParts(content);
  return [
    parts.map((part) => part.text ?? "").join(""),
    ...parts.filter((part) => part.text === undefined)
  ];
}

const SCHEMA_NUMBER_KEYWORDS = ["minItems", "maxItems", "minimum", "maximum"] as const;

/**
 * A JSON Schema as Vertex takes it: an OpenAPI schema with upper-case types, `nullable` in
 * place of a `null` type, and none of the keywords Vertex refuses, such as
 * `additionalProperties` and `$schema`.
 */
function toVertexSchema(schema: unknown): VertexSchema {
  if (!isRecord(schema)) {
    return {};
  }
  const declared = Array.isArray(schema.type) ? schema.type : [schema.type];
  const types = declared.filter((type): type is string => typeof type === "string");
  const concrete = types.filter((type) => type !== "null");
  const alternatives = [schema.anyOf, schema.oneOf].find(Array.isArray);
  const result: VertexSchema = {};

  if (concrete.length === 1 && concrete[0]) {
    result.type = concrete[0].toUpperCase();
  } else if (concrete.length > 1) {
    result.anyOf = concrete.map((type) => ({ type: type.toUpperCase() }));
  } else if (alternatives) {
    result.anyOf = alternatives.map(toVertexSchema);
  }
  if (types.includes("null") || schema.nullable === true) result.nullable = true;
  if (typeof schema.description === "string") result.description = schema.description;
  if (typeof schema.format === "string") result.format = schema.format;
  if (Array.isArray(schema.enum)) {
    result.enum = schema.enum.filter((value) => value !== null).map(String);
  }
  if (isRecord(schema.properties)) {
    result.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, property]) => [name, toVertexSchema(property)])
    );
    if (Array.isArray(schema.required)) {
      const names = new Set(Object.keys(schema.properties));
      result.required = schema.required.filter(
        (name): name is string => typeof name === "string" && names.has(name)
      );
    }
  }
  if (schema.items !== undefined) result.items = toVertexSchema(schema.items);
  for (const keyword of SCHEMA_NUMBER_KEYWORDS) {
    const value = schema[keyword];
    if (typeof value === "number") result[keyword] = value;
  }
  return result;
}

/** What one response, or one piece of a streamed one, holds of the answer. */
export interface VertexAnswerPiece {
  text: string;
  toolCalls: ModelToolCall[];
  /** Set on the piece that ends the answer. */
  finishReason?: string;
  blockReason?: string;
}

export function readVertexAnswerPiece(payload: VertexGenerateContentResponse): VertexAnswerPiece {
  const candidate = payload.candidates?.[0];
  let text = "";
  const toolCalls: ModelToolCall[] = [];
  for (const part of candidate?.content?.parts ?? []) {
    if (part.functionCall?.name) {
      toolCalls.push({
        // Vertex gives a call no id. The product needs one to tie the result to the call.
        toolCallId: `call_${randomUUID()}`,
        toolName: part.functionCall.name,
        input: isRecord(part.functionCall.args) ? part.functionCall.args : {}
      });
    } else if (typeof part.text === "string" && part.thought !== true) {
      text += part.text;
    }
  }
  return {
    text,
    toolCalls,
    ...(candidate?.finishReason ? { finishReason: candidate.finishReason } : {}),
    ...(payload.promptFeedback?.blockReason
      ? { blockReason: payload.promptFeedback.blockReason }
      : {})
  };
}

/** Finish reasons of an answer that is an answer: complete, or cut at the model's output limit. */
const ANSWERED_FINISH_REASONS: ReadonlySet<string> = new Set(["STOP", "MAX_TOKENS"]);

/** Whether Vertex ended without an answer: blocked, filtered or a function call it could not form. */
export function isVertexAnswerMissing(answer: VertexAnswerPiece): boolean {
  if (answer.text.length > 0 || answer.toolCalls.length > 0) {
    return false;
  }
  return answer.finishReason === undefined || !ANSWERED_FINISH_REASONS.has(answer.finishReason);
}

/**
 * The usage Vertex reported. The prompt count includes what was read from a cache and what tool
 * results added; reasoning is billed as output. Without a prompt count nothing was reported, and
 * the call's cost is then incomplete.
 */
export function toVertexModelUsage(
  usage: VertexUsageMetadata | undefined
): ModelCompletion["usage"] {
  const count = (value: number | undefined): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  if (typeof usage?.promptTokenCount !== "number") {
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      source: "not_reported",
      webSearchCallCount: 0
    };
  }
  const inputTokens = count(usage.promptTokenCount) + count(usage.toolUsePromptTokenCount);
  const outputTokens = count(usage.candidatesTokenCount) + count(usage.thoughtsTokenCount);
  return {
    inputTokens,
    // Vertex leaves the field out when the call read nothing from a cache: that is zero.
    cachedInputTokens: Math.min(count(usage.cachedContentTokenCount), inputTokens),
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    source: "provider_reported",
    webSearchCallCount: 0
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
