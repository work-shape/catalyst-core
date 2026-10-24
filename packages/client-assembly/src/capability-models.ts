import type { ClientInstanceCapabilityModels } from "@work-shape/catalyst-capability-sdk";
import {
  AppError,
  asAgentRunId,
  requirePersonalDataModelRoute,
  type AgentRunId,
  type ClientInstanceId,
  type ConversationId,
  type ModelBindingConfig,
  type ModelProviderConfig,
  type PlatformStores
} from "@work-shape/catalyst-core";
import {
  type ClientInstanceConfig,
  getModelProviderConfigs
} from "@work-shape/catalyst-config-schema";
import {
  createInstanceModelGateway,
  unbilledModelProviderIds,
  type ModelGateway
} from "@work-shape/catalyst-model-provider";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import type { InstanceInfrastructure } from "./infrastructure";

/** The model gateway as a capability sees it: calls for the capability's own purposes. */
function createCapabilityModels(input: {
  gateway: ModelGateway;
  clientInstanceId: ClientInstanceId;
  providers: readonly ModelProviderConfig[];
  bindings: readonly ModelBindingConfig[];
  costs: ClientInstanceConfig["usage"]["costs"];
  personalData?: CapabilityPersonalDataGate;
}): ClientInstanceCapabilityModels {
  const { gateway, clientInstanceId } = input;
  /**
   * The effort the binding is configured with, where its model takes it. A model that takes
   * none is called without one, as an agent run calls it.
   */
  const configuredEffort = (bindingId: string) => {
    const binding = input.bindings.find((candidate) => candidate.id === bindingId);
    const provider = input.providers.find((candidate) => candidate.id === binding?.providerId);
    const configured = binding?.reasoningEffort ?? provider?.reasoningEffort;
    return configured !== undefined &&
      gateway.capabilities({ bindingId }).reasoningEfforts.includes(configured)
      ? configured
      : undefined;
  };
  return {
    async complete(call) {
      const { personalData } = input;
      if (personalData && call.conversationId !== undefined) {
        const { conversationId, agentRunId } = call;
        const binding = input.bindings.find((candidate) => candidate.id === call.bindingId);
        const provider = input.providers.find((candidate) => candidate.id === binding?.providerId);
        await requirePersonalDataModelRoute({
          route: provider ?? {},
          allowed: personalData.allowed,
          marked: () =>
            personalData.marked(
              conversationId,
              agentRunId === undefined ? undefined : asAgentRunId(agentRunId)
            )
        });
      }
      const reasoningEffort =
        call.reasoningEffort === "configured" ? configuredEffort(call.bindingId) : undefined;
      const completion = await gateway.complete({
        binding: { bindingId: call.bindingId },
        messages: [
          ...(call.instructions === undefined
            ? []
            : [{ role: "system" as const, content: call.instructions }]),
          { role: "user", content: call.content }
        ],
        tools: [],
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(call.output ? { output: call.output } : {}),
        ...(call.maxOutputTokens === undefined ? {} : { maxOutputTokens: call.maxOutputTokens }),
        attribution: {
          kind: "system",
          purpose: call.purpose,
          ...(call.userId === undefined ? {} : { userId: call.userId }),
          ...(call.conversationId === undefined ? {} : { conversationId: call.conversationId }),
          ...(call.workspaceId === undefined ? {} : { workspaceId: call.workspaceId }),
          ...(call.operationRunId === undefined ? {} : { operationRunId: call.operationRunId })
        },
        clientInstanceId,
        correlationId: call.correlationId,
        ...(call.signal ? { signal: call.signal } : {}),
        ...(call.deadline ? { deadline: call.deadline } : {})
      });
      // A capability offers the model no tool, so an answer that calls one is no answer.
      if (completion.toolCalls.length > 0) {
        throw new AppError("INTERNAL", "A capability's model call cannot call tools");
      }
      return { text: completion.text, usage: completion.usage };
    },
    describeBinding(bindingId) {
      const binding = input.bindings.find((candidate) => candidate.id === bindingId);
      const provider = input.providers.find((candidate) => candidate.id === binding?.providerId);
      if (!binding || !provider) {
        throw new AppError("NOT_FOUND", `Model binding '${bindingId}' is not defined`);
      }
      const capabilities = gateway.capabilities({ bindingId });
      const model = binding.model ?? provider.model;
      const card = input.costs.customer;
      const rate = card?.models.find(
        (rate) => rate.providerId === provider.id && rate.model === model
      );
      return {
        providerId: provider.id,
        model,
        ...(rate && card
          ? {
              price: {
                currency: card.currency,
                inputPerMillionTokens: rate.uncachedInputPricePerMillionTokens,
                outputPerMillionTokens: rate.outputPricePerMillionTokens
              }
            }
          : {}),
        ...(provider.region ? { region: provider.region } : {}),
        documentInput: capabilities.documentInput,
        structuredOutput: capabilities.structuredOutput
      };
    }
  };
}

