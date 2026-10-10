import {
  AppError,
  defaultReasoningEffortForAgentBinding,
  isModelBindingUserSelectableForAgent,
  reasoningEffortChoiceForBinding,
  getRuntimeSubjectUserId,
  type AgentConfig,
  type AgentRunId,
  type ChatMessage,
  type ModelProviderConfig,
  type ReasoningEffortConfig,
  type RuntimeAssetSnapshot,
  type RuntimeCallContext,
  type SkillConfig,
  type StartAgentRunInput
} from "@vivd-catalyst/core";
import type {
  ModelBindingRef,
  ModelCapabilities,
  ModelCompletion,
  ModelMessage,
  ModelTool
} from "@vivd-catalyst/model-provider";
import {
  dropCurrentSubmittedMessage,
  projectAgentVisibleHistory,
  orderApprovalDecisionsForModel,
  readAssistantProviderContinuation,
  selectRecentCompleteHistory,
  type ModelContextProjectionOptions
} from "../model-context-projection";
import {
  applyModelInputImageBudget,
  MODEL_INPUT_IMAGES_MAX_BYTES
} from "../model-input-image-budget";
import type { RunState } from "../run-state";
import type { RunEvents } from "./run-events";
import type { LocalAgentRuntimeOptions } from "./run-events";

const DEFAULT_CONVERSATION_HISTORY_LIMIT = 20;
const DEFAULT_MODEL_CONTEXT: ModelContextProjectionOptions = {
  toolOutput: {
    maxTokens: 60000
  }
};

export class ModelInput {
  constructor(private readonly options: LocalAgentRuntimeOptions) {}

  getModelSelectionForAgent(
    agent: AgentConfig,
    userSelectedBindingId?: string,
    userSelectedReasoningEffort?: ReasoningEffortConfig
  ): {
    binding: ModelBindingRef;
    provider: ModelProviderConfig;
    capabilities: ModelCapabilities;
    reasoningEffort?: ReasoningEffortConfig;
    fastMode: boolean;
  } {
    const bindingId = userSelectedBindingId ?? agent.modelBindingId;
    if (bindingId) {
      const binding = this.options.modelBindings?.find((candidate) => candidate.id === bindingId);
      if (!binding) {
        throw new AppError("NOT_FOUND", `Model binding '${bindingId}' is not defined`);
      }
      if (
        userSelectedBindingId &&
        !isModelBindingUserSelectableForAgent(
          agent,
          this.options.modelBindings ?? [],
          userSelectedBindingId
        )
      ) {
        throw new AppError(
          "VALIDATION_FAILED",
          `Model binding '${bindingId}' is not available for user selection with agent '${agent.name}'`
        );
      }
      const provider = this.getModelProvider(binding.providerId);
      const capabilities = this.options.modelGateway.capabilities({ bindingId });
      const configuredEffort =
        defaultReasoningEffortForAgentBinding(agent, binding) ??
        (capabilities.reasoningEfforts.length > 0 ? provider.reasoningEffort : undefined);
      return {
        binding: { bindingId },
        provider,
        capabilities,
        // An effort the user picked wins while the binding still offers it; a pick the binding
        // no longer offers falls back to the configured effort instead of failing the run.
        reasoningEffort:
          userSelectedReasoningEffort &&
          reasoningEffortChoiceForBinding(
            binding,
            capabilities.reasoningEfforts,
            configuredEffort
          ).selectable.includes(userSelectedReasoningEffort)
            ? userSelectedReasoningEffort
            : configuredEffort,
        // A user-selected binding gets fast mode only when that binding supports it.
        fastMode: agent.fastMode === true && binding.supportsFastMode === true
      };
    }

    const provider = this.getModelProvider(
      agent.modelProviderId ?? this.options.defaultModelProvider.id
    );
    const capabilities = this.options.modelGateway.capabilities({ providerId: provider.id });
    return {
      binding: { providerId: provider.id },
      provider,
      capabilities,
      reasoningEffort:
        agent.reasoningEffort ??
        (capabilities.reasoningEfforts.length > 0 ? provider.reasoningEffort : undefined),
      fastMode: false
    };
  }

  private getModelProvider(providerId: string): ModelProviderConfig {
    const provider = this.options.modelProviders.find((candidate) => candidate.id === providerId);
    if (!provider) {
      throw new AppError("NOT_FOUND", `Model provider '${providerId}' is not defined`);
    }
    return provider;
  }

