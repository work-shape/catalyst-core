import {
  AppError,
  systemClock,
  unknownToJsonValue,
  type AgentRunId,
  type LocaleCode,
  type RuntimeCallContext,
  type StartAgentRunInput
} from "@vivd-catalyst/core";
import {
  isModelProviderContinuationRejected,
  type ModelCompletion,
  type ModelMessage
} from "@vivd-catalyst/model-provider";
import type { RunState } from "../run-state";
import { createSystemInstructions } from "../system-instructions";
import {
  createAssistantFinalMetadata,
  createAssistantToolCallsMetadata,
  createSubmittedUserMessageContent
} from "../model-context-projection";
import { materializeModelTools } from "../model-tool-materialization";
import {
  ModelInput,
  getProviderCompactionThreshold,
  getSnapshotAgentConfig,
  getSnapshotSkillMetadataForAgent
} from "./model-input";
import { isCancellationRequested, type RunEvents } from "./run-events";
import type { ToolDispatch } from "./tool-dispatch";
import type { LocalAgentRuntimeOptions } from "./run-events";

const DEFAULT_MAX_STEPS = 64;

export class TurnLoop {
  constructor(
    private readonly options: LocalAgentRuntimeOptions,
    private readonly modelInput: ModelInput,
    private readonly toolDispatch: ToolDispatch,
    private readonly runEvents: RunEvents
  ) {}

