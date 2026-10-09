import {
  AppError,
  type ClientInstanceId,
  type Logger,
  type ModelAttribution,
  type ModelBindingConfig,
  type ModelProviderConfig,
  type ModelUsageEventInput,
  type ReasoningEffortConfig
} from "@vivd-catalyst/core";
import { ModelProviderError, normalizeModelAdapterError } from "./model-provider-error";
import { createModelRetryPolicy, modelCallFailureFor, type ModelRetryPolicy } from "./retry";
import {
  isModelProviderNativeTool,
  type ModelAdapter,
  type ModelAdapterRequest,
  type ModelCapabilities,
  type ModelCompletion,
  type ModelCompletionRequest,
  type ModelCompletionStreamEvent,
  type ModelMessage,
  type ModelOutputFormat,
  type ModelProviderContinuation,
  type ModelTool,
  type ModelTransportContext
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
  /** No attempt starts and no wait ends after it. */
  deadline?: Date;
}

/**
 * What a streamed call yields: the adapter's events, and a notice that a tool call announced by
 * an attempt will not come because that attempt failed and the call is sent again.
 */
export type ModelCallStreamEvent =
  ModelCompletionStreamEvent | { type: "tool_call_preparation_cancelled"; toolCallId: string };

/**
 * The completion that titles and the approval check call until they get a system attribution.
 * It resolves the provider and types its errors, but admits nothing, records no usage and sends
 * a request once; those callers still do their own admission and recording.
 */
export interface UnsettledModelCompletion {
  complete(
    request: ModelCompletionRequest,
    context: ModelTransportContext
  ): Promise<ModelCompletion>;
}

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
  readonly unsettled: UnsettledModelCompletion;
}

/**
 * How the gateway admits a call and records what it used. Usage governance implements it; the
 * gateway is its only caller for the calls it sends.
 */
export interface ModelCallGovernance {
  runModelCall<T>(
    call: { clientInstanceId: ClientInstanceId; attribution: ModelAttribution },
    execute: () => Promise<T>
  ): Promise<T>;
  recordModelUsage(input: ModelUsageEventInput): Promise<unknown>;
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
}

/**
 * What a call that did not complete is recorded with. The provider reported nothing, and a row
 * that says so would count as an unpriced cost; the row states zero tokens as an estimate.
 */
const USAGE_OF_UNCOMPLETED_CALL: ModelCompletion["usage"] = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  source: "estimated",
  webSearchCallCount: 0
};

export function createModelGateway(options: ModelGatewayOptions): ModelGateway {
  const { governance, logger } = options;

  function resolve(ref: ModelBindingRef): ResolvedModelTarget {
    let providerId: string;
    let model: string | undefined;
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
    return { provider, adapter, model: model ?? provider.model };
  }

  function logProviderError(
    error: ModelProviderError,
    target: ResolvedModelTarget,
    attribution?: ModelAttribution
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
        ...(attribution?.kind === "agent_run" ? { runId: attribution.runId } : {})
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
      signal: call.signal,
      deadline: call.deadline
    };
    for (;;) {
      policy.assertAttemptMayStart();
      const attempt = { retrySafe: true };
      const preparingToolCallIds: string[] = [];
      try {
        if (!streaming) {
          const completion = await target.adapter.complete(request);
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
   * The one call path: resolve, check the capabilities, admit, call, record. A call that is
   * refused before or at admission records nothing. Every admitted call records exactly one
   * usage event, whether it completed, failed, was stopped or was left unread by its caller.
   */
  async function* run(
    call: ModelCall,
    streaming: boolean
  ): AsyncGenerator<ModelCallStreamEvent, void, void> {
    const target = resolve(call.binding);
    assertWithinCapabilities(call, target, streaming);
    if (call.attribution.kind !== "agent_run") {
      // The usage event has no columns for a system call yet, and no call goes out unrecorded.
      throw new AppError(
        "INTERNAL",
        `A model call with attribution '${call.attribution.kind}' cannot be recorded yet`
      );
    }
    const policy = createModelRetryPolicy({ signal: call.signal, deadline: call.deadline });
    policy.assertAttemptMayStart();
    const admission = await holdAdmission(governance, {
      clientInstanceId: call.clientInstanceId,
      attribution: call.attribution
    });
    const seen: { completion?: ModelCompletion } = {};
    const settle = async (answerHandedOn: boolean): Promise<void> => {
      try {
        await governance.recordModelUsage({
          clientInstanceId: call.clientInstanceId,
          attribution: call.attribution,
          providerId: target.provider.id,
          model: target.model,
          ...(target.provider.region ? { region: target.provider.region } : {}),
          fastMode: call.fastTier === true,
          correlationId: call.correlationId,
          ...(seen.completion?.usage ?? USAGE_OF_UNCOMPLETED_CALL)
        });
      } catch (recordError) {
        if (answerHandedOn) {
          // A call whose usage could not be recorded fails, so no answer goes unrecorded.
          throw recordError;
        }
        logger.error(
          {
            type: "model_usage.record_failed",
            providerId: target.provider.id,
            model: target.model,
            error: recordError
          },
          "Usage of a model call that did not complete could not be recorded"
        );
      } finally {
        await admission.release();
      }
    };
    let ended: "completed" | "failed" | "left_unread" = "left_unread";
    try {
      yield* attempts(call, target, streaming, policy, seen);
      ended = "completed";
    } catch (error) {
      ended = "failed";
      throw error;
    } finally {
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
    },
    unsettled: {
      async complete(request, context) {
        const target = resolve({ providerId: request.providerId, model: request.model });
        try {
          return await target.adapter.complete({
            model: target.model,
            messages: request.messages,
            tools: request.tools,
            reasoningEffort: request.reasoningEffort,
            fastTier: request.fastMode,
            continuation: request.continuation,
            signal: context.signal,
            deadline: context.deadline
          });
        } catch (thrown) {
          const error = normalizeModelAdapterError(thrown);
          if (error instanceof ModelProviderError) {
            logProviderError(error, target);
          }
          throw modelCallFailureFor(error);
        }
      }
    }
  };
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

/**
 * Admits a call and keeps its place until `release`. Admission is a function that wraps the
 * call; a streamed call hands events to its caller in between, so the place is held open here.
 */
async function holdAdmission(
  governance: ModelCallGovernance,
  call: { clientInstanceId: ClientInstanceId; attribution: ModelAttribution }
): Promise<{ release(): Promise<void> }> {
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let held: Promise<void> = Promise.resolve();
  await new Promise<void>((admitted, refused) => {
    held = governance.runModelCall(call, () => {
      admitted();
      return finished;
    });
    // A refusal settles before `execute` runs; afterwards this rejection has no reader.
    held.catch(refused);
  });
  return {
    async release() {
      finish();
      await held;
    }
  };
}
