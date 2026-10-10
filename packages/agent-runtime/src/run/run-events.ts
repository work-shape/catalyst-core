import {
  AppError,
  asToolCallId,
  getRuntimeSubjectUserId,
  type ConfigAssetSource,
  type AgentRunStore,
  type AgentRunStatus,
  type Clock,
  type ConversationHistoryStore,
  type ModelBindingConfig,
  type ModelProviderContinuationStore,
  type ModelProviderConfig,
  type RunObservationStore,
  type ToolExecution,
  type WebAccessConfig,
  type AgentRunId,
  type AgentRuntimeEvent,
  type RuntimeCallContext,
  type StartAgentRunInput
} from "@vivd-catalyst/core";
import type { ModelCall, ModelCompletion, ModelGateway } from "@vivd-catalyst/model-provider";
import type { RunState, RunFailureError } from "../run-state";
import type {
  StoredReasoningSummary,
  ModelContextArtifactReader,
  ModelContextFileReader,
  ModelContextProjectionOptions
} from "../model-context-projection";
import type { ModelToolRegistryView } from "../model-tool-materialization";

export interface LocalAgentRuntimeOptions {
  logger?: import("@vivd-catalyst/core").Logger;
  assetSource: ConfigAssetSource;
  modelProviders: ModelProviderConfig[];
  modelBindings?: readonly ModelBindingConfig[];
  defaultModelProvider: ModelProviderConfig;
  conversationHistory: ConversationHistoryStore;
  modelProviderContinuationStore?: ModelProviderContinuationStore;
  agentRunStore?: AgentRunStore;
  runObservationStore?: RunObservationStore;
  /** The only way a run reaches a model. It admits, retries and records usage. */
  modelGateway: ModelGateway;
  toolRegistry: ModelToolRegistryView;
  toolExecution: ToolExecution;
  webAccess?: WebAccessConfig;
  agentSkillChangesEnabled?: boolean;
  historyMessageLimit?: number;
  maxSteps?: number;
  repeatedToolCallLimit?: number;
  modelContext?: ModelContextProjectionOptions;
  artifactReader?: ModelContextArtifactReader;
  clock?: Clock;
  fileReader?: ModelContextFileReader;
  runFailureReporter?: (report: LocalAgentRunFailureReport) => void | Promise<void>;
  beforeEffect?: (effect: LocalAgentRuntimeEffect) => void | Promise<void>;
}

export interface LocalAgentRuntimeEffect {
  kind: "provider_request" | "assistant_message" | "tool_dispatch" | "tool_result_message";
  runId: AgentRunId;
}

export interface LocalAgentRunFailureReport {
  runId: AgentRunId;
  input: StartAgentRunInput;
  context: RuntimeCallContext;
  failure: RunFailureError;
  error: unknown;
}

export class RunEvents {
  constructor(private readonly options: LocalAgentRuntimeOptions) {}

  reportRunFailure(report: LocalAgentRunFailureReport): void {
    if (!this.options.runFailureReporter) {
      return;
    }
    try {
      void Promise.resolve(this.options.runFailureReporter(report)).catch(() => undefined);
    } catch {
      // A diagnostics sink must not change the user-visible run outcome.
    }
  }

  async beforeEffect(kind: LocalAgentRuntimeEffect["kind"], runId: AgentRunId) {
    await this.options.beforeEffect?.({ kind, runId });
  }

  async persistRunEvent(
    input: StartAgentRunInput,
    context: RuntimeCallContext,
    event: AgentRuntimeEvent
  ): Promise<void> {
    try {
      await this.options.runObservationStore?.appendRunObservation({
        clientInstanceId: context.clientInstanceId,
        runId: event.runId,
        conversationId: input.conversationId,
        ownerUserId: getRuntimeSubjectUserId(context),
        event
      });
    } catch (error) {
      await this.options.agentRunStore?.updateAgentRunStatus({
        clientInstanceId: context.clientInstanceId,
        runId: event.runId,
        status: "failed",
        updatedAt: event.createdAt,
        failedAt: event.createdAt,
        lastSequence: event.sequence,
        error: {
          code: "OBSERVATION_PERSISTENCE_FAILED",
          message: "Agent run observation persistence failed",
          category: "internal_error"
        }
      });
      throw error;
    }

    if (event.type === "run_completed") {
      await this.options.agentRunStore?.updateAgentRunStatus({
        clientInstanceId: context.clientInstanceId,
        runId: event.runId,
        status: "completed",
        updatedAt: event.createdAt,
        completedAt: event.createdAt,
        lastSequence: event.sequence
      });
      return;
    }

    if (event.type === "run_cancelled") {
      await this.options.agentRunStore?.updateAgentRunStatus({
        clientInstanceId: context.clientInstanceId,
        runId: event.runId,
        status: "cancelled",
        updatedAt: event.createdAt,
        cancelledAt: event.createdAt,
        lastSequence: event.sequence
      });
      return;
    }

    if (event.type === "run_failed") {
      await this.options.agentRunStore?.updateAgentRunStatus({
        clientInstanceId: context.clientInstanceId,
        runId: event.runId,
        status: "failed",
        updatedAt: event.createdAt,
        failedAt: event.createdAt,
        lastSequence: event.sequence,
        error: event.error
      });
    }
  }

