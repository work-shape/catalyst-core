import { WEB_FETCH_TOOL_NAME } from "@work-shape/catalyst-web-access";
import {
  AppError,
  defaultReasoningEffortForAgentBinding,
  isModelBindingUserSelectableForAgent,
  reasoningEffortChoiceForBinding,
  getRuntimeSubjectUserId,
  requirePersonalDataModelRoute,
  type AgentConfig,
  type AgentRunId,
  type ChatMessage,
  type ModelBindingConfig,
  type ModelProviderConfig,
  type ReasoningEffortConfig,
  type RuntimeAssetSnapshot,
  type RuntimeCallContext,
  type SkillConfig,
  type StartAgentRunInput
} from "@work-shape/catalyst-core";
import {
  WEB_SEARCH_MODEL_TOOL_NAME,
  type ModelBindingRef,
  type ModelCapabilities,
  type ModelCompletion,
  type ModelMessage,
  type ModelTool
} from "@work-shape/catalyst-model-provider";
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
    maxTokens: 12000
  }
};

/** The model a run's calls go to, and what the run asks of it. */
export interface ModelSelection {
  binding: ModelBindingRef;
  provider: ModelProviderConfig;
  /** The model the provider is asked for. */
  model: string;
  /** The name release config gives the binding's model, where it gives one. */
  label?: string;
  capabilities: ModelCapabilities;
  reasoningEffort?: ReasoningEffortConfig;
  fastMode: boolean;
}

export class ModelInput {
  constructor(private readonly options: LocalAgentRuntimeOptions) {}

  getModelSelectionForAgent(
    agent: AgentConfig,
    userSelectedBindingId?: string,
    userSelectedReasoningEffort?: ReasoningEffortConfig
  ): ModelSelection {
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
      return this.selectionForBinding(agent, binding, userSelectedReasoningEffort);
    }

