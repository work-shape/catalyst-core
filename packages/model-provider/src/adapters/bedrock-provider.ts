import { AppError, type ProviderCheckContext, type ProviderCheckResult } from "@vivd-catalyst/core";
import { readBedrockEventStream, type BedrockEventStreamMessage } from "./bedrock-event-stream";
import {
  missingBedrockAnswerReason,
  readBedrockAnswer,
  readBedrockToolInput,
  toBedrockModelUsage,
  toBedrockRequest
} from "./bedrock-mapping";
import {
  BEDROCK_REASONING_EFFORTS,
  toBedrockContinuation,
  toBedrockTurnBlock,
  type BedrockTurnBlock
} from "./bedrock-thinking";
import type {
  BedrockMessagesRequest,
  BedrockMessagesResponse,
  BedrockStreamEvent,
  BedrockUsage
} from "./bedrock-wire";
import {
  ModelProviderError,
  boundProviderMessage,
  modelProviderErrorKindForStatus,
  toModelTransportFailure,
  type ModelProviderErrorKind
} from "../model-provider-error";
import { readProviderErrorMetadata } from "../provider-error";
import { parseToolInput } from "../tool-input";
import type {
  ModelAdapterRequest,
  ModelAdapterStreamEvent,
  ModelCapabilities,
  ModelCompletion,
  ModelToolCall
} from "../types";

/**
 * The one region this adapter calls. Bedrock's data retention is set to `none` there and
 * nowhere else, and the EU inference profiles route from it to EU regions only.
 */
export const BEDROCK_REGION = "eu-central-1";
/** The one host this adapter calls. No setting names another. */
export const BEDROCK_RUNTIME_HOST = `bedrock-runtime.${BEDROCK_REGION}.amazonaws.com`;

const BEDROCK_ARN = /^arn:aws:bedrock:([a-z0-9-]*):(\d{12}):([a-z-]+)\/([a-zA-Z0-9.:_-]+)$/u;
const APPLICATION_INFERENCE_PROFILE = "application-inference-profile";

/**
 * Why a model id is not one this adapter calls, or undefined for an application inference
 * profile of the configured account in the adapter's region. A profile of another account is
 * refused before anything is sent: the key would be shown to a resource this instance does not
 * own. Usage on Bedrock is attributed to a consumer by its
 * application inference profile and the consumer's credential may call that alone, so a model id
 * or a shared profile is refused here and never sent. The reason never repeats the id: an ARN
 * holds the account id.
 */
function bedrockModelRefusal(model: string, accountId: string): string | undefined {
  const arn = BEDROCK_ARN.exec(model);
  if (!arn) {
    return "a model id or a shared inference profile such as 'eu.anthropic.…' is not attributed to this consumer";
  }
  if (arn[3] !== APPLICATION_INFERENCE_PROFILE) {
    return "the ARN names a foundation model or a shared inference profile, which is not attributed to this consumer";
  }
  if (arn[1] !== BEDROCK_REGION) {
    return `the profile is in another region, and calls go to ${BEDROCK_REGION} only`;
  }
  if (arn[2] !== accountId) {
    return "the profile belongs to another AWS account than the provider's 'accountId'";
  }
  return undefined;
}

/**
 * What Claude on Bedrock does through this adapter. Web search is not declared: Bedrock has
 * none. A PDF is sent as a document block within the limits `assertBedrockDocuments` holds. An
 * answer format is sent as the Messages format's own `output_config.format`. The continuation
 * carries the thinking of a run's tool-use turns to the run's next request and nothing else.
 * The adapter sets no cache breakpoint and asks for no cache. Every token is billed to the
 * consumer's profile, so a model without a price is not called.
 */
export const BEDROCK_CAPABILITIES: ModelCapabilities = {
  reasoningEfforts: BEDROCK_REASONING_EFFORTS,
  nativeTools: [],
  toolCalls: true,
  serverCompaction: false,
  continuation: true,
  fastTier: false,
  imageInput: true,
  documentInput: true,
  structuredOutput: true,
  streaming: true,
  priceRequired: true
};

