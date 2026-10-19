import { compileJsonSchema } from "@work-shape/catalyst-connections";
import { collectKnowledgeCitations } from "./knowledge-citations";
import {
  AppError,
  WorkflowAgentOutputInvalidError,
  WORKFLOW_STEP_DATA_MAX_BYTES,
  SUBJECT_TOOL_PREFIX,
  systemClock,
  unknownToJsonValue,
  type AgentConfig,
  type KnowledgeCitationSource,
  type AgentRunId,
  type AgentRunResumeState,
  type LocaleCode,
  type PausedToolCall,
  type RuntimeCallContext,
  type StartAgentRunInput
} from "@work-shape/catalyst-core";
import {
  isModelProviderContinuationRejected,
  withStorableToolInput,
  type ModelCompletion,
  type ModelMessage,
  type ModelTool,
  type ModelToolCall
} from "@work-shape/catalyst-model-provider";
import type { RunState } from "../run-state";
import { createSystemInstructions } from "../system-instructions";
import {
  createAssistantFinalMetadata,
  createAssistantToolCallsMetadata,
  createSubmittedUserMessageContent
} from "../model-context-projection";
import { describeAgentDataTools, materializeModelTools } from "../model-tool-materialization";
import {
  ModelInput,
  getProviderCompactionThreshold,
  getSnapshotAgentConfig,
  getSnapshotSkillMetadata
} from "./model-input";
import { isCancellationRequested, type RunEvents } from "./run-events";
import { answerSubagents, finishPausedStep, pauseRun, resumedModelMessages } from "./resume-entry";
import type { ToolDispatch } from "./tool-dispatch";
import { isRunAgentCall } from "./subagents";
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
    const setup = await this.prepareRun(runId, input, context);
    const entry = input.resume
      ? await this.resumeEntry(state, runId, input, context, setup, input.resume.state)
      : await this.startEntry(runId, input, context, setup);
    if (entry) await this.runSteps(state, runId, input, context, setup, entry);
  }

  /** What every step of the run uses: its agent, model, tools and the start of its input. */
  private async prepareRun(
    runId: AgentRunId,
    input: StartAgentRunInput,
    context: RuntimeCallContext
  ): Promise<RunSetup> {
    const assets = await this.options.assetSource.getSnapshot();
    const listed: AgentConfig = input.workflowAgent
      ? {
          name: input.agentName,
          instructions: input.workflowAgent.instructions,
          toolNames: [...input.workflowAgent.toolNames],
          skillNames: [],
          displayName: { en: input.agentName, de: input.agentName },
          initialPrompts: []
        }
      : getSnapshotAgentConfig(assets, input.agentName);
    // An agent whose definition lists the platform's tools is offered those it lists, the
    // orientation on the platform and the skills the platform ships. The asset tools come from
    // the offer alone, which may hold back one the definition lists.
    const offer = input.workflowAgent
      ? undefined
      : await this.options.conversationOffer?.offerOf({
          clientInstanceId: context.clientInstanceId,
          conversationId: input.conversationId,
          agentToolNames: listed.toolNames,
          user: context.user
        });
    const withheld = new Set(offer?.withheldToolNames ?? []);
    // A subagent starts none of its own, and a Workflow step's agent never gets `run_agent`.
    const agent = {
      ...listed,
      toolNames: [
        ...new Set([
          ...listed.toolNames.filter((toolName) => !toolName.startsWith(SUBJECT_TOOL_PREFIX)),
          ...(offer?.toolNames ?? [])
        ])
      ].filter(
        (toolName) =>
          !withheld.has(toolName) &&
          !((context.subagent || input.workflowAgent) && isRunAgentCall(toolName))
      )
    };
    const modelSelection = this.modelInput.getModelSelectionForAgent(
      agent,
      input.modelBindingId,
      input.reasoningEffort
    );
    const { capabilities } = modelSelection;
    // Read once for the run, not for each model call of it: what the agent is offered stays
    // the same while it works. Whether a tool may still be called is asked again by each call,
    // and a data tool that was not offered here is refused for the whole run.
    const dataTools = await describeAgentDataTools(
      agent,
      this.options.dataTools,
      this.options.dataToolDescribeTimeoutMs
    );
    if (dataTools.sourceFailure) {
      this.options.logger?.warn(
        {
          type: "agent_run.data_tools_unavailable",
          runId,
          agentName: agent.name,
          reason: dataTools.sourceFailure,
          toolNames: dataTools.missing
        },
        "The data tools of an agent could not be read; the run goes on without them"
      );
    } else if (dataTools.missing.length > 0) {
      this.options.logger?.info(
        {
          type: "agent_run.data_tools_missing",
          runId,
          agentName: agent.name,
          toolNames: dataTools.missing
        },
        "Agent lists data tools that do not exist now; the run goes on without them"
      );
    }
    const offeredDataTools = new Set(dataTools.described.map((tool) => tool.name));
    const tools = materializeModelTools({
      agent,
      capabilities,
      toolRegistry: this.options.toolRegistry,
      dataTools: dataTools.described,
      webAccess: this.options.webAccess
    });
    const compactThresholdTokens = getProviderCompactionThreshold(
      modelSelection.provider,
      capabilities
    );
    const compactionEnabled = compactThresholdTokens !== undefined;
    const userContent = await createSubmittedUserMessageContent(
      input.message.text,
      input.message.attachmentManifest,
      this.modelInput.modelContextOptions(context)
    );
    const systemMessage: ModelMessage = {
      role: "system",
      content: createSystemInstructions(
        agent.instructions +
          (input.workflowAgent
            ? `\nReturn only JSON matching this output schema: ${JSON.stringify(input.workflowAgent.outputSchema)}`
            : ""),
        context.locale,
        {
          currentDate: this.options.clock?.now() ?? systemClock.now(),
          skills: getSnapshotSkillMetadata(assets, agent, offer?.skillNames ?? []),
          agentToolNames: agent.toolNames,
          agentSkillChangesEnabled: this.options.agentSkillChangesEnabled,
          ...(offer?.orientation ? { orientation: offer.orientation } : {}),
          ...(offer?.subject ? { subject: { ...offer, subject: offer.subject } } : {})
        }
      )
    };
    const userMessage: ModelMessage = { role: "user", content: userContent };
    return {
      modelSelection,
      tools,
      offeredDataTools,
      compactThresholdTokens,
      compactionEnabled,
      systemMessage,
      userMessage,
      maxSteps: agent.maxSteps ?? this.options.maxSteps ?? DEFAULT_MAX_STEPS
    };
  }

  /** A run that starts: the conversation's history, then its input message. */
  private async startEntry(
    runId: AgentRunId,
    input: StartAgentRunInput,
    context: RuntimeCallContext,
    setup: RunSetup
  ): Promise<StepEntry> {
    const { modelSelection, compactionEnabled, systemMessage, userMessage } = setup;
    const history = await this.modelInput.loadModelHistory(
      input,
      context,
      modelSelection.provider,
      { compactionEnabled }
    );
    return {
      messages: [systemMessage, ...history.messages, userMessage],
      firstStep: 0,
      repeatedToolCalls: new Map(),
      providerContinuation: history.providerContinuation,
      runCompacted: false,
      modelInputFrom: { kind: "input" },
      rebuildWithoutContinuation: async () => {
        // The provider can never accept this continuation, so every message of the
        // conversation would fail. Drop it and send the request once more from the
        // conversation's history.
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
          { compactionEnabled, withoutCheckpoint: true }
        );
        return [systemMessage, ...rebuilt.messages, userMessage];
      }
    };
  }

  /**
   * A run that waited for a decision and was decided: the model's input as it was when the run
   * paused, the paused step's calls answered, and the next step sent with the continuation of
   * the paused step. `undefined` when the run stopped or waits again.
   */
  private async resumeEntry(
    state: RunState,
    runId: AgentRunId,
    input: StartAgentRunInput,
    context: RuntimeCallContext,
    setup: RunSetup,
    resume: AgentRunResumeState
  ): Promise<StepEntry | undefined> {
    const messages = await resumedModelMessages({
      runId,
      startInput: input,
      context,
      resume,
      modelInput: this.modelInput,
      conversationHistory: this.options.conversationHistory,
      provider: setup.modelSelection.provider,
      compactionEnabled: setup.compactionEnabled,
      systemMessage: setup.systemMessage,
      userMessage: setup.userMessage
    });
    const repeatedToolCalls = new Map(Object.entries(resume.repeatedToolCalls));
    const finished = await finishPausedStep({
      runId,
      startInput: input,
      context,
      state,
      resume,
      runDecidedTool: this.options.runDecidedTool,
      modelInput: this.modelInput,
      toolDispatch: this.toolDispatch,
      repeatedToolCalls,
      messages,
      offeredDataTools: setup.offeredDataTools
    });
    if (finished.kind === "stopped") return undefined;
    // The subagents the step started before it paused, and those it started since.
    const subagents = [...(resume.subagents ?? []), ...finished.subagents];
    if (finished.kind === "paused") {
      pauseRun(state, finished, {
        ...resume,
        doneToolCallIds: [...resume.doneToolCallIds, ...finished.answeredToolCallIds],
        repeatedToolCalls: Object.fromEntries(repeatedToolCalls),
        ...(subagents.length > 0 ? { subagents } : {})
      });
      return undefined;
    }
    if (subagents.length > 0) {
      const settled = await answerSubagents({
        runId,
        startInput: input,
        context,
        state,
        reader: this.options.subagents,
        subagents,
        resume: {
          step: resume.step,
          stepMessageId: resume.stepMessageId,
          modelInputFrom: resume.modelInputFrom,
          toolCalls: resume.toolCalls,
          repeatedToolCalls: Object.fromEntries(repeatedToolCalls),
          ...(resume.providerContinuation
            ? { providerContinuation: resume.providerContinuation }
            : {}),
          compacted: resume.compacted
        },
        modelInput: this.modelInput,
        toolDispatch: this.toolDispatch,
        messages
      });
      if (settled !== "answered") return undefined;
    }
    return {
      messages,
      firstStep: resume.step + 1,
      repeatedToolCalls,
      providerContinuation: resume.providerContinuation,
      runCompacted: resume.compacted,
      modelInputFrom: resume.modelInputFrom,
      // A continuation the provider refuses is left out; the messages hold the run all the same.
      rebuildWithoutContinuation: () => Promise.resolve(messages)
    };
  }

  private async runSteps(
    state: RunState,
    runId: AgentRunId,
    input: StartAgentRunInput,
    context: RuntimeCallContext,
    setup: RunSetup,
    entry: StepEntry
  ): Promise<void> {
    const { modelSelection, tools, offeredDataTools, compactThresholdTokens, maxSteps } = setup;
    const { repeatedToolCalls } = entry;
    const knowledgeSources = new Map<string, KnowledgeCitationSource>();
    collectKnowledgeCitations(entry.messages, knowledgeSources);
    let { messages, providerContinuation, runCompacted, modelInputFrom } = entry;
    // True until the first answer: only then does a request carry a continuation from an earlier run.
    let carriesEarlierContinuation = providerContinuation !== undefined;
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

    for (let step = entry.firstStep; step < maxSteps; step += 1) {
      const modelResult = await callModel().catch(async (error: unknown) => {
        if (!carriesEarlierContinuation || !isModelProviderContinuationRejected(error)) {
          throw error;
        }
        carriesEarlierContinuation = false;
        messages = await entry.rebuildWithoutContinuation();
        providerContinuation = undefined;
        return callModel();
      });
      carriesEarlierContinuation = false;
      const { completion, emittedDeltas, reasoning } = modelResult;
      const toolCalls = completion.toolCalls.map(withStorableToolInput);
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

      if (toolCalls.length === 0) {
        if (context.signal?.aborted || isCancellationRequested(state.getStatus())) {
          return;
        }
        let assistantText = completion.text || completedWithoutTextFallback(context.locale);
        if (input.workflowAgent) {
          const schema = compileJsonSchema(input.workflowAgent.outputSchema);
          const invalid = (text: string): string | undefined => {
            if (Buffer.byteLength(text, "utf8") > WORKFLOW_STEP_DATA_MAX_BYTES)
              return `output exceeds ${WORKFLOW_STEP_DATA_MAX_BYTES} bytes`;
            try {
              const value: unknown = JSON.parse(text);
              if (!schema.ok) return "schema";
              const [issue] = schema.validate(value);
              return issue ? issue.path.join(".") || "output" : undefined;
            } catch {
              return "JSON";
            }
          };
          const issue = invalid(assistantText);
          if (issue) {
            const repairPrompt = `The output is invalid at ${issue}. Repair the rejected answer to match the output schema. Return JSON only. No tools may be called.`;
            // The repair prompt is kept with the answer it rejects, so the transcript shows it.
            await this.runEvents.beforeEffect("assistant_message", runId);
            await this.options.conversationHistory.appendAssistantMessage({
              clientInstanceId: context.clientInstanceId,
              conversationId: input.conversationId,
              text: assistantText,
              metadata: { workflowRejectedOutput: true, workflowRepairPrompt: repairPrompt }
            });
            messages.push(
              { role: "assistant", content: assistantText },
              { role: "user", content: repairPrompt }
            );
            const repair = await this.modelInput.callModel(
              runId,
              input,
              context,
              messages,
              modelSelection,
              [],
              undefined,
              state,
              this.runEvents
            );
            assistantText = repair.completion.text;
            const secondIssue = invalid(assistantText);
            if (secondIssue || repair.completion.toolCalls.length > 0) {
              await this.runEvents.beforeEffect("assistant_message", runId);
              await this.options.conversationHistory.appendAssistantMessage({
                clientInstanceId: context.clientInstanceId,
                conversationId: input.conversationId,
                text: assistantText,
                metadata: { workflowRejectedOutput: true }
              });
              throw new WorkflowAgentOutputInvalidError(secondIssue ?? "toolCalls");
            }
          }
        }
        await this.runEvents.beforeEffect("assistant_message", runId);
        const persisted = await this.options.conversationHistory.appendAssistantMessage({
          clientInstanceId: context.clientInstanceId,
          conversationId: input.conversationId,
          text: assistantText,
          metadata: createAssistantFinalMetadata({
            runId,
            reasoning,
            sources: completion.sources,
            knowledgeSources: [...knowledgeSources.values()].filter((source) =>
              assistantText.includes(`[${source.ref}]`)
            ),
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
        toolCalls
      });
      await this.runEvents.beforeEffect("assistant_message", runId);
      const stepMessage = await this.options.conversationHistory.appendAssistantMessage({
        clientInstanceId: context.clientInstanceId,
        conversationId: input.conversationId,
        text: completion.text,
        metadata: createAssistantToolCallsMetadata({
          runId,
          toolCalls,
          reasoning,
          modelContext
        }),
        providerContinuation: persistedContinuation
      });
      if (compactedThisCall) {
        modelInputFrom = { kind: "message", messageId: stepMessage.id };
      }

      const outcome = await this.toolDispatch.dispatchToolCalls(
        runId,
        input,
        context,
        state,
        toolCalls,
        repeatedToolCalls,
        messages,
        offeredDataTools
      );
      collectKnowledgeCitations(messages, knowledgeSources);
      if (outcome.kind === "stopped") return;
      const stepResume = {
        step,
        stepMessageId: stepMessage.id,
        modelInputFrom,
        toolCalls: toolCalls.map(toPausedToolCall),
        repeatedToolCalls: Object.fromEntries(repeatedToolCalls),
        ...(providerContinuation
          ? {
              providerContinuation: {
                providerId: providerContinuation.providerId,
                state: unknownToJsonValue(providerContinuation.state)
              }
            }
          : {}),
        compacted: runCompacted
      };
      if (outcome.kind === "paused") {
        pauseRun(state, outcome, {
          ...stepResume,
          doneToolCallIds: outcome.answeredToolCallIds,
          ...(outcome.subagents.length > 0 ? { subagents: outcome.subagents } : {})
        });
        return;
      }
      if (outcome.subagents.length > 0) {
        const settled = await answerSubagents({
          runId,
          startInput: input,
          context,
          state,
          reader: this.options.subagents,
          subagents: outcome.subagents,
          resume: stepResume,
          modelInput: this.modelInput,
          toolDispatch: this.toolDispatch,
          messages
        });
        if (settled !== "answered") return;
      }
    }

    state.fail(new AppError("CONFLICT", `Agent exceeded the maximum step limit of ${maxSteps}`));
  }
}

/** What every step of a run uses. */
interface RunSetup {
  modelSelection: ReturnType<ModelInput["getModelSelectionForAgent"]>;
  tools: ModelTool[];
  offeredDataTools: ReadonlySet<string>;
  compactThresholdTokens: number | undefined;
  compactionEnabled: boolean;
  systemMessage: ModelMessage;
  userMessage: ModelMessage;
  maxSteps: number;
}

/** Where the steps of a run start: a new run's first step, or the step after a paused one. */
interface StepEntry {
  messages: ModelMessage[];
  firstStep: number;
  repeatedToolCalls: Map<string, number>;
  providerContinuation: ModelCompletion["continuation"];
  runCompacted: boolean;
  modelInputFrom: AgentRunResumeState["modelInputFrom"];
  /** The messages to send when the provider refuses the continuation the first request carries. */
  rebuildWithoutContinuation(): Promise<ModelMessage[]>;
}

function toPausedToolCall(toolCall: ModelToolCall): PausedToolCall {
  return {
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    input: unknownToJsonValue(toolCall.input),
    ...(toolCall.inputParseError ? { inputParseError: toolCall.inputParseError } : {})
  };
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
