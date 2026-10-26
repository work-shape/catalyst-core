import {
  AppError,
  type ClientInstanceId,
  type Logger,
  type AdmittedModelCall,
  type ModelAttribution,
  type ModelBindingConfig,
  type ModelBindingKind,
  type ModelCallAdmission,
  type ModelCallUsage,
  type ModelEmbeddingPurpose,
  type ModelProviderConfig,
  type ModelTokenUsage,
  type ReasoningEffortConfig,
  type SystemModelAttribution
} from "@work-shape/catalyst-core";
import { deadlinePassed, limitModelCall, stopOf, type ModelCallLimit } from "./model-call-limit";
import {
  ModelProviderError,
  ModelRouteFailedError,
  isModelRouteFailure,
  normalizeModelAdapterError
} from "./model-provider-error";
import { createModelRetryPolicy, modelCallFailureFor, type ModelRetryPolicy } from "./retry";
import {
  WEB_SEARCH_MODEL_TOOL_NAME,
  isModelFunctionTool,
  isModelProviderNativeTool,
  type ModelAdapter,
  type ModelAdapterRequest,
  type ModelCapabilities,
  type ModelCompletion,
  type ModelAdapterEmbedding,
  type ModelEmbedding,
  type ModelAdapterStreamEvent,
  type ModelCompletionStreamEvent,
  type ModelMessage,
  type ModelOutputFormat,
  type ModelProviderContinuation,
  type ModelTool
} from "./types";

export type {
  AgentRunModelAttribution,
  ModelAttribution,
  ModelSystemPurpose,
  SystemModelAttribution
} from "@work-shape/catalyst-core";

/**
 * Which model a call goes to: a model binding of the instance, or a provider entry with the
 * model it names or the one given here. An agent without a binding runs on a provider entry.
 */
export type ModelBindingRef = { bindingId: string } | { providerId: string; model?: string };

/** One call to a model. The gateway is the only place that sends it. */
export interface ModelCall {
  binding: ModelBindingRef;
  messages: ModelMessage[];
  tools: ModelTool[];
  output?: ModelOutputFormat;
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffortConfig;
  fastTier?: boolean;
  continuation?: ModelProviderContinuation;
  /**
   * The same for every call whose prompt starts the same way, such as the steps and turns of
   * one conversation: a provider that caches prompts sends such calls to the same cache. An
   * adapter whose provider takes no such key leaves it out.
   */
  cacheKey?: string;
  /**
   * The caller sends the call to another model when this one's route fails. A rate limit then
   * fails the call at once, without the wait; a server error, a timeout or a lost connection
   * after the call's retries. Either fails it as `ModelRouteFailedError`, and only while the
   * call has given the caller nothing; otherwise the call fails as it would without.
   */
  hasFallback?: boolean;
  attribution: ModelAttribution;
  clientInstanceId: ClientInstanceId;
  /** Ties the usage event to the request that caused the call. */
  correlationId: string;
  signal?: AbortSignal;
  /**
   * No attempt starts and no wait ends after it, and an attempt that is still going then is
   * stopped: the call fails as timed out.
   */
  deadline?: Date;
}

/**
 * The most texts one embedding call carries: the OpenAI embeddings endpoint takes no more in one
 * request. Ingestion batches below it; a call above it is refused before anything is sent.
 */
export const MODEL_EMBEDDING_MAX_TEXTS_PER_CALL = 2_048;

/** One call to an embedding binding: a batch of texts, each turned into one vector. */
export interface ModelEmbeddingCall {
  binding: { bindingId: string };
  texts: readonly string[];
  attribution: SystemModelAttribution & { purpose: ModelEmbeddingPurpose };
  clientInstanceId: ClientInstanceId;
  /** Ties the usage event to the request that caused the call. */
  correlationId: string;
  signal?: AbortSignal;
  /** As for `ModelCall`: no attempt starts and no wait ends after it. */
  deadline?: Date;
}

/**
 * What a streamed call yields: the adapter's events, and a notice that a tool call announced by
 * an attempt will not come because that attempt failed and the call is sent again.
 */
export type ModelCallStreamEvent =
  ModelCompletionStreamEvent | { type: "tool_call_preparation_cancelled"; toolCallId: string };