export interface BedrockProviderOptions {
  /** The entry's id, for diagnostics. */
  id: string;
  /** The AWS account the instance's profiles belong to. A profile of another one is refused. */
  accountId: string;
  /** The Bedrock API key, sent as a bearer token. */
  bearerToken: string;
}

export class BedrockProvider {
  private readonly options: BedrockProviderOptions;

  constructor(options: BedrockProviderOptions) {
    this.options = options;
  }

  /** Throws a config error for a model this adapter does not call. */
  assertModel(model: string): void {
    const refusal = bedrockModelRefusal(model, this.options.accountId);
    if (refusal !== undefined) {
      throw new AppError(
        "VALIDATION_FAILED",
        `The model of provider '${this.options.id}' must be the ARN of an application inference profile in ${BEDROCK_REGION}: ${refusal}`
      );
    }
  }

  async complete(request: ModelAdapterRequest): Promise<ModelCompletion> {
    const { body, toolNames, thinkingTurns } = toBedrockRequest(request, this.options.id);
    const response = await this.post(request, "invoke", body);
    const payload = await this.readJson(response);
    const { blocks, ...answer } = readBedrockAnswer(payload, toolNames);
    // Read before the answer is judged: Bedrock bills an answer the model refused to give.
    const usage = toBedrockModelUsage(payload.usage);
    this.assertAnswered(answer, payload.stop_reason, response.status, usage);
    const continuation = toBedrockContinuation(this.options.id, thinkingTurns, blocks);
    return {
      ...answer,
      ...(continuation ? { continuation } : {}),
      sources: [],
      citations: [],
      usage
    };
  }

