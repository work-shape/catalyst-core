import {
  createPlatformId,
  type Logger,
  type ModelBindingConfig,
  type ModelProviderConfig,
  type ModelUsageEventInput
} from "@vivd-catalyst/core";
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

/** A provider that answers with whole completions only, so the runtime does not stream it. */
export function withoutStreaming(provider: FakeModelProvider): FakeModelProvider {
  return {
    id: provider.id,
    complete: (request, context) => provider.complete(request, context)
  };
}

/** A scripted usage governance with what it saw. */
export interface RecordingGovernance extends ModelCallGovernance {
  /** One record per admitted call: zero tokens from admission, the call's usage once settled. */
  recorded: ModelUsageEventInput[];
  admitted: number;
  /** Set to refuse every admission with this error. */
  refuseAdmission: Error | undefined;
  /** Set to fail every settlement with this error. */
  failSettlement: Error | undefined;
}

/**
 * A usage governance as gateway tests script it. Like the real one it holds one record per
 * admitted call, which stands at zero tokens until the call is settled.
 */
export function createRecordingGovernance(): RecordingGovernance {
  const records = new Map<string, ModelUsageEventInput>();
  const governance: RecordingGovernance = {
    recorded: [],
    admitted: 0,
    refuseAdmission: undefined,
    failSettlement: undefined,
    async admitModelCall(call) {
      if (governance.refuseAdmission) throw governance.refuseAdmission;
      governance.admitted += 1;
      const id = createPlatformId<"ModelUsageEventId">("usage");
      const record: ModelUsageEventInput = {
        ...call,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        source: "estimated",
        webSearchCallCount: 0
      };
      records.set(id, record);
      governance.recorded.push(record);
      return {
        id,
        clientInstanceId: call.clientInstanceId,
        providerId: call.providerId,
        model: call.model,
        fastMode: call.fastMode === true
      };
    },
    async settleModelCall(admitted, usage) {
      if (governance.failSettlement) throw governance.failSettlement;
      const record = records.get(admitted.id);
      if (record) Object.assign(record, usage);
    }
  };
  return governance;
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

/** A scripted provider where the test does not care which entry it stands for. */
export type ScriptedModelProvider = Omit<FakeModelProvider, "id"> &
  Partial<Pick<FakeModelProvider, "id">>;

export function adapterFromFakeProvider(
  entry: Pick<ModelProviderConfig, "id">,
  provider: ScriptedModelProvider,
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
 * The gateway of a test server: every model entry of the config answers through the scripted
 * provider and declares what its built-in adapter declares, so the server offers what the
 * product would offer for that config.
 */
export function createScriptedInstanceModelGateway(input: {
  config: Pick<ClientInstanceConfig, "infrastructure" | "modelBindings">;
  modelProvider: ScriptedModelProvider;
  usageGovernance: ModelCallGovernance;
  logger?: Logger;
}): ModelGateway {
  const capabilitiesOf = builtInModelCapabilities(input.config);
  return createModelGateway({
    providers: getModelProviderConfigs(input.config),
    bindings: input.config.modelBindings,
    adapters: new Map(
      getModelProviderConfigs(input.config).map((entry) => [
        entry.id,
        adapterFromFakeProvider(
          entry,
          input.modelProvider,
          capabilitiesOf({ providerId: entry.id })
        )
      ])
    ),
    governance: input.usageGovernance,
    logger: input.logger ?? silentTestLogger
  });
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
