import { AppError, type ProviderRegion } from "@vivd-catalyst/core";
import type { GoogleAccessTokenSource } from "./google-vertex-auth";
import {
  isVertexAnswerMissing,
  readVertexAnswerPiece,
  toVertexModelUsage,
  toVertexRequest,
  type VertexAnswerPiece
} from "./google-vertex-mapping";
import type { VertexGenerateContentResponse } from "./google-vertex-wire";
import {
  ModelProviderError,
  modelProviderErrorKindForStatus,
  toModelTransportFailure
} from "../model-provider-error";
import { readServerSentEventData } from "../openai-compatible-stream";
import { readProviderErrorMessage, readProviderErrorMetadata } from "../provider-error";
import type {
  ModelAdapterRequest,
  ModelAdapterStreamEvent,
  ModelCapabilities,
  ModelCompletion,
  ModelToolCall
} from "../types";

/**
 * Where Vertex processes a call, by the region the entry states. `eu` is Google's European
 * multi-region with its own host, so a call of an `eu` entry is neither sent to nor processed
 * at another one.
 */
const GOOGLE_VERTEX_ROUTES: Record<ProviderRegion, { location: string; endpoint: string }> = {
  eu: { location: "eu", endpoint: "https://aiplatform.eu.rep.googleapis.com" },
  global: { location: "global", endpoint: "https://aiplatform.googleapis.com" }
};

/**
 * What a Gemini model on Vertex does through this adapter. Web search is not declared: it is a
 * route of its own that an instance has to approve first. Reasoning efforts are not mapped yet.
 * Tool calls are not declared either: Gemini signs a function call with a thought signature and
 * refuses a later turn that sends the call back without it, and this adapter does not carry
 * signatures yet. The mapping of tools is in place and the gateway refuses a call that would
 * use it.
 */
export const GOOGLE_VERTEX_CAPABILITIES: ModelCapabilities = {
  reasoningEfforts: [],
  nativeTools: [],
  toolCalls: false,
  serverCompaction: false,
  continuation: false,
  fastTier: false,
  imageInput: true,
  documentInput: true,
  structuredOutput: true,
  streaming: true
};

export interface GoogleVertexProviderOptions {
  /** The entry's id, for diagnostics. */
  id: string;
  projectId: string;
  region: ProviderRegion;
  tokens: GoogleAccessTokenSource;
}

export class GoogleVertexProvider {
  private readonly options: GoogleVertexProviderOptions;

  constructor(options: GoogleVertexProviderOptions) {
    this.options = options;
  }

  async complete(request: ModelAdapterRequest): Promise<ModelCompletion> {
    const response = await this.post(request, "generateContent");
    const payload = await this.readJson(response);
    const answer = readVertexAnswerPiece(payload);
    // Read before the answer is judged: Vertex bills an answer it blocked or could not form.
    const usage = toVertexModelUsage(payload.usageMetadata);
    this.assertAnswered(answer, response.status, usage);
    return { text: answer.text, toolCalls: answer.toolCalls, sources: [], citations: [], usage };
  }

  async *stream(request: ModelAdapterRequest): AsyncIterable<ModelAdapterStreamEvent> {
    const response = await this.post(request, "streamGenerateContent?alt=sse");
    if (!response.body) {
      throw new AppError("INTERNAL", "Model provider stream returned no response body", {
        providerId: this.options.id
      });
    }
    let text = "";
    const toolCalls: ModelToolCall[] = [];
    let usage = toVertexModelUsage(undefined);
    let ending: VertexAnswerPiece | undefined;

    for await (const data of readServerSentEventData(response.body)) {
      const payload = parseStreamPiece(data);
      const piece = readVertexAnswerPiece(payload);
      if (payload.usageMetadata && (piece.finishReason || !payload.candidates?.length)) {
        // The counts of the whole answer come with its last piece. Handed on at once: a
        // connection that breaks after it keeps them. Counts of an earlier piece are partial
        // and are left out, so a stream that is cut off is estimated from what arrived.
        usage = toVertexModelUsage(payload.usageMetadata);
        yield { type: "usage_reported", usage };
      }
      if (piece.text.length > 0) {
        text += piece.text;
        yield { type: "text_delta", delta: piece.text };
      }
      for (const toolCall of piece.toolCalls) {
        toolCalls.push(toolCall);
        yield {
          type: "tool_call_preparing",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName
        };
        yield { type: "tool_call_input_delta", delta: JSON.stringify(toolCall.input) };
      }
      if (piece.finishReason || piece.blockReason) {
        ending = piece;
      }
    }

    if (!ending) {
      throw new AppError("TIMEOUT", "Model provider stream ended before its answer was complete");
    }
    this.assertAnswered({ ...ending, text, toolCalls }, response.status);
    yield {
      type: "completed",
      completion: { text, toolCalls, sources: [], citations: [], usage }
    };
  }