  async executeRun(
    state: RunState,
    runId: AgentRunId,
    input: StartAgentRunInput,
    context: RuntimeCallContext
  ): Promise<void> {
    const assets = await this.options.assetSource.getSnapshot();
    const agent = getSnapshotAgentConfig(assets, input.agentName);
    const modelSelection = this.modelInput.getModelSelectionForAgent(
      agent,
      input.modelBindingId,
      input.reasoningEffort
    );
    const { capabilities } = modelSelection;
    const tools = materializeModelTools({
      agent,
      capabilities,
      toolRegistry: this.options.toolRegistry,
      webAccess: this.options.webAccess
    });
    const compactThresholdTokens = getProviderCompactionThreshold(
      modelSelection.provider,
      capabilities
    );
    const compactionEnabled = compactThresholdTokens !== undefined;
    const history = await this.modelInput.loadModelHistory(
      input,
      context,
      modelSelection.provider,
      {
        compactionEnabled
      }
    );
    const userContent = await createSubmittedUserMessageContent(
      input.message.text,
      input.message.attachmentManifest,
      this.modelInput.modelContextOptions(context)
    );
    const systemMessage: ModelMessage = {
      role: "system",
      content: createSystemInstructions(agent.instructions, context.locale, {
        currentDate: this.options.clock?.now() ?? systemClock.now(),
        skills: getSnapshotSkillMetadataForAgent(assets, agent),
        agentToolNames: agent.toolNames,
        agentSkillChangesEnabled: this.options.agentSkillChangesEnabled
      })
    };
    const userMessage: ModelMessage = { role: "user", content: userContent };
    let messages: ModelMessage[] = [systemMessage, ...history.messages, userMessage];

    const repeatedToolCalls = new Map<string, number>();
    const maxSteps = agent.maxSteps ?? this.options.maxSteps ?? DEFAULT_MAX_STEPS;
    let providerContinuation: ModelCompletion["continuation"] = history.providerContinuation;
    // True until the first answer: only then does a request carry a continuation from an earlier run.
    let carriesEarlierContinuation = providerContinuation !== undefined;
    let runCompacted = false;
    const callModel = () =>
      this.modelInput.callModel(
        runId,
        input,
        context,
        messages,
        modelSelection,
        tools,
        providerContinuation,
        state,
        this.runEvents
      );

    for (let step = 0; step < maxSteps; step += 1) {
      const modelResult = await callModel().catch(async (error: unknown) => {
        if (!carriesEarlierContinuation || !isModelProviderContinuationRejected(error)) {
          throw error;
        }
        // The provider can never accept this continuation, so every message of the conversation
        // would fail. Drop it and send the request once more from the conversation's history.
        carriesEarlierContinuation = false;
        await this.options.modelProviderContinuationStore?.deleteModelProviderContinuation({
          clientInstanceId: context.clientInstanceId,
          conversationId: input.conversationId,
          providerId: modelSelection.provider.id,
          runFence: context.runFence
        });
        this.options.logger?.warn(
          {
            type: "model_provider_continuation.dropped",
            runId,
            conversationId: input.conversationId,
            providerId: modelSelection.provider.id
          },
          "Model provider continuation dropped; request rebuilt from history"
        );
        const rebuilt = await this.modelInput.loadModelHistory(
          input,
          context,
          modelSelection.provider,
          {
            compactionEnabled,
            withoutCheckpoint: true
          }
        );
        providerContinuation = undefined;
        messages = [systemMessage, ...rebuilt.messages, userMessage];
        return callModel();
      });
      carriesEarlierContinuation = false;
      const { completion, emittedDeltas, reasoning } = modelResult;
      providerContinuation = completion.continuation;
      const compactedThisCall = completion.contextManagement?.compacted === true;
      runCompacted ||= compactedThisCall;
      const modelContext =
        compactThresholdTokens === undefined
          ? undefined
          : {
              inputTokens: completion.usage.inputTokens,
              compactThresholdTokens,
              compacted: runCompacted
            };
      const persistedContinuation =
        compactedThisCall && providerContinuation
          ? {
              providerId: providerContinuation.providerId,
              state: unknownToJsonValue(providerContinuation.state)
            }
          : undefined;

      if (completion.toolCalls.length === 0) {
        if (context.signal?.aborted || isCancellationRequested(state.getStatus())) {
          return;
        }
        const assistantText = completion.text || completedWithoutTextFallback(context.locale);
        await this.runEvents.beforeEffect("assistant_message", runId);
        const persisted = await this.options.conversationHistory.appendAssistantMessage({
          clientInstanceId: context.clientInstanceId,
          conversationId: input.conversationId,
          text: assistantText,
          metadata: createAssistantFinalMetadata({
            runId,
            reasoning,
            sources: completion.sources,
            citations: completion.citations,
            modelContext
          }),
          providerContinuation: persistedContinuation
        });
        if (emittedDeltas) {
          state.completeMessage(persisted);
        } else {
          state.message(persisted);
        }
        state.complete();
        return;
      }

      if (compactedThisCall) {
        removePreCompactionMessages(messages);
      }
      messages.push({
        role: "assistant",
        content: completion.text,
        toolCalls: completion.toolCalls
      });
      await this.runEvents.beforeEffect("assistant_message", runId);
      await this.options.conversationHistory.appendAssistantMessage({
        clientInstanceId: context.clientInstanceId,
        conversationId: input.conversationId,
        text: completion.text,
        metadata: createAssistantToolCallsMetadata({
          runId,
          toolCalls: completion.toolCalls,
          reasoning,
          modelContext
        }),
        providerContinuation: persistedContinuation
      });

      if (
        await this.toolDispatch.dispatchToolCalls(
          runId,
          input,
          context,
          state,
          completion.toolCalls,
          repeatedToolCalls,
          messages
        )
      ) {
        return;
      }
    }

    state.fail(new AppError("CONFLICT", `Agent exceeded the maximum step limit of ${maxSteps}`));
  }
}

function removePreCompactionMessages(messages: ModelMessage[]): void {
  const firstNonSystemIndex = messages.findIndex((message) => message.role !== "system");
  if (firstNonSystemIndex >= 0) {
    messages.splice(firstNonSystemIndex);
  }
}

/**
 * Used when the model finishes a run without producing any closing text.
 * Follows the run's locale so it does not break out of the conversation
 * language the way a hardcoded English sentence did.
 */
function completedWithoutTextFallback(locale: LocaleCode | undefined): string {
  return locale === "de" ? "Ich habe die Anfrage abgeschlossen." : "I completed the request.";
}
