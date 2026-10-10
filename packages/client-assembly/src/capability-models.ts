import type { ClientInstanceCapabilityModels } from "@vivd-catalyst/capability-sdk";
import {
  AppError,
  type ClientInstanceId,
  type ModelBindingConfig,
  type ModelProviderConfig,
  type PlatformStores
} from "@vivd-catalyst/core";
import { type ClientInstanceConfig, getModelProviderConfigs } from "@vivd-catalyst/config-schema";
import {
  createInstanceModelGateway,
  unbilledModelProviderIds,
  type ModelGateway
} from "@vivd-catalyst/model-provider";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import type { InstanceInfrastructure } from "./infrastructure";

/** The model gateway as a capability sees it: calls for the capability's own purposes. */
function createCapabilityModels(input: {
  gateway: ModelGateway;
  clientInstanceId: ClientInstanceId;
  providers: readonly ModelProviderConfig[];
  bindings: readonly ModelBindingConfig[];
}): ClientInstanceCapabilityModels {
  const { gateway, clientInstanceId } = input;
  return {
    async complete(call) {
      const completion = await gateway.complete({
        binding: { bindingId: call.bindingId },
        messages: [{ role: "user", content: call.content }],
        tools: [],
        ...(call.output ? { output: call.output } : {}),
        attribution: {
          kind: "system",
          purpose: call.purpose,
          ...(call.userId === undefined ? {} : { userId: call.userId }),
          ...(call.conversationId === undefined ? {} : { conversationId: call.conversationId })
        },
        clientInstanceId,
        correlationId: call.correlationId,
        ...(call.signal ? { signal: call.signal } : {}),
        ...(call.deadline ? { deadline: call.deadline } : {})
      });
      return { text: completion.text };
    },
    describeBinding(bindingId) {
      const binding = input.bindings.find((candidate) => candidate.id === bindingId);
      const provider = input.providers.find((candidate) => candidate.id === binding?.providerId);
      if (!binding || !provider) {
        throw new AppError("NOT_FOUND", `Model binding '${bindingId}' is not defined`);
      }
      const capabilities = gateway.capabilities({ bindingId });
      return {
        providerId: provider.id,
        model: binding.model ?? provider.model,
        ...(provider.region ? { region: provider.region } : {}),
        documentInput: capabilities.documentInput,
        structuredOutput: capabilities.structuredOutput
      };
    }
  };
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
  return {
    governance,
    gateway,
    capabilityModels: createCapabilityModels({
      gateway,
      clientInstanceId: input.clientInstanceId,
      providers,
      bindings
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