/**
 * MODEL-REGION-3: a capability's call that names a conversation holding personal data goes only
 * to a route in `allowed`, as every request of an agent run in it does. Set where the Connections
 * module is on and the process reads conversations.
 */
export interface CapabilityPersonalDataGate {
  allowed: readonly string[];
  /** The root's personal-data mark; a read that fails counts as marked. */
  marked(conversationId: ConversationId, agentRunId: AgentRunId | undefined): Promise<boolean>;
}

/** The model gateway of an instance with the governance its calls are admitted and settled by. */
export interface InstanceModels {
  governance: ModelUsageGovernance;
  gateway: ModelGateway;
  /** The gateway as the instance's capabilities see it. */
  capabilityModels: ClientInstanceCapabilityModels;
}

/**
 * Creates the model providers of an instance and the gateway in front of them. With
 * `bindingIds`, only the providers behind those bindings are created, so a worker process of a
 * capability needs the secrets of those alone. Every process admits and records its calls the
 * same way: all write the same usage ledger.
 */
export async function createInstanceModels(input: {
  config: ClientInstanceConfig;
  clientInstanceId: ClientInstanceId;
  infrastructure: InstanceInfrastructure;
  store: Pick<PlatformStores, "usage">;
  bindingIds?: readonly string[];
  personalData?: CapabilityPersonalDataGate;
}): Promise<InstanceModels> {
  const { config, bindingIds } = input;
  const allProviders = getModelProviderConfigs(config);
  const bindings = bindingIds
    ? config.modelBindings.filter((binding) => bindingIds.includes(binding.id))
    : config.modelBindings;
  const providers = bindingIds
    ? allProviders.filter((provider) =>
        bindings.some((binding) => binding.providerId === provider.id)
      )
    : allProviders;
  const governance = new ModelUsageGovernance({
    store: input.store.usage,
    budget: config.usage.budget,
    safeguards: config.usage.safeguards,
    costs: config.usage.costs,
    freeProviderIds: unbilledModelProviderIds(allProviders)
  });
  const gateway = await createInstanceModelGateway({
    registry: input.infrastructure.registry,
    providers,
    entries: config.infrastructure.models,
    context: input.infrastructure.context,
    bindings,
    governance
  });
  for (const binding of bindings) {
    // Every agent run offers tools. A binding agents can choose must be on a model that calls
    // them through its adapter, or each run on it would be refused at its first model call.
    if (
      binding.agentSelectable !== false &&
      !gateway.capabilities({ bindingId: binding.id }).toolCalls
    ) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Model binding '${binding.id}' can be chosen for agents, but provider '${binding.providerId}' does not support tool calls, which every agent run needs: set 'agentSelectable: false' on the binding`
      );
    }
  }
  // What a call can name: a binding, or a provider entry with the entry's own model.
  const callable = [
    ...bindings.map((binding) => ({
      named: `Model binding '${binding.id}'`,
      ref: { bindingId: binding.id },
      providerId: binding.providerId,
      model: binding.model ?? allProviders.find(({ id }) => id === binding.providerId)?.model
    })),
    ...providers.map((provider) => ({
      named: `Model provider '${provider.id}'`,
      ref: { providerId: provider.id },
      providerId: provider.id,
      model: provider.model
    }))
  ];
  for (const { named, ref, providerId, model } of callable) {
    if (!gateway.capabilities(ref).priceRequired) continue;
    const rate = config.usage.costs.customer?.models.find(
      (candidate) => candidate.providerId === providerId && candidate.model === model
    );
    const priced =
      rate !== undefined &&
      rate.uncachedInputPricePerMillionTokens > 0 &&
      rate.cachedInputPricePerMillionTokens > 0 &&
      rate.outputPricePerMillionTokens > 0;
    if (!priced) {
      // The model id is not repeated: for this provider it holds the account id.
      throw new AppError(
        "VALIDATION_FAILED",
        `${named} has no price: its provider bills every token, so 'usage.costs.customer.models' needs a row with this provider id and model and a price above zero for uncached input, cached input and output`
      );
    }
  }
  return {
    governance,
    gateway,
    capabilityModels: createCapabilityModels({
      gateway,
      clientInstanceId: input.clientInstanceId,
      providers,
      bindings,
      costs: config.usage.costs,
      ...(input.personalData ? { personalData: input.personalData } : {})
    })
  };
}

/** The models of an instance for a worker process of a capability, which has no API around it. */
export async function createWorkerCapabilityModels(input: {
  config: ClientInstanceConfig;
  clientInstanceId: ClientInstanceId;
  infrastructure: InstanceInfrastructure;
  store: Pick<PlatformStores, "usage">;
  bindingIds: readonly string[];
}): Promise<ClientInstanceCapabilityModels> {
  return (await createInstanceModels(input)).capabilityModels;
}