export interface ModelGateway {
  /** Sends the call and returns the answer. */
  complete(call: ModelCall): Promise<ModelCompletion>;
  /**
   * Sends the call and yields the answer as it arrives. A failed attempt is sent again only
   * while the caller has received no text, no reasoning, no native tool event and no completion.
   */
  stream(call: ModelCall): AsyncIterable<ModelCallStreamEvent>;
  /**
   * Turns each text into one vector of the binding's dimensions, in the order of the texts. Only
   * a binding of kind `embedding` takes it, and it takes nothing else. No text, no call: an empty
   * batch reaches neither admission nor the provider.
   */
  embed(call: ModelEmbeddingCall): Promise<ModelEmbedding>;
  /** What the model behind a binding can do. */
  capabilities(binding: ModelBindingRef): ModelCapabilities;
}

/**
 * How the gateway admits a call and records what it used. Usage governance implements it; the
 * gateway is its only caller for the calls it sends.
 */
export interface ModelCallGovernance {
  /** Admits the call and writes its usage event, or refuses with the limit that is reached. */
  admitModelCall(call: ModelCallAdmission): Promise<AdmittedModelCall>;
  /**
   * Ends the admitted call: writes what it used onto its usage event. Without usage the call
   * ended before any answer arrived, and what admission reserved for it is released.
   */
  settleModelCall(admitted: AdmittedModelCall, usage?: ModelCallUsage): Promise<unknown>;
}

export interface ModelGatewayOptions {
  /** The entries under `infrastructure.models`. */
  providers: readonly ModelProviderConfig[];
  bindings: readonly ModelBindingConfig[];
  /** One adapter per provider entry, by the entry's id. */
  adapters: ReadonlyMap<string, ModelAdapter>;
  governance: ModelCallGovernance;
  logger: Logger;
}

interface ResolvedModelTarget {
  provider: ModelProviderConfig;
  adapter: ModelAdapter;
  model: string;
  /** The binding the call named, when it named one. */
  bindingId?: string;
  /** A call on a provider entry alone is a chat call. */
  kind: ModelBindingKind;
  /** The length of the vectors of an embedding binding. */
  dimensions?: number;
}