  async loadModelHistory(
    input: StartAgentRunInput,
    context: RuntimeCallContext,
    provider: ModelProviderConfig,
    options: { compactionEnabled: boolean; withoutCheckpoint?: boolean }
  ): Promise<{
    messages: ModelMessage[];
    providerContinuation?: ModelCompletion["continuation"];
  }> {
    const persistedMessages = await this.options.conversationHistory.listMessages({
      clientInstanceId: context.clientInstanceId,
      conversationId: input.conversationId
    });
    const history = orderApprovalDecisionsForModel(
      dropCurrentSubmittedMessage(persistedMessages, input.message.text, input.inputMessageId)
    );
    const { compactionEnabled } = options;
    if (options.withoutCheckpoint) {
      // What a conversation that never compacted sends: all of its history, no continuation.
      return {
        messages: await projectAgentVisibleHistory(
          compactionEnabled
            ? history
            : selectRecentCompleteHistory(
                history,
                this.options.historyMessageLimit ?? DEFAULT_CONVERSATION_HISTORY_LIMIT
              ),
          this.modelContextOptions(context)
        )
      };
    }
    const storedCheckpoint = compactionEnabled
      ? await this.options.modelProviderContinuationStore?.getModelProviderContinuation({
          clientInstanceId: context.clientInstanceId,
          conversationId: input.conversationId,
          providerId: provider.id
        })
      : undefined;
    const storedCheckpointIndex = storedCheckpoint
      ? history.findIndex((message) => message.id === storedCheckpoint.sourceMessageId)
      : -1;
    const legacyCheckpointIndex = compactionEnabled
      ? findLatestCompactionCheckpointIndex(history, provider.id)
      : -1;
    const checkpointIndex = Math.max(storedCheckpointIndex, legacyCheckpointIndex);
    const legacyCheckpoint =
      legacyCheckpointIndex >= 0
        ? readAssistantProviderContinuation(history[legacyCheckpointIndex]?.metadata)
        : undefined;
    const checkpoint =
      storedCheckpoint &&
      storedCheckpointIndex >= legacyCheckpointIndex &&
      storedCheckpointIndex >= 0
        ? {
            providerId: storedCheckpoint.providerId,
            state: storedCheckpoint.state
          }
        : legacyCheckpoint;
    const activeHistory = compactionEnabled
      ? history.slice(Math.max(checkpointIndex, 0))
      : selectRecentCompleteHistory(
          history,
          this.options.historyMessageLimit ?? DEFAULT_CONVERSATION_HISTORY_LIMIT
        );
    return {
      messages: await projectAgentVisibleHistory(activeHistory, this.modelContextOptions(context)),
      ...(checkpoint
        ? {
            providerContinuation: {
              providerId: checkpoint.providerId,
              state: checkpoint.state
            }
          }
        : {})
    };
  }

  modelContextOptions(context: RuntimeCallContext): ModelContextProjectionOptions {
    return {
      ...(this.options.modelContext ?? DEFAULT_MODEL_CONTEXT),
      clientInstanceId: context.clientInstanceId,
      artifactReader: this.options.artifactReader,
      logger: this.options.logger,
      fileReader: this.options.fileReader
    };
  }

  callModel(
    runId: AgentRunId,
    input: StartAgentRunInput,
    context: RuntimeCallContext,
    messages: ModelMessage[],
    modelSelection: ReturnType<ModelInput["getModelSelectionForAgent"]>,
    tools: ModelTool[],
    providerContinuation: ModelCompletion["continuation"],
    state: RunState,
    runEvents: RunEvents
  ) {
    const { capabilities } = modelSelection;
    const withinImageBudget = applyModelInputImageBudget(messages);
    if (withinImageBudget.omittedImageCount > 0) {
      this.options.logger?.warn(
        {
          type: "model_input.images_omitted",
          runId,
          conversationId: input.conversationId,
          omittedImageCount: withinImageBudget.omittedImageCount,
          maxBytes: MODEL_INPUT_IMAGES_MAX_BYTES
        },
        "Older images left out of the model request"
      );
    }
    // What the model does not take is left out here, so the gateway refuses nothing a
    // configuration of the agent asked for in passing.
    const reasoningEffort =
      modelSelection.reasoningEffort !== undefined &&
      capabilities.reasoningEfforts.includes(modelSelection.reasoningEffort)
        ? modelSelection.reasoningEffort
        : undefined;
    return runEvents.beforeEffect("provider_request", runId).then(() =>
      runEvents.streamModelCall(
        {
          binding: modelSelection.binding,
          messages: withinImageBudget.messages,
          tools,
          reasoningEffort,
          fastTier: modelSelection.fastMode && capabilities.fastTier,
          continuation: capabilities.continuation ? providerContinuation : undefined,
          attribution: {
            kind: "agent_run",
            conversationId: input.conversationId,
            runId,
            agentName: input.agentName,
            userId: getRuntimeSubjectUserId(context)
          },
          clientInstanceId: context.clientInstanceId,
          correlationId: context.correlationId,
          signal: context.signal,
          deadline: context.deadline
        },
        state
      )
    );
  }
}

export function getProviderCompactionThreshold(
  provider: ModelProviderConfig,
  capabilities: Pick<ModelCapabilities, "serverCompaction">
): number | undefined {
  return capabilities.serverCompaction
    ? provider.contextManagement?.compaction?.compactThresholdTokens
    : undefined;
}

function findLatestCompactionCheckpointIndex(messages: ChatMessage[], providerId: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const continuation = readAssistantProviderContinuation(messages[index]?.metadata);
    if (continuation?.providerId === providerId) {
      return index;
    }
  }
  return -1;
}

export function getSnapshotAgentConfig(
  assets: RuntimeAssetSnapshot,
  agentName: string
): AgentConfig {
  const agent = assets.agents.find((candidate) => candidate.name === agentName);
  if (!agent) {
    throw new AppError("NOT_FOUND", `Agent '${agentName}' is not defined`);
  }
  return agent;
}

export function getSnapshotSkillMetadataForAgent(assets: RuntimeAssetSnapshot, agent: AgentConfig) {
  const skillNames = agent.skillNames ?? [];
  if (skillNames.length === 0 || assets.skills.length === 0) {
    return [];
  }
  const skillsByName = new Map(assets.skills.map((skill) => [skill.name, skill]));
  return skillNames
    .map((skillName) => skillsByName.get(skillName))
    .filter((skill): skill is SkillConfig => Boolean(skill))
    .map(({ name, title, description }) => ({
      name,
      title,
      description
    }));
}
