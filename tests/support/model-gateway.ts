import type { Logger, ModelBindingConfig, ModelProviderConfig } from "@vivd-catalyst/core";
import type { LocalAgentRuntimeOptions } from "@vivd-catalyst/agent-runtime";
import {
  createModelGateway,
  DETERMINISTIC_CAPABILITIES,
  WEB_SEARCH_MODEL_TOOL_NAME,
  openAiCompatibleCapabilities,
  type ModelAdapter,
  type ModelBindingRef,
  type ModelCallGovernance,
  type ModelCapabilities,
  type ModelCompletion,
  type ModelCompletionRequest,
  type ModelCompletionStreamEvent,
  type ModelGateway,
  type ModelTransportContext
} from "@vivd-catalyst/model-provider";
import { REASONING_EFFORTS } from "@vivd-catalyst/core";
import { getModelProviderConfigs, type ClientInstanceConfig } from "@vivd-catalyst/config-schema";

/** A provider as tests script it: it answers whatever entry the call names. */
export interface FakeModelProvider {
  id: string;
  complete(
    request: ModelCompletionRequest,
    context: ModelTransportContext
  ): Promise<ModelCompletion>;
  stream?(
    request: ModelCompletionRequest,
    context: ModelTransportContext
  ): AsyncIterable<ModelCompletionStreamEvent>;
}

/** Everything a call can ask for, so a scripted provider is refused nothing. */
export const ALL_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEfforts: REASONING_EFFORTS,
  nativeTools: [WEB_SEARCH_MODEL_TOOL_NAME],
  serverCompaction: true,
  continuation: true,
  fastTier: true,
  imageInput: true,
  documentInput: true,
  structuredOutput: true,
  streaming: true
};

export const silentTestLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentTestLogger;
  }
};

export function adapterFromFakeProvider(
  entry: Pick<ModelProviderConfig, "id">,
  provider: FakeModelProvider,
  capabilities: Partial<ModelCapabilities> = {}
): ModelAdapter {
  const declared = {
    ...ALL_MODEL_CAPABILITIES,
    streaming: provider.stream !== undefined,
    ...capabilities
  };
  const stream = provider.stream?.bind(provider);
  return {
    capabilities: () => declared,
    complete: (request) =>
      provider.complete(
        {
          providerId: entry.id,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
          fastMode: request.fastTier,
          continuation: request.continuation,
          messages: request.messages,
          tools: request.tools
        },
        { signal: request.signal, deadline: request.deadline }
      ),
    async *stream(request) {
      if (!stream) {
        throw new Error("The scripted provider does not stream");
      }
      yield* stream(
        {
          providerId: entry.id,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
          fastMode: request.fastTier,
          continuation: request.continuation,
          messages: request.messages,
          tools: request.tools
        },
        { signal: request.signal, deadline: request.deadline }
      );
    }
  };
}

function createTestModelGateway(input: {
  modelProviders: readonly ModelProviderConfig[];
  modelBindings?: readonly ModelBindingConfig[];
  modelProvider: FakeModelProvider;
  usageGovernance: ModelCallGovernance;
  capabilities?: Partial<ModelCapabilities>;
  logger?: Logger;
}): ModelGateway {
  return createModelGateway({
    providers: input.modelProviders,
    bindings: input.modelBindings ?? [],
    adapters: new Map(
      input.modelProviders.map((entry) => [
        entry.id,
        adapterFromFakeProvider(entry, input.modelProvider, {
          // Server compaction is what the entry configures, as with a real adapter.
          serverCompaction: entry.contextManagement?.compaction !== undefined,
          ...input.capabilities
        })
      ])
    ),
    governance: input.usageGovernance,
    logger: input.logger ?? silentTestLogger
  });
}

interface ScriptedProviderOptions {
  modelProvider: FakeModelProvider;
  usageGovernance: ModelCallGovernance;
  modelCapabilities?: Partial<ModelCapabilities>;
}

/**
 * Runtime options for a test that scripts its provider: the provider and the usage governance
 * become the gateway the runtime calls.
 */
export function withTestModelGateway<
  Options extends ScriptedProviderOptions &
    Partial<Omit<LocalAgentRuntimeOptions, "modelGateway">> &
    Pick<LocalAgentRuntimeOptions, "modelProviders">
>(options: Options): Omit<Options, keyof ScriptedProviderOptions> & { modelGateway: ModelGateway } {
  const { modelProvider, usageGovernance, modelCapabilities, ...rest } = options;
  return {
    ...rest,
    modelGateway: createTestModelGateway({
      modelProviders: options.modelProviders,
      modelBindings: options.modelBindings,
      modelProvider,
      usageGovernance,
      capabilities: modelCapabilities,
      logger: options.logger
    })
  };
}

/**
 * What the built-in adapters declare for the models of a config, without creating them. For a
 * test that validates a config and has no gateway.
 */
export function builtInModelCapabilities(
  config: Pick<ClientInstanceConfig, "infrastructure" | "modelBindings">
): (binding: ModelBindingRef) => ModelCapabilities {
  return (binding) => {
    const providerId =
      "bindingId" in binding
        ? config.modelBindings.find((candidate) => candidate.id === binding.bindingId)?.providerId
        : binding.providerId;
    const entry = getModelProviderConfigs(config).find((candidate) => candidate.id === providerId);
    if (!entry) {
      throw new Error(`No model provider '${providerId}' in the test config`);
    }
    return entry.type === "openai-compatible"
      ? openAiCompatibleCapabilities(entry)
      : DETERMINISTIC_CAPABILITIES;
  };
}