    const provider = this.getModelProvider(
      agent.modelProviderId ?? this.options.defaultModelProvider.id
    );
    const capabilities = this.options.modelGateway.capabilities({ providerId: provider.id });
    return {
      binding: { providerId: provider.id },
      provider,
      model: provider.model,
      capabilities,
      reasoningEffort:
        agent.reasoningEffort ??
        (capabilities.reasoningEfforts.length > 0 ? provider.reasoningEffort : undefined),
      fastMode: false
    };
  }

  /**
   * The binding a run switches to when its own binding's route fails: the `fallback` its binding
   * names, where the agent keeps fallback on and the fallback is a chat binding in the binding's
   * region. Effort, fast mode and capabilities are the fallback's, as the agent sets them for it;
   * an effort the person picked for the binding does not carry over. Whether the agent's
   * workspace allows the fallback is the caller's question.
   */
  getFallbackSelection(agent: AgentConfig, selection: ModelSelection): ModelSelection | undefined {
    if (agent.useModelFallback === false || !("bindingId" in selection.binding)) return undefined;
    const bindings = this.options.modelBindings ?? [];
    const { bindingId } = selection.binding;
    const fallbackId = bindings.find((candidate) => candidate.id === bindingId)?.fallback;
    const fallback = bindings.find((candidate) => candidate.id === fallbackId);
    if (!fallback || fallback.id === bindingId || fallback.kind === "embedding") return undefined;
    const provider = this.options.modelProviders.find(
      (candidate) => candidate.id === fallback.providerId
    );
    if (!provider || provider.region !== selection.provider.region) return undefined;
    return this.selectionForBinding(agent, fallback);
  }

  private selectionForBinding(
    agent: AgentConfig,
    binding: ModelBindingConfig,
    userSelectedReasoningEffort?: ReasoningEffortConfig
  ): ModelSelection {
    const provider = this.getModelProvider(binding.providerId);
    const capabilities = this.options.modelGateway.capabilities({ bindingId: binding.id });
    const configuredEffort =
      defaultReasoningEffortForAgentBinding(agent, binding) ??
      (capabilities.reasoningEfforts.length > 0 ? provider.reasoningEffort : undefined);
    return {
      binding: { bindingId: binding.id },
      provider,
      model: binding.model ?? provider.model,
      ...(binding.label === undefined ? {} : { label: binding.label }),
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
    options: {
      compactionEnabled: boolean;
      withoutCheckpoint?: boolean;
      /**
       * The model the run asks for. Given, the continuation the conversation's last run ended
       * with on it is sent again, so the request starts as that run's last one did.
       */
      model?: string;
    }
  ): Promise<{
    messages: ModelMessage[];
    providerContinuation?: ModelCompletion["continuation"];
    /** The continuation is the last run's reasoning on the model, not the compaction checkpoint. */
    fromTurn?: true;
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
    const compactionCheckpoint =
      storedCheckpoint &&
      storedCheckpointIndex >= legacyCheckpointIndex &&
      storedCheckpointIndex >= 0
        ? {
            providerId: storedCheckpoint.providerId,
            state: storedCheckpoint.state
          }
        : legacyCheckpoint;
    // The last run's continuation holds the checkpoint's and its own steps' reasoning. Another
    // model could not read that reasoning, and one written before the checkpoint lacks it.
    const turn =
      options.model === undefined
        ? undefined
        : await this.options.modelProviderContinuationStore?.getModelProviderTurnContinuation({
            clientInstanceId: context.clientInstanceId,
            conversationId: input.conversationId,
            providerId: provider.id
          });
    const turnIndex =
      turn && turn.model === options.model
        ? history.findIndex((message) => message.id === turn.sourceMessageId)
        : -1;
    const fromTurn = turn !== undefined && turnIndex >= 0 && turnIndex >= checkpointIndex;
    const checkpoint = fromTurn
      ? { providerId: turn.providerId, state: turn.state }
      : compactionCheckpoint;
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
            },
            ...(fromTurn ? { fromTurn: true as const } : {})
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

  /**
   * Re-read the permanent mark until it is seen: a sibling subagent may have made the personal
   * call. Its own flag, not web access: web access may be off where the mark was never read.
   */
  async personalDataMarked(
    runId: AgentRunId,
    state: RunState,
    input: StartAgentRunInput
  ): Promise<boolean> {
    if (!state.holdsPersonalData() && this.options.personalData) {
      const restricted = await this.options.personalData.personalConversation(
        input.conversationId,
        runId
      );
      if (restricted) state.notePersonalData();
    }
    return state.holdsPersonalData();
  }

  async webAccessOff(
    runId: AgentRunId,
    state: RunState,
    input: StartAgentRunInput
  ): Promise<boolean> {
    if (!state.isWebAccessOff()) await this.personalDataMarked(runId, state, input);
    return state.isWebAccessOff();
  }

  async callModel(
    runId: AgentRunId,
    input: StartAgentRunInput,
    context: RuntimeCallContext,
    messages: ModelMessage[],
    modelSelection: ModelSelection,
    tools: ModelTool[],
    providerContinuation: ModelCompletion["continuation"],
    state: RunState,
    runEvents: RunEvents,
    /** The run switches to another model when this one's route fails (`ModelCall.hasFallback`). */
    hasFallback = false
  ) {
    const { capabilities } = modelSelection;
    // MODEL-REGION-3: a conversation with personal data keeps every request on an allowed
    // route. Asked before each request, so a later turn, a resumed run, a subagent's parent and
    // a run whose sibling made the personal call mid-run are all held to it.
    const allowed = this.options.personalModelRegions;
    if (allowed) {
      await requirePersonalDataModelRoute({
        route: modelSelection.provider,
        allowed,
        marked: () => this.personalDataMarked(runId, state, input)
      });
    }
    // Materialization stays fixed for the run. Only this privacy restriction can remove
    // tools between requests; native search must never be offered with personal data.
    const requestTools = (await this.webAccessOff(runId, state, input))
      ? tools.filter(
          (tool) => tool.name !== WEB_SEARCH_MODEL_TOOL_NAME && tool.name !== WEB_FETCH_TOOL_NAME
        )
      : tools;
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
          tools: requestTools,
          ...(input.workflowAgent && capabilities.structuredOutput
            ? { output: { jsonSchema: input.workflowAgent.outputSchema } }
            : {}),
          reasoningEffort,
          fastTier: modelSelection.fastMode && capabilities.fastTier,
          continuation: capabilities.continuation ? providerContinuation : undefined,
          cacheKey: modelCacheKeyOf(input),
          ...(hasFallback ? { hasFallback: true } : {}),
          attribution: {
            kind: input.workflowAgent ? "workflow_step" : "agent_run",
            ...(input.workflowAgent ? { workflowRunId: input.workflowAgent.workflowRunId } : {}),
            conversationId: input.conversationId,
            runId,
            agentName: input.agentName,
            // A published step's run acts as its principal and counts to its Workflow Run; a
            // draft test's run acts as the tester and counts to them (check 103).
            ...(input.workflowAgent && !context.workflowDraft
              ? {}
              : { userId: getRuntimeSubjectUserId(context) })
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

/**
 * What every model call of a run sends as its cache key, so the steps and later turns of one
 * conversation reach the same prompt cache: the Workflow Run of a Workflow step, the
 * conversation of the run above a subagent, the run's own conversation otherwise.
 */
function modelCacheKeyOf(
  input: Pick<StartAgentRunInput, "conversationId" | "parentConversationId" | "workflowAgent">
): string {
  return input.workflowAgent?.workflowRunId ?? input.parentConversationId ?? input.conversationId;
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

/**
 * The skills an agent is told of in one conversation: those its definition lists, then those
 * the conversation is offered, each once. A name no stored skill has is left out.
 */
export function getSnapshotSkillMetadata(
  assets: RuntimeAssetSnapshot,
  agent: AgentConfig,
  offeredSkillNames: readonly string[]
) {
  const skillNames = [...new Set([...(agent.skillNames ?? []), ...offeredSkillNames])];
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