export function createModelGateway(options: ModelGatewayOptions): ModelGateway {
  const { governance, logger } = options;
  for (const binding of options.bindings) {
    const adapter = options.adapters.get(binding.providerId);
    if (binding.kind === "embedding" && adapter && !adapter.embed) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Embedding binding '${binding.id}' is on model provider '${binding.providerId}', which does not embed`
      );
    }
  }

  function resolve(ref: ModelBindingRef): ResolvedModelTarget {
    let providerId: string;
    let model: string | undefined;
    let binding: ModelBindingConfig | undefined;
    if ("bindingId" in ref) {
      binding = options.bindings.find((candidate) => candidate.id === ref.bindingId);
      if (!binding) {
        throw new AppError("NOT_FOUND", `Model binding '${ref.bindingId}' is not defined`);
      }
      providerId = binding.providerId;
      model = binding.model;
    } else {
      providerId = ref.providerId;
      model = ref.model;
    }
    const provider = options.providers.find((candidate) => candidate.id === providerId);
    const adapter = options.adapters.get(providerId);
    if (!provider || !adapter) {
      throw new AppError("NOT_FOUND", `Model provider '${providerId}' is not defined`);
    }
    return {
      provider,
      adapter,
      model: model ?? provider.model,
      kind: binding?.kind ?? "chat",
      ...(binding ? { bindingId: binding.id } : {}),
      ...(binding?.dimensions === undefined ? {} : { dimensions: binding.dimensions })
    };
  }

  /** A chat call never reaches an embedding binding, nor an embedding call a chat binding. */
  function assertKind(target: ResolvedModelTarget, kind: ModelBindingKind): void {
    if (target.kind === kind) return;
    throw new AppError(
      "VALIDATION_FAILED",
      kind === "embedding"
        ? `${modelLabelOf(target)} is no embedding binding and embeds nothing`
        : `${modelLabelOf(target)} is an embedding binding and answers no chat call`
    );
  }

  function logProviderError(
    error: ModelProviderError,
    target: ResolvedModelTarget,
    attribution: ModelAttribution
  ): void {
    logger.warn(
      {
        type: "model_provider.error",
        providerId: target.provider.id,
        ...modelNameOf(target),
        kind: error.kind,
        retryable: error.retryable,
        status: error.status,
        providerCode: error.providerCode,
        providerRequestId: error.providerRequestId,
        providerMessage: error.providerMessage,
        ...(attribution.kind !== "system"
          ? { runId: attribution.runId }
          : { purpose: attribution.purpose })
      },
      "Model provider call failed"
    );
  }

  /**
   * One attempt after another until one completes or the retry policy gives up. It notes the
   * completion before it yields it, so a caller that stops reading there still has it recorded.
   */
  async function* attempts(
    call: ModelCall,
    target: ResolvedModelTarget,
    streaming: boolean,
    policy: ModelRetryPolicy,
    limit: ModelCallLimit,
    seen: SeenOfCall
  ): AsyncGenerator<ModelCallStreamEvent, void, void> {
    const request: ModelAdapterRequest = {
      model: target.model,
      messages: call.messages,
      tools: call.tools,
      output: call.output,
      maxOutputTokens: call.maxOutputTokens,
      reasoningEffort: call.reasoningEffort,
      fastTier: call.fastTier,
      continuation: call.continuation,
      cacheKey: call.cacheKey,
      signal: limit.signal,
      deadline: call.deadline
    };
    for (;;) {
      policy.assertAttemptMayStart();
      const attempt = { retrySafe: true };
      let answering = false;
      const preparingToolCallIds: string[] = [];
      try {
        if (!streaming) {
          const completion = await limit.bound(target.adapter.complete(request));
          attempt.retrySafe = false;
          seen.completion = completion;
          assertAnswersInFormat(call, completion);
          yield { type: "completed", completion };
          return;
        }
        for await (const event of target.adapter.stream(request)) {
          if (event.type === "usage_reported") {
            seen.reportedUsage = event.usage;
            continue;
          }
          const received = receivedWith(event);
          if (received) {
            // The provider read the request of this attempt once more to answer it.
            if (!answering) seen.received.inputCharacters += seen.requestCharacters();
            answering = true;
            seen.received.outputCharacters += received.characters;
            seen.received.webSearchCallCount += received.webSearchCalls;
          }
          if (event.type === "tool_call_input_delta") continue;
          if (event.type === "tool_call_preparing") {
            preparingToolCallIds.push(event.toolCallId);
          } else if (event.type === "completed") {
            attempt.retrySafe = false;
            seen.completion = event.completion;
            assertAnswersInFormat(call, event.completion);
          } else if (
            !(event.type === "text_delta" || event.type === "reasoning_delta") ||
            event.delta.length > 0
          ) {
            attempt.retrySafe = false;
          }
          yield event;
        }
        if (!seen.completion) {
          throw new AppError("INTERNAL", "Model provider stream ended without a completion");
        }
        return;
      } catch (thrown) {
        if (call.signal?.aborted) {
          // A stopped call is a stop, whatever the adapter made of the cut connection: it is
          // neither logged as a provider's error nor sent again.
          throw stopOf(call.signal, thrown);
        }
        if (limit.expired()) {
          // Whatever the adapter made of being stopped at the deadline, the call timed out.
          throw deadlinePassed();
        }
        const error = normalizeModelAdapterError(thrown);
        if (error instanceof ModelProviderError) {
          logProviderError(error, target, call.attribution);
          // The provider counted an answer it then refused: the call is settled with that.
          if (error.usage) seen.reportedUsage = error.usage;
        }
        let waitMs: number;
        try {
          waitMs = policy.waitBeforeRetryMs(error, attempt);
        } catch (failure) {
          // The route failed before the caller got anything: its fallback answers instead.
          if (!call.hasFallback || !attempt.retrySafe || !isModelRouteFailure(error)) {
            throw failure;
          }
          for (const toolCallId of preparingToolCallIds) {
            yield { type: "tool_call_preparation_cancelled", toolCallId };
          }
          throw new ModelRouteFailedError(error);
        }
        for (const toolCallId of preparingToolCallIds) {
          yield { type: "tool_call_preparation_cancelled", toolCallId };
        }
        await policy.wait(waitMs, modelCallFailureFor(error));
      }
    }
  }

  /**
   * The one call path: resolve, check the capabilities, admit, call, settle. A call that is
   * refused before or at admission records nothing. Admission writes the usage event of the
   * call, so every admitted call has exactly one, whether it completed, failed, was stopped or
   * was left unread by its caller. A call that did not complete and gave nothing is settled as
   * failed with nothing used. A stream that was cut off is settled with the usage its provider
   * had reported by then, and without one, where its answer had begun, with
   * `estimateInterruptedCallUsage`: its provider counted what it sent.
   * Only a process that goes away leaves an event that is not settled.
   */
  async function* run(
    call: ModelCall,
    streaming: boolean
  ): AsyncGenerator<ModelCallStreamEvent, void, void> {
    const target = resolve(call.binding);
    assertKind(target, "chat");
    assertWithinCapabilities(call, target, streaming);
    const policy = createModelRetryPolicy({
      signal: call.signal,
      deadline: call.deadline,
      waitOnRateLimit: call.hasFallback !== true
    });
    policy.assertAttemptMayStart();
    const inputCharacters = requestCharacters(call, (text) => text.length);
    const admitted = await governance.admitModelCall({
      clientInstanceId: call.clientInstanceId,
      attribution: call.attribution,
      providerId: target.provider.id,
      model: target.model,
      ...(target.provider.region ? { region: target.provider.region } : {}),
      ...(target.bindingId === undefined ? {} : { bindingId: target.bindingId }),
      fastMode: call.fastTier === true,
      correlationId: call.correlationId,
      request: {
        inputCharacters,
        ...(call.maxOutputTokens === undefined ? {} : { maxOutputTokens: call.maxOutputTokens })
      }
    });
    let estimatedRequest: number | undefined;
    const seen: SeenOfCall = {
      // Read only where an estimate is made: it goes through every text of the request.
      requestCharacters: () => (estimatedRequest ??= requestCharacters(call, estimatedCharacters)),
      received: { inputCharacters: 0, outputCharacters: 0, webSearchCallCount: 0 }
    };
    const limit = limitModelCall(call.signal, call.deadline);
    let ended: "completed" | "failed" | "left_unread" = "left_unread";
    try {
      yield* attempts(call, target, streaming, policy, limit, seen);
      ended = "completed";
    } catch (error) {
      ended = "failed";
      throw error;
    } finally {
      limit.release();
      // What the provider reported, with the completion or before the stream was cut.
      // Without it: an estimate where an answer began, and nothing where none did.
      await settle(
        target,
        admitted,
        seen.completion?.usage ??
          seen.reportedUsage ??
          (seen.received.outputCharacters > 0
            ? estimateInterruptedCallUsage(seen.received)
            : undefined),
        ended === "completed"
      );
    }
  }

  /**
   * Ends an admitted call with what it used. A call whose answer is handed on fails when its
   * usage cannot be settled, so no answer goes unrecorded; any other call keeps its own outcome,
   * and the failed settlement is logged.
   */
  async function settle(
    target: ResolvedModelTarget,
    admitted: AdmittedModelCall,
    usage: ModelCallUsage | undefined,
    answerHandedOn: boolean
  ): Promise<void> {
    try {
      await governance.settleModelCall(admitted, usage);
    } catch (settleError) {
      if (answerHandedOn) throw settleError;
      logger.error(
        {
          type: "model_usage.record_failed",
          providerId: target.provider.id,
          ...modelNameOf(target),
          error: settleError
        },
        "Usage of a model call that did not complete could not be recorded"
      );
    }
  }

  /**
   * The path of an embedding call: resolve, admit, call with the retry policy, check the
   * vectors, settle. An embedding request is the same request on every attempt and returns
   * nothing until it is whole, so every attempt is safe to send again.
   */
  async function embed(call: ModelEmbeddingCall): Promise<ModelEmbedding> {
    if (call.texts.length === 0) return { vectors: [], inputTokens: 0 };
    if (call.texts.length > MODEL_EMBEDDING_MAX_TEXTS_PER_CALL) {
      throw new AppError(
        "VALIDATION_FAILED",
        `An embedding call carries at most ${MODEL_EMBEDDING_MAX_TEXTS_PER_CALL} texts; this one carries ${call.texts.length}`
      );
    }
    const target = resolve(call.binding);
    assertKind(target, "embedding");
    const { dimensions } = target;
    const embedWith = target.adapter.embed?.bind(target.adapter);
    if (dimensions === undefined || !embedWith) {
      throw new AppError("INTERNAL", `${modelLabelOf(target)} cannot embed`);
    }
    const policy = createModelRetryPolicy({ signal: call.signal, deadline: call.deadline });
    policy.assertAttemptMayStart();
    const admitted = await governance.admitModelCall({
      clientInstanceId: call.clientInstanceId,
      attribution: call.attribution,
      providerId: target.provider.id,
      model: target.model,
      ...(target.provider.region ? { region: target.provider.region } : {}),
      bindingId: call.binding.bindingId,
      fastMode: false,
      correlationId: call.correlationId,
      // An embedding answers with vectors, which the provider bills as no output.
      request: {
        inputCharacters: call.texts.reduce((sum, text) => sum + text.length, 0),
        maxOutputTokens: 0
      }
    });
    const limit = limitModelCall(call.signal, call.deadline);
    // What the provider counted for its last answer, which it bills whether or not the answer
    // is whole.
    let billed: ModelTokenUsage | undefined;
    let handedOn = false;
    try {
      for (;;) {
        policy.assertAttemptMayStart();
        try {
          const answer = await limit.bound(
            embedWith({
              model: target.model,
              texts: call.texts,
              dimensions,
              signal: limit.signal,
              deadline: call.deadline
            })
          );
          billed = answer.usage;
          assertEmbeddingAnswers(answer, call.texts.length, dimensions);
          handedOn = true;
          return { vectors: answer.vectors, inputTokens: answer.usage.inputTokens };
        } catch (thrown) {
          if (call.signal?.aborted) throw stopOf(call.signal, thrown);
          if (limit.expired()) throw deadlinePassed();
          const error = normalizeModelAdapterError(thrown);
          if (error instanceof ModelProviderError) {
            if (error.usage) billed = error.usage;
            logProviderError(error, target, call.attribution);
          }
          const waitMs = policy.waitBeforeRetryMs(error, { retrySafe: true });
          await policy.wait(waitMs, modelCallFailureFor(error));
        }
      }
    } finally {
      limit.release();
      // An embedding reads no cache, so its input is priced whole at the uncached rate.
      await settle(target, admitted, billed && { ...billed, cachedInputTokens: 0 }, handedOn);
    }
  }

  return {
    async complete(call) {
      let completion: ModelCompletion | undefined;
      for await (const event of run(call, false)) {
        if (event.type === "completed") {
          completion = event.completion;
        }
      }
      if (!completion) {
        throw new AppError("INTERNAL", "Model call ended without a completion");
      }
      return completion;
    },
    stream(call) {
      return run(call, true);
    },
    embed,
    capabilities(binding) {
      const target = resolve(binding);
      return target.adapter.capabilities(target.model);
    }
  };
}

/** What the gateway saw of a call: its completion, or what arrived of an answer without one. */
interface SeenOfCall {
  completion?: ModelCompletion;
  /** The usage the provider reported in a stream that gave no completion. */
  reportedUsage?: ModelCompletion["usage"];
  /** The characters of the request, as `estimatedCharacters` counts them. */
  requestCharacters(): number;
  received: InterruptedCallSize;
}

/**
 * What arrived of a streamed call that reported no usage, over all its attempts. Characters are
 * counted with `estimatedCharacters`.
 */
export interface InterruptedCallSize {
  /** The characters of the request, once for each attempt that began to answer. */
  inputCharacters: number;
  /** The characters of the text, the reasoning, the tool events and the tool inputs. */
  outputCharacters: number;
  webSearchCallCount: number;
}

/**
 * Characters of the Latin alphabet, digits and punctuation taken as one token when a call that
 * was cut off is estimated. Such text runs at about four characters a token; three keeps the
 * estimate above what the provider counts.
 */
const ESTIMATED_CHARACTERS_PER_TOKEN = 3;

/**
 * The most tokens an estimate gives for the input of a call, and for its output. No model
 * takes or gives that much in one call, so the bound cuts nothing real. It is there for a
 * stream that is malformed or runs without end: its estimate stays far inside what the usage
 * event and the counters store as a 32-bit integer, also as the sum of both, so settling it
 * cannot fail on its size and leave the call to be recovered with nothing used.
 */
export const MAX_ESTIMATED_TOKENS_PER_CALL = 10_000_000;

/** The most web searches an estimate counts for one call, for the same reason. */
export const MAX_ESTIMATED_WEB_SEARCHES_PER_CALL = 1_000;

/**
 * The size of a text for the estimate. A character of the Latin alphabet, a digit or a
 * punctuation mark counts as one. Every other character counts as
 * `ESTIMATED_CHARACTERS_PER_TOKEN`, which is one token for each: Chinese, Japanese and Korean
 * text runs at about one token a character, and Cyrillic, Greek, Arabic and accented letters
 * at less, so three characters a token would count such text at a third of what it costs.
 */
export function estimatedCharacters(text: string): number {
  let others = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) others += 1;
  }
  return text.length + others * (ESTIMATED_CHARACTERS_PER_TOKEN - 1);
}

/**
 * What a streamed call is settled with when it was stopped or broke off after its answer began
 * and its provider had reported no usage. The rule: every `ESTIMATED_CHARACTERS_PER_TOKEN`
 * characters that were sent or that arrived count as one token, rounded up, and at least one
 * output token, with the characters counted by `estimatedCharacters`; the input counts as not
 * cached, which is the dearer rate; a web search counts from its start. Neither the input nor
 * the output is more than `MAX_ESTIMATED_TOKENS_PER_CALL`. The usage is marked `estimated`. It
 * is never nothing: a provider bills what it sent, whether or not the caller read to the end.
 */
export function estimateInterruptedCallUsage(received: InterruptedCallSize): ModelCallUsage {
  const tokens = (characters: number): number =>
    bounded(Math.ceil(characters / ESTIMATED_CHARACTERS_PER_TOKEN), MAX_ESTIMATED_TOKENS_PER_CALL);
  const inputTokens = tokens(received.inputCharacters);
  const outputTokens = Math.max(1, tokens(received.outputCharacters));
  return {
    inputTokens,
    cachedInputTokens: 0,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    source: "estimated",
    webSearchCallCount: bounded(received.webSearchCallCount, MAX_ESTIMATED_WEB_SEARCHES_PER_CALL)
  };
}

/** A whole count from nothing to `maximum`. What is not a number counts as the maximum. */
function bounded(count: number, maximum: number): number {
  return Number.isNaN(count) ? maximum : Math.min(maximum, Math.max(0, Math.trunc(count)));
}

/** What one stream event shows the provider to have produced. Nothing for an empty delta. */
function receivedWith(
  event: Exclude<ModelAdapterStreamEvent, { type: "usage_reported" }>
): { characters: number; webSearchCalls: number } | undefined {
  const sizeOf = (value: unknown): number =>
    value === undefined ? 0 : estimatedCharacters(JSON.stringify(value));
  switch (event.type) {
    case "text_delta":
    case "reasoning_delta":
    case "tool_call_input_delta":
      return event.delta.length > 0
        ? { characters: estimatedCharacters(event.delta), webSearchCalls: 0 }
        : undefined;
    case "tool_call_preparing":
      return { characters: event.toolName.length, webSearchCalls: 0 };
    case "provider_tool_started":
      return {
        characters: event.toolName.length + sizeOf(event.input),
        webSearchCalls: event.toolName === WEB_SEARCH_MODEL_TOOL_NAME ? 1 : 0
      };
    case "provider_tool_completed":
      return { characters: event.toolName.length + sizeOf(event.output), webSearchCalls: 0 };
    case "completed":
      return undefined;
  }
}

/**
 * The size of what a call sends, as `sizeOf` counts a text: its texts, the inputs of its tool
 * calls and its tool definitions. An image counts as nothing here; its tokens do not follow
 * from its bytes.
 */
function requestCharacters(call: ModelCall, sizeOf: (text: string) => number): number {
  let characters = 0;
  for (const message of call.messages) {
    if (typeof message.content === "string") {
      characters += sizeOf(message.content);
    } else {
      for (const part of message.content) {
        if (part.type === "text") characters += sizeOf(part.text);
      }
    }
    if (message.role === "assistant") {
      for (const toolCall of message.toolCalls ?? []) {
        characters += sizeOf(toolCall.toolName) + sizeOf(JSON.stringify(toolCall.input ?? null));
      }
    }
  }
  for (const tool of call.tools) {
    characters += sizeOf(tool.name);
    if (isModelFunctionTool(tool)) {
      characters += sizeOf(tool.description) + sizeOf(JSON.stringify(tool.inputJsonSchema ?? {}));
    }
  }
  if (call.output) characters += sizeOf(JSON.stringify(call.output.jsonSchema));
  return characters;
}

/**
 * How a log line names the model of a call: by its binding where the call named one. A
 * provider's model id can hold what belongs in no log, such as a cloud account id; it stays in
 * the usage ledger, where it joins a call to the provider's bill.
 */
function modelNameOf(target: ResolvedModelTarget): { bindingId: string } | { model: string } {
  return target.bindingId === undefined ? { model: target.model } : { bindingId: target.bindingId };
}

/** How a refusal names the model of a call: by its binding where the call named one. */
function modelLabelOf(target: ResolvedModelTarget): string {
  return target.bindingId === undefined
    ? `Model '${target.model}'`
    : `Model binding '${target.bindingId}'`;
}

/**
 * An embedding answer holds one vector per text, each of the binding's length and of finite
 * numbers, or the call fails: a vector of another length cannot be stored beside the others.
 */
function assertEmbeddingAnswers(
  embedding: ModelAdapterEmbedding,
  textCount: number,
  dimensions: number
): void {
  const whole =
    embedding.vectors.length === textCount &&
    embedding.vectors.every(
      (vector) => vector.length === dimensions && vector.every((value) => Number.isFinite(value))
    );
  if (!whole) {
    throw new ModelProviderError({
      kind: "invalid_response",
      message: "Embedding answer does not hold one vector of the binding's dimensions per text",
      details: { textCount, vectorCount: embedding.vectors.length, dimensions }
    });
  }
}

/** Refuses a call that asks the model for something its adapter does not declare. */
function assertWithinCapabilities(
  call: ModelCall,
  target: ResolvedModelTarget,
  streaming: boolean
): void {
  const capabilities = target.adapter.capabilities(target.model);
  const missing: string[] = [];
  if (streaming && !capabilities.streaming) {
    missing.push("streaming");
  }
  if (
    call.reasoningEffort !== undefined &&
    !capabilities.reasoningEfforts.includes(call.reasoningEffort)
  ) {
    missing.push(`reasoning effort '${call.reasoningEffort}'`);
  }
  for (const tool of call.tools) {
    if (isModelProviderNativeTool(tool) && !capabilities.nativeTools.includes(tool.name)) {
      missing.push(`native tool '${tool.name}'`);
    }
  }
  if (!capabilities.toolCalls && (call.tools.some(isModelFunctionTool) || carriesToolUse(call))) {
    missing.push("tool calls");
  }
  if (call.continuation !== undefined && !capabilities.continuation) {
    missing.push("continuation");
  }
  if (call.fastTier === true && !capabilities.fastTier) {
    missing.push("fast tier");
  }
  if (call.output !== undefined && !capabilities.structuredOutput) {
    missing.push("structured output");
  }
  if (!capabilities.documentInput && call.messages.some(carriesDocument)) {
    missing.push("document input");
  }
  if (missing.length > 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      `${modelLabelOf(target)} of provider '${target.provider.id}' does not support: ${missing.join(", ")}`
    );
  }
}

/** Whether the call's history holds a tool call or the result of one. */
function carriesToolUse(call: ModelCall): boolean {
  return call.messages.some(
    (message) =>
      message.role === "tool" ||
      (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0)
  );
}

function carriesDocument(message: ModelMessage): boolean {
  return (
    typeof message.content !== "string" && message.content.some((part) => part.type === "document")
  );
}

/**
 * A call that asked for an answer format gets JSON or fails: the same for every adapter. The
 * check runs after the completion is noted, so the tokens of an answer that is refused here are
 * settled. Whether the JSON has the shape of the schema is for the caller to check.
 */
function assertAnswersInFormat(call: ModelCall, completion: ModelCompletion): void {
  if (call.output === undefined || completion.toolCalls.length > 0) {
    return;
  }
  try {
    JSON.parse(completion.text);
  } catch {
    throw new ModelProviderError({
      kind: "invalid_response",
      message: "Model answer is not valid JSON"
    });
  }
}