  /**
   * Sends one call through the gateway and turns what it yields into run events. The gateway
   * retries and records usage; this only reports.
   */
  async streamModelCall(
    call: ModelCall,
    state: RunState
  ): Promise<{
    completion: ModelCompletion;
    emittedDeltas: boolean;
    reasoning: StoredReasoningSummary[];
  }> {
    if (!this.options.modelGateway.capabilities(call.binding).streaming) {
      return {
        completion: await this.options.modelGateway.complete(call),
        emittedDeltas: false,
        reasoning: []
      };
    }
    let completion: ModelCompletion | undefined;
    let emittedDeltas = false;
    let streamedText = "";
    const reasoningById = new Map<string, string>();
    for await (const event of this.options.modelGateway.stream(call)) {
      if (event.type === "text_delta") {
        if (event.delta.length > 0) {
          emittedDeltas = true;
          streamedText += event.delta;
          state.emit({
            type: "message_delta",
            runId: state.runId,
            delta: event.delta
          });
        }
        continue;
      }
      if (event.type === "reasoning_delta") {
        if (event.delta.length > 0) {
          reasoningById.set(event.id, `${reasoningById.get(event.id) ?? ""}${event.delta}`);
          state.emit({
            type: "reasoning_delta",
            runId: state.runId,
            id: event.id,
            delta: event.delta
          });
        }
        continue;
      }
      if (event.type === "tool_call_preparing") {
        state.emit({
          type: "tool_call_preparing",
          runId: state.runId,
          toolCallId: asToolCallId(event.toolCallId),
          toolName: event.toolName
        });
        continue;
      }
      if (event.type === "tool_call_preparation_cancelled") {
        state.emit({
          type: "tool_call_preparation_cancelled",
          runId: state.runId,
          toolCallId: asToolCallId(event.toolCallId)
        });
        continue;
      }
      if (event.type === "provider_tool_started") {
        state.emit({
          type: "tool_call_started",
          runId: state.runId,
          toolCallId: asToolCallId(event.toolCallId),
          toolName: event.toolName,
          input: event.input ?? {}
        });
        continue;
      }
      if (event.type === "provider_tool_completed") {
        state.emit({
          type: "tool_call_completed",
          runId: state.runId,
          toolCallId: asToolCallId(event.toolCallId),
          toolName: event.toolName,
          result: {
            status: "success",
            output: event.output ?? {}
          },
          modelOutput: ""
        });
        continue;
      }
      completion = event.completion;
      // Text the provider did not stream is shown as soon as the answer is here, before the
      // gateway records the call's usage.
      const unstreamedText = getUnstreamedCompletionText(
        completion.text,
        streamedText,
        emittedDeltas
      );
      if (unstreamedText.length > 0) {
        emittedDeltas = true;
        state.emit({
          type: "message_delta",
          runId: state.runId,
          delta: unstreamedText
        });
      }
    }

    if (!completion) {
      throw new AppError("INTERNAL", "Model provider stream ended without a completion");
    }

    return {
      completion,
      emittedDeltas,
      reasoning: [...reasoningById.entries()]
        .map(([id, text]) => ({ id, text }))
        .filter((summary) => summary.text.length > 0)
    };
  }
}

function getUnstreamedCompletionText(
  completionText: string,
  streamedText: string,
  emittedDeltas: boolean
): string {
  if (completionText.length === 0) {
    return "";
  }
  if (!emittedDeltas) {
    return completionText;
  }
  return completionText.startsWith(streamedText) ? completionText.slice(streamedText.length) : "";
}

export function isCancellationRequested(status: AgentRunStatus): boolean {
  return status === "cancelling" || status === "cancelled";
}
