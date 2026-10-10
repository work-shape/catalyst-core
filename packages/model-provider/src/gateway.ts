import {
  AppError,
  type ClientInstanceId,
  type Logger,
  type AdmittedModelCall,
  type ModelAttribution,
  type ModelBindingConfig,
  type ModelCallAdmission,
  type ModelCallUsage,
  type ModelProviderConfig,
  type ReasoningEffortConfig
} from "@vivd-catalyst/core";
import { ModelProviderError, normalizeModelAdapterError } from "./model-provider-error";
import { createModelRetryPolicy, modelCallFailureFor, type ModelRetryPolicy } from "./retry";
import {
  isModelFunctionTool,
  isModelProviderNativeTool,
  type ModelAdapter,
  type ModelAdapterRequest,
  type ModelCapabilities,
  type ModelCompletion,
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
} from "@vivd-catalyst/core";

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
  reasoningEffort?: ReasoningEffortConfig;
  fastTier?: boolean;
  continuation?: ModelProviderContinuation;
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
   * ended without an answer, and what admission reserved for it is released.
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
}

export function createModelGateway(options: ModelGatewayOptions): ModelGateway {
  const { governance, logger } = options;

  function resolve(ref: ModelBindingRef): ResolvedModelTarget {
    let providerId: string;
    let model: string | undefined;
    const bindingId = "bindingId" in ref ? ref.bindingId : undefined;
    if ("bindingId" in ref) {
      const binding = options.bindings.find((candidate) => candidate.id === ref.bindingId);
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
      ...(bindingId === undefined ? {} : { bindingId })
    };
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
        model: target.model,
        kind: error.kind,
        retryable: error.retryable,
        status: error.status,
        providerCode: error.providerCode,
        providerRequestId: error.providerRequestId,
        providerMessage: error.providerMessage,
        ...(attribution.kind === "agent_run"
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
    seen: { completion?: ModelCompletion }
  ): AsyncGenerator<ModelCallStreamEvent, void, void> {
    const request: ModelAdapterRequest = {
      model: target.model,
      messages: call.messages,
      tools: call.tools,
      output: call.output,
      reasoningEffort: call.reasoningEffort,
      fastTier: call.fastTier,
      continuation: call.continuation,
      signal: limit.signal,
      deadline: call.deadline
    };
    for (;;) {
      policy.assertAttemptMayStart();
      const attempt = { retrySafe: true };
      const preparingToolCallIds: string[] = [];
      try {
        if (!streaming) {
          const completion = await limit.bound(target.adapter.complete(request));
          attempt.retrySafe = false;
          seen.completion = completion;
          yield { type: "completed", completion };
          return;
        }
        for await (const event of target.adapter.stream(request)) {
          if (event.type === "tool_call_preparing") {
            preparingToolCallIds.push(event.toolCallId);
          } else if (event.type === "completed") {
            attempt.retrySafe = false;
            seen.completion = event.completion;
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
        }
        const waitMs = policy.waitBeforeRetryMs(error, attempt);
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
   * was left unread by its caller; a call that did not complete is settled as failed with
   * nothing used. Only a process that goes away leaves an event that is not settled.
   */
  async function* run(
    call: ModelCall,
    streaming: boolean
  ): AsyncGenerator<ModelCallStreamEvent, void, void> {
    const target = resolve(call.binding);
    assertWithinCapabilities(call, target, streaming);
    const policy = createModelRetryPolicy({ signal: call.signal, deadline: call.deadline });
    policy.assertAttemptMayStart();
    const admitted = await governance.admitModelCall({
      clientInstanceId: call.clientInstanceId,
      attribution: call.attribution,
      providerId: target.provider.id,
      model: target.model,
      ...(target.provider.region ? { region: target.provider.region } : {}),
      ...(target.bindingId === undefined ? {} : { bindingId: target.bindingId }),
      fastMode: call.fastTier === true,
      correlationId: call.correlationId,
      request: { inputCharacters: requestCharacters(call) }
    });
    const seen: { completion?: ModelCompletion } = {};
    const settle = async (answerHandedOn: boolean): Promise<void> => {
      try {
        // A call without a completion used nothing the provider reported.
        await governance.settleModelCall(admitted, seen.completion?.usage);
      } catch (settleError) {
        if (answerHandedOn) {
          // A call whose usage could not be settled fails, so no answer goes unrecorded.
          throw settleError;
        }
        logger.error(
          {
            type: "model_usage.record_failed",
            providerId: target.provider.id,
            model: target.model,
            error: settleError
          },
          "Usage of a model call that did not complete could not be recorded"
        );
      }
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
      await settle(ended === "completed");
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
    capabilities(binding) {
      const target = resolve(binding);
      return target.adapter.capabilities(target.model);
    }
  };
}

/**
 * The characters of what a call sends: its texts, the inputs of its tool calls and its tool
 * definitions. An image counts as nothing here; its tokens do not follow from its bytes.
 */
function requestCharacters(call: ModelCall): number {
  let characters = 0;
  for (const message of call.messages) {
    if (typeof message.content === "string") {
      characters += message.content.length;
    } else {
      for (const part of message.content) {
        if (part.type === "text") characters += part.text.length;
      }
    }
    if (message.role === "assistant") {
      for (const toolCall of message.toolCalls ?? []) {
        characters += toolCall.toolName.length + JSON.stringify(toolCall.input ?? null).length;
      }
    }
  }
  for (const tool of call.tools) {
    characters += tool.name.length;
    if (isModelFunctionTool(tool)) {
      characters += tool.description.length + JSON.stringify(tool.inputJsonSchema ?? {}).length;
    }
  }
  if (call.output) characters += JSON.stringify(call.output.jsonSchema).length;
  return characters;
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
  if (call.continuation !== undefined && !capabilities.continuation) {
    missing.push("continuation");
  }
  if (call.fastTier === true && !capabilities.fastTier) {
    missing.push("fast tier");
  }
  if (call.output !== undefined && !capabilities.structuredOutput) {
    missing.push("structured output");
  }
  if (missing.length > 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Model '${target.model}' of provider '${target.provider.id}' does not support: ${missing.join(", ")}`
    );
  }
}

/** What bounds one call in time: the caller's stop and the call's deadline. */
interface ModelCallLimit {
  /** Aborts on the caller's stop and at the deadline. An adapter stops with it. */
  signal: AbortSignal | undefined;
  /** Whether the deadline has passed. */
  expired(): boolean;
  /** Settles as `pending` does, or rejects at the deadline when `pending` is still open then. */
  bound<T>(pending: Promise<T>): Promise<T>;
  release(): void;
}

function deadlinePassed(): AppError {
  return new AppError("TIMEOUT", "The model call did not finish before its deadline");
}

// The longest delay a timer takes. A deadline further away is checked again when it fires.
const TIMER_MAX_DELAY_MS = 2 ** 31 - 1;

/**
 * Stops a call at its deadline. The adapter is told through the signal, and a completion is
 * given up at the deadline even when the adapter does not listen, so a provider that never
 * answers cannot hold its caller. A stream is told through the signal alone.
 */
function limitModelCall(
  signal: AbortSignal | undefined,
  deadline: Date | undefined
): ModelCallLimit {
  if (!deadline) {
    return { signal, expired: () => false, bound: (pending) => pending, release: () => undefined };
  }
  const timedOut = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    const leftMs = deadline.getTime() - Date.now();
    if (leftMs <= 0) {
      timedOut.abort();
      return;
    }
    timer = setTimeout(arm, Math.min(leftMs, TIMER_MAX_DELAY_MS));
  };
  arm();
  const atDeadline = new Promise<never>((_resolve, reject) => {
    timedOut.signal.addEventListener("abort", () => reject(deadlinePassed()), { once: true });
  });
  // Nothing may be waiting when the deadline passes; the rejection then has no reader.
  atDeadline.catch(() => undefined);
  return {
    signal: signal ? AbortSignal.any([signal, timedOut.signal]) : timedOut.signal,
    expired: () => timedOut.signal.aborted,
    bound: (pending) => Promise.race([pending, atDeadline]),
    release: () => clearTimeout(timer)
  };
}

/**
 * What a stopped call throws: the adapter's own abort where it threw one, else the reason the
 * caller stopped with, as an abort.
 */
function stopOf(signal: AbortSignal, thrown: unknown): unknown {
  if (!(thrown instanceof ModelProviderError)) {
    return thrown;
  }
  const reason: unknown = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return new DOMException(
    typeof reason === "string" ? reason : "The model call was stopped",
    "AbortError"
  );
}