  /** A request that never got an answer failed on the connection, unless the caller stopped it. */
  private async post(request: ModelAdapterRequest, method: string): Promise<Response> {
    const route = GOOGLE_VERTEX_ROUTES[this.options.region];
    const url = [
      route.endpoint,
      "v1/projects",
      encodeURIComponent(this.options.projectId),
      "locations",
      route.location,
      "publishers/google/models",
      `${encodeURIComponent(request.model)}:${method}`
    ].join("/");
    const token = await this.options.tokens.accessToken(request.signal);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(toVertexRequest(request)),
        signal: request.signal
      });
    } catch (error) {
      throw request.signal?.aborted ? error : toModelTransportFailure(error);
    }
    if (!response.ok) {
      throw await this.providerError(response);
    }
    return response;
  }

  private async readJson(response: Response): Promise<VertexGenerateContentResponse> {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        // The body was cut while it was read.
        throw toModelTransportFailure(error);
      }
      payload = undefined;
    }
    if (!isRecord(payload)) {
      throw new ModelProviderError({
        kind: "invalid_response",
        message: "Model provider returned invalid JSON",
        status: response.status,
        details: { providerId: this.options.id, status: response.status }
      });
    }
    return payload;
  }

  private assertAnswered(
    answer: VertexAnswerPiece,
    status: number,
    usage?: ModelCompletion["usage"]
  ): void {
    if (!isVertexAnswerMissing(answer)) {
      return;
    }
    throw new ModelProviderError({
      kind: "invalid_response",
      message: "Model provider returned no answer",
      status,
      ...(usage?.source === "provider_reported" ? { usage } : {}),
      // Why Vertex gave none, as its own identifier: a block reason or a finish reason.
      providerCode: identifier(answer.blockReason) ?? identifier(answer.finishReason),
      details: { providerId: this.options.id, status }
    });
  }

  private async providerError(response: Response): Promise<ModelProviderError> {
    const payload: unknown = await response.json().catch(() => undefined);
    const metadata = readProviderErrorMetadata(payload, response.headers);
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
    // Vertex names the failure in `status`, such as RESOURCE_EXHAUSTED; `code` repeats the HTTP status.
    const providerCode = identifier(error.status) ?? metadata.providerErrorCode;
    return new ModelProviderError({
      kind: modelProviderErrorKindForStatus(response.status),
      message: "Model provider request failed",
      status: response.status,
      providerCode,
      providerRequestId: metadata.requestId,
      retryAfterMs: metadata.retryAfterMs,
      providerMessage: readProviderErrorMessage(payload),
      details: {
        providerId: this.options.id,
        status: response.status,
        ...(providerCode === undefined ? {} : { providerErrorCode: providerCode }),
        ...(metadata.requestId === undefined ? {} : { requestId: metadata.requestId })
      }
    });
  }
}

function parseStreamPiece(data: string): VertexGenerateContentResponse {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    payload = undefined;
  }
  if (!isRecord(payload)) {
    throw new ModelProviderError({
      kind: "invalid_response",
      message: "Model provider returned invalid stream JSON"
    });
  }
  return payload;
}

/** Only a bounded identifier of a known field crosses the provider boundary. */
function identifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