  async *stream(request: ModelAdapterRequest): AsyncIterable<ModelAdapterStreamEvent> {
    const { body, toolNames, thinkingTurns } = toBedrockRequest(request, this.options.id);
    const response = await this.post(request, "invoke-with-response-stream", body);
    if (!response.body) {
      throw new AppError("INTERNAL", "Model provider stream returned no response body", {
        providerId: this.options.id
      });
    }
    let text = "";
    // The tool calls of the answer by the index of their block, with the input as it arrives.
    const toolCalls = new Map<number, { id: string; name: string; given: unknown; json: string }>();
    // The text and thinking blocks of the answer by their index, as they arrive.
    const written = new Map<
      number,
      { type?: string; text: string; signature: string; data?: string }
    >();
    let started: BedrockUsage | undefined;
    let usage = toBedrockModelUsage(undefined);
    let stopReason: string | null | undefined;
    let stopped = false;

    for await (const message of readBedrockEventStream(response.body)) {
      const event = this.readStreamEvent(message);
      if (event === undefined) continue;
      if (event.type === "message_start") {
        started = isRecord(event.message?.usage) ? event.message.usage : undefined;
      } else if (event.type === "content_block_start" && typeof event.index === "number") {
        const block = event.content_block;
        if (
          block?.type === "tool_use" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          const name = toolNames.productNameFor(block.name);
          toolCalls.set(event.index, { id: block.id, name, given: block.input, json: "" });
          yield { type: "tool_call_preparing", toolCallId: block.id, toolName: name };
        } else if (block) {
          written.set(event.index, {
            type: block.type,
            text: "",
            signature: typeof block.signature === "string" ? block.signature : "",
            ...(typeof block.data === "string" ? { data: block.data } : {})
          });
        }
      } else if (event.type === "content_block_delta" && typeof event.index === "number") {
        const delta = event.delta;
        const block = written.get(event.index);
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          text += delta.text;
          if (block) block.text += delta.text;
          yield { type: "text_delta", delta: delta.text };
        } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const toolCall = toolCalls.get(event.index);
          if (toolCall && delta.partial_json.length > 0) {
            toolCall.json += delta.partial_json;
            yield { type: "tool_call_input_delta", delta: delta.partial_json };
          }
        } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
          if (block) block.text += delta.thinking;
          yield { type: "reasoning_delta", id: `thinking_${event.index}`, delta: delta.thinking };
        } else if (delta?.type === "signature_delta" && typeof delta.signature === "string") {
          // The signature of a thinking block comes at its end. It is kept, never shown.
          if (block) block.signature += delta.signature;
        }
      } else if (event.type === "message_delta") {
        stopReason = event.delta?.stop_reason;
        if (isRecord(event.usage)) {
          // The counts of the whole answer come with its end. Handed on at once: a connection
          // that breaks after it keeps them. The counts of `message_start` alone are partial
          // and are not handed on, so a stream that is cut off is estimated from what arrived.
          usage = toBedrockModelUsage({ ...started, ...event.usage });
          yield { type: "usage_reported", usage };
        }
      } else if (event.type === "message_stop") {
        stopped = true;
      } else if (event.type === "error") {
        throw this.streamError(event.error?.type, event.error?.message);
      }
    }

    if (!stopped) {
      throw new AppError("TIMEOUT", "Model provider stream ended before its answer was complete");
    }
    const answer = {
      text,
      toolCalls: [...toolCalls]
        .sort(([first], [second]) => first - second)
        .map(([, toolCall]): ModelToolCall => ({
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          ...(toolCall.json.length > 0
            ? readBedrockToolInput(parseToolInput(toolCall.json), toolCall.json)
            : readBedrockToolInput({ input: toolCall.given ?? {} }, undefined))
        }))
    };
    this.assertAnswered(answer, stopReason, response.status, usage);
    // Every block of the answer in the order the model wrote it.
    const blocks = [
      ...[...written].map(([index, block]): [number, BedrockTurnBlock | undefined] => [
        index,
        toBedrockTurnBlock({ ...block, thinking: block.text })
      ]),
      ...[...toolCalls].map(([index, toolCall]): [number, BedrockTurnBlock | undefined] => [
        index,
        { type: "tool_use", id: toolCall.id }
      ])
    ]
      .sort(([first], [second]) => first - second)
      .flatMap(([, block]) => (block ? [block] : []));
    const continuation = toBedrockContinuation(this.options.id, thinkingTurns, blocks);
    yield {
      type: "completed",
      completion: {
        ...answer,
        ...(continuation ? { continuation } : {}),
        sources: [],
        citations: [],
        usage
      }
    };
  }

  /**
   * Asks Bedrock for a model that does not exist, with an empty body. A key Bedrock takes is
   * answered 400 for the model id; a key it does not take is answered 403. Nothing is generated
   * and nothing is billed. It shows that the key is taken, not that it may call a profile.
   */
  async check({ signal }: ProviderCheckContext): Promise<ProviderCheckResult> {
    let response: Response;
    try {
      response = await fetch(`https://${BEDROCK_RUNTIME_HOST}/model/catalyst-check/invoke`, {
        method: "POST",
        headers: this.headers("application/json"),
        body: "{}",
        redirect: "manual",
        signal
      });
    } catch {
      return { ok: false, errorClass: "unreachable" };
    }
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 400 || response.status === 404) {
      return { ok: true };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, errorClass: "access_denied" };
    }
    return { ok: false, errorClass: "rejected" };
  }

  private headers(accept: string): Record<string, string> {
    return {
      "content-type": "application/json",
      accept,
      authorization: `Bearer ${this.options.bearerToken}`
    };
  }

  /** A request that never got an answer failed on the connection, unless the caller stopped it. */
  private async post(
    request: ModelAdapterRequest,
    method: "invoke" | "invoke-with-response-stream",
    body: BedrockMessagesRequest
  ): Promise<Response> {
    this.assertModel(request.model);
    const url = `https://${BEDROCK_RUNTIME_HOST}/model/${encodeURIComponent(request.model)}/${method}`;
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized, "utf8") > BEDROCK_REQUEST_MAX_BYTES) {
      // Refused here and never sent: Bedrock would refuse the whole request for its size.
      throw new ModelProviderError({
        kind: "context_length_exceeded",
        message: CONTEXT_LENGTH_MESSAGE,
        details: { providerId: this.options.id }
      });
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: this.headers(
          method === "invoke" ? "application/json" : "application/vnd.amazon.eventstream"
        ),
        body: serialized,
        // A redirect is never followed: the key and the conversation go to the one host above.
        // The answer with status 3xx is refused below like any other that is not a success.
        redirect: "manual",
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

  private async readJson(response: Response): Promise<BedrockMessagesResponse> {
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

  /**
   * The event one message of the stream holds. Undefined for a message that holds none this
   * adapter reads: a message of another event type, or a chunk without bytes.
   */
  private readStreamEvent(message: BedrockEventStreamMessage): BedrockStreamEvent | undefined {
    const messageType = message.headers[":message-type"];
    if (messageType === "exception" || messageType === "error") {
      const payload = parseJson(new TextDecoder().decode(message.payload));
      throw this.streamError(
        message.headers[":exception-type"] ?? message.headers[":error-code"],
        isRecord(payload) ? (payload.message ?? payload.Message) : message.headers[":error-message"]
      );
    }
    if (message.headers[":event-type"] !== "chunk") {
      return undefined;
    }
    const chunk = parseJson(new TextDecoder().decode(message.payload));
    if (!isRecord(chunk) || typeof chunk.bytes !== "string") {
      return undefined;
    }
    const event = parseJson(Buffer.from(chunk.bytes, "base64").toString("utf8"));
    if (!isRecord(event)) {
      throw new ModelProviderError({
        kind: "invalid_response",
        message: "Model provider returned invalid stream JSON"
      });
    }
    return event;
  }

  private assertAnswered(
    answer: { text: string; toolCalls: ModelToolCall[] },
    stopReason: string | null | undefined,
    status: number,
    usage: ModelCompletion["usage"]
  ): void {
    const reason = missingBedrockAnswerReason(answer, stopReason);
    if (reason === undefined) {
      return;
    }
    const overflow = reason === "model_context_window_exceeded";
    throw new ModelProviderError({
      kind: overflow ? "context_length_exceeded" : "invalid_response",
      message: overflow ? CONTEXT_LENGTH_MESSAGE : "Model provider returned no answer",
      status,
      ...(usage.source === "provider_reported" ? { usage } : {}),
      providerCode: identifier(reason),
      details: { providerId: this.options.id, status }
    });
  }

  /**
   * A failure Bedrock or the model reported inside a stream that had begun with status 200. A
   * type this adapter does not know is not sent again: it may be a refusal that no retry changes.
   */
  private streamError(type: unknown, message: unknown): ModelProviderError {
    const providerCode = identifier(type);
    const known = STREAM_ERRORS[providerCode?.toLowerCase() ?? ""];
    const status = known?.[1];
    const overflow =
      (known?.[0] === "invalid_request" &&
        typeof message === "string" &&
        CONTEXT_LENGTH_REFUSAL.test(message)) ||
      providerCode === "request_too_large";
    return new ModelProviderError({
      kind: overflow ? "context_length_exceeded" : (known?.[0] ?? "server_error"),
      message: overflow ? CONTEXT_LENGTH_MESSAGE : "Model provider request failed",
      ...(known === undefined ? { retryable: false } : {}),
      ...(status === undefined ? {} : { status }),
      providerCode,
      providerMessage: logMessage(message),
      details: {
        providerId: this.options.id,
        ...(providerCode === undefined ? {} : { providerErrorCode: providerCode })
      }
    });
  }

  private async providerError(response: Response): Promise<ModelProviderError> {
    const payload: unknown = await response.json().catch(() => undefined);
    const text = isRecord(payload) ? (payload.message ?? payload.Message) : undefined;
    // `x-amzn-errortype` names the exception, followed by a colon and a namespace.
    const providerCode = identifier(response.headers.get("x-amzn-errortype")?.split(":")[0]);
    const requestId = identifier(response.headers.get("x-amzn-requestid"));
    const { retryAfterMs } = readProviderErrorMetadata(undefined, response.headers);
    const overflow =
      response.status === 400 && typeof text === "string" && CONTEXT_LENGTH_REFUSAL.test(text);
    return new ModelProviderError({
      kind: overflow ? "context_length_exceeded" : bedrockErrorKindForStatus(response.status),
      message: overflow ? CONTEXT_LENGTH_MESSAGE : "Model provider request failed",
      status: response.status,
      providerCode,
      providerRequestId: requestId,
      retryAfterMs,
      providerMessage: logMessage(text),
      details: {
        providerId: this.options.id,
        status: response.status,
        ...(providerCode === undefined ? {} : { providerErrorCode: providerCode }),
        ...(requestId === undefined ? {} : { requestId })
      }
    });
  }
}

const CONTEXT_LENGTH_MESSAGE =
  "This conversation is too long for the model. Start a new conversation.";
// Bedrock answers a prompt above the model's context window with status 400 and no code of its
// own; only its sentence tells it from another refused request.
const CONTEXT_LENGTH_REFUSAL = /prompt is too long|input is too long/iu;
// Protects a call from a request Bedrock refuses whole for its size: the body of one
// `InvokeModel` request may have 20 MB. A larger one is refused here as a conversation that is
// too long, and nothing is sent.
const BEDROCK_REQUEST_MAX_BYTES = 20_000_000;

/** 424 is Bedrock's status for a model that failed while it answered: sent again like a 5xx. */
function bedrockErrorKindForStatus(status: number): ModelProviderErrorKind {
  return status === 424 ? "server_error" : modelProviderErrorKindForStatus(status);
}

/**
 * The failures a stream reports, by Bedrock's exception type and by the model's error type, in
 * lower case, with the kind and the status the same failure has as an HTTP answer. Throttling,
 * a timeout, an overloaded or failing model are sent again; a refused key, permission, bill or
 * request never is.
 */
const STREAM_ERRORS: Record<string, [ModelProviderErrorKind, number]> = {
  throttlingexception: ["rate_limit", 429],
  modelnotreadyexception: ["rate_limit", 429],
  rate_limit_error: ["rate_limit", 429],
  modeltimeoutexception: ["timeout", 408],
  timeout_error: ["timeout", 408],
  modelstreamerrorexception: ["server_error", 424],
  modelerrorexception: ["server_error", 424],
  internalserverexception: ["server_error", 500],
  api_error: ["server_error", 500],
  serviceunavailableexception: ["server_error", 503],
  overloaded_error: ["server_error", 529],
  validationexception: ["invalid_request", 400],
  servicequotaexceededexception: ["invalid_request", 400],
  invalid_request_error: ["invalid_request", 400],
  authentication_error: ["invalid_request", 401],
  billing_error: ["invalid_request", 402],
  accessdeniedexception: ["invalid_request", 403],
  permission_error: ["invalid_request", 403],
  resourcenotfoundexception: ["invalid_request", 404],
  not_found_error: ["invalid_request", 404],
  request_too_large: ["invalid_request", 413]
};

/**
 * What Bedrock wrote, for the gateway's log line. A refusal names the caller and the resource by
 * ARN; the account id in them is masked before the text is cut to the log limit.
 */
function logMessage(value: unknown): string | undefined {
  return typeof value === "string"
    ? boundProviderMessage(value.replace(/\d{12}/gu, "<account>"))
    : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Only a bounded identifier of a known field crosses the provider boundary. */
function identifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
