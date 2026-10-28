import { compileJsonSchema } from "@work-shape/catalyst-connections";
import { collectKnowledgeCitations } from "./knowledge-citations";
import {
  AppError,
  ASK_QUESTION_TOOL_NAME,
  DATA_STORE_USE_TOOL_NAME,
  WorkflowAgentOutputInvalidError,
  WORKFLOW_STEP_DATA_MAX_BYTES,
  forbiddenPreviewTool,
  SUBJECT_TOOL_PREFIX,
  WORKSPACE_OPEN_TOOL_NAME,
  asUserId,
  getRuntimeSubjectUserId,
  systemClock,
  unknownToJsonValue,
  agentRunInstructions,
  type AgentConfig,
  type AgentRunModelOrigin,
  type KnowledgeCitationSource,
  type AgentRunId,
  type AgentRunResumeState,
  type ConversationOfferSource,
  type LocaleCode,
  type PreviewViewerKey,
  type PausedToolCall,
  type ProjectInstructions,
  type RuntimeAssetSnapshot,
  type RuntimeCallContext,
  type StartAgentRunInput,
  type StoredModelFallback,
  withPreviewSkills
} from "@work-shape/catalyst-core";
import {
  ModelRouteFailedError,
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
import {
  describeAgentDataTools,
  materializeModelTools,
  type AgentDataTools
} from "../model-tool-materialization";
import {
  ModelInput,
  type ModelSelection,
  getProviderCompactionThreshold,
  getSnapshotAgentConfig,
  getSnapshotSkillMetadata
} from "./model-input";
import { isCancellationRequested, type RunEvents } from "./run-events";
import { answerSubagents, finishPausedStep, pauseRun, resumedModelMessages } from "./resume-entry";
import type { OpenedPreview, ToolDispatch } from "./tool-dispatch";
import { PreviewNotes, noteBeforeRequest, noteOnToolResult } from "./preview-notes";
import { isRunAgentCall } from "./subagents";
import { withToolResultRead } from "./tool-result-read";
import type { LocalAgentRuntimeOptions } from "./run-events";

const DEFAULT_MAX_STEPS = 64;
/** Tools that need the person of the turn: no subagent and no Workflow step is offered them. */
const PERSON_TOOL_NAMES: readonly string[] = [ASK_QUESTION_TOOL_NAME, DATA_STORE_USE_TOOL_NAME];

type ConversationOffer = Awaited<ReturnType<ConversationOfferSource["offerOf"]>>;

/** A model tool by what names it: its name, or its type for a provider's own tool. */
function modelToolKey(tool: ModelTool): string {
  return "name" in tool && typeof tool.name === "string" ? tool.name : JSON.stringify(tool);
}
/** The route id of a run above a subagent whose model cannot be read. It has no region. */
const UNREAD_ANCESTOR_ROUTE = "unread-ancestor";

export class TurnLoop {
  private readonly previewNotes: PreviewNotes | undefined;

  constructor(
    private readonly options: LocalAgentRuntimeOptions,
    private readonly modelInput: ModelInput,
    private readonly toolDispatch: ToolDispatch,
    private readonly runEvents: RunEvents
  ) {
    this.previewNotes = options.previewReports
      ? new PreviewNotes({
          reports: options.previewReports,
          ...(options.clock ? { clock: options.clock } : {})
        })
      : undefined;
  }

  async executeRun(
    state: RunState,
    runId: AgentRunId,
    input: StartAgentRunInput,
    context: RuntimeCallContext
  ): Promise<void> {
    if (input.preview) context = { ...context, agentPreview: input.preview };
    const setup = await this.prepareRun(runId, input, context);
    // A subagent's routes include those of the runs above it (MODEL-REGION-3): mail it reads
    // reaches its parent's model too, so a personal call needs every one of them allowed.
    context = {
      ...context,
      modelRoutes: [
        { id: setup.modelSelection.provider.id, region: setup.modelSelection.provider.region },
        ...setup.ancestorRoutes
      ]
    };
    const model = runModelOf(setup, input.resume?.state.modelFallback);
    const entry = input.resume
      ? await this.resumeEntry(state, runId, input, context, setup, model, input.resume.state)
      : await this.startEntry(runId, input, context, setup, model);
    if (entry) await this.runSteps(state, runId, input, context, setup, model, entry);
  }

  /** What every step of the run uses: its agent, model, tools and the start of its input. */
  private async prepareRun(
    runId: AgentRunId,
    input: StartAgentRunInput,
    context: RuntimeCallContext
  ): Promise<RunSetup> {
    // A Try turn tells the agent of the skill drafts it froze, as it reads them (SKILL-DRAFT-1).
    const assets = withPreviewSkills(await this.options.assetSource.getSnapshot(), input.preview);
    const listed: AgentConfig = input.workflowAgent
      ? {
          name: input.agentName,
          instructions: input.workflowAgent.instructions,
          toolNames: [...input.workflowAgent.toolNames],
          skillNames: [],
          displayName: { en: input.agentName, de: input.agentName },
          initialPrompts: []
        }
      : (input.preview?.config ?? getSnapshotAgentConfig(assets, input.agentName));
    // An agent whose definition lists the platform's tools is offered those it lists, the
    // orientation on the platform and the skills the platform ships. The asset tools come from
    // the offer alone, which may hold back one the definition lists.
    const offer = await this.offerOf(runId, listed, input, context);
    const projectInstructions = await this.projectInstructionsOf(runId, input, context);
    const { agent, dataTools } = await this.agentToolsOf(runId, listed, offer, input, context);
    const modelSelection = this.modelInput.getModelSelectionForAgent(
      agent,
      input.modelBindingId,
      input.reasoningEffort
    );
    // Read once for the run, not for each model call of it: what the agent is offered stays
    // the same while it works, except web tools removed after a personal call and the read
    // tools of a Data Store a step added (`reoffer`).
    const offeredDataTools = new Set(dataTools.described.map((tool) => tool.name));
    // What a model of the run is sent: the tools it takes and where its context compacts.
    const modelSetupOf = (selection: ModelSelection): ModelSetup => {
      const compactThresholdTokens = getProviderCompactionThreshold(
        selection.provider,
        selection.capabilities
      );
      return {
        modelSelection: selection,
        tools: this.modelToolsOf(agent, selection, dataTools.described),
        compactThresholdTokens,
        compactionEnabled: compactThresholdTokens !== undefined
      };
    };
    const { tools, compactThresholdTokens, compactionEnabled } = modelSetupOf(modelSelection);
    const fallbackSelection = this.modelInput.getFallbackSelection(agent, modelSelection);
    const fallback =
      fallbackSelection &&
      (await this.workspaceAllows(assets, input, context, fallbackSelection.binding))
        ? modelSetupOf(fallbackSelection)
        : undefined;
    const userContent = await createSubmittedUserMessageContent(
      input.message.text,
      input.message.attachmentManifest,
      this.modelInput.modelContextOptions(context)
    );
    const systemMessage: ModelMessage = {
      role: "system",
      content: createSystemInstructions(
        agentRunInstructions(agent) +
          (input.workflowAgent
            ? `\nReturn only JSON matching this output schema: ${JSON.stringify(input.workflowAgent.outputSchema)}`
            : ""),
        context.locale,
        {
          currentDate: this.options.clock?.now() ?? systemClock.now(),
          skills: getSnapshotSkillMetadata(assets, agent, [
            ...(offer?.skillNames ?? []),
            ...(offer?.personalSkillNames ?? [])
          ]),
          agentToolNames: agent.toolNames,
          agentSkillChangesEnabled: this.options.agentSkillChangesEnabled,
          ...(offer?.orientation ? { orientation: offer.orientation } : {}),
          ...(offer?.subject ? { subject: { ...offer, subject: offer.subject } } : {}),
          ...(offer?.projectFolder ? { projectFolder: offer.projectFolder } : {}),
          ...(projectInstructions ? { projectInstructions } : {})
        }
      )
    };
    const userMessage: ModelMessage = { role: "user", content: userContent };
    return {
      ...this.previewNotesOf(agent, input, context),
      modelSelection,
      ancestorRoutes: (input.ancestors ?? []).map((ancestor) => this.routeOf(assets, ancestor)),
      tools,
      offeredDataTools,
      listed,
      compactThresholdTokens,
      compactionEnabled,
      ...(fallback ? { fallback } : {}),
      systemMessage,
      userMessage,
      maxSteps: agent.maxSteps ?? this.options.maxSteps ?? DEFAULT_MAX_STEPS
    };
  }

  /** What the conversation offers the agent now. A Workflow step and a preview are offered nothing. */
  private async offerOf(
    runId: AgentRunId,
    listed: AgentConfig,
    input: StartAgentRunInput,
    context: RuntimeCallContext
  ): Promise<ConversationOffer | undefined> {
    return input.workflowAgent || input.preview
      ? undefined
      : this.options.conversationOffer?.offerOf({
          clientInstanceId: context.clientInstanceId,
          conversationId: input.conversationId,
          agentToolNames: listed.toolNames,
          user: context.user,
          runId
        });
  }

  /**
   * The project's instructions for the run (PRJ-3), read once at its start and recorded on it;
   * a run that goes on after a pause takes the version it recorded. A Workflow step and a
   * preview take none.
   */
  private async projectInstructionsOf(
    runId: AgentRunId,
    input: StartAgentRunInput,
    context: RuntimeCallContext
  ): Promise<ProjectInstructions | undefined> {
    if (input.workflowAgent || input.preview) return undefined;
    return this.options.conversationOffer?.projectInstructionsOf?.({
      clientInstanceId: context.clientInstanceId,
      conversationId: input.conversationId,
      ...(context.user ? { user: context.user } : {}),
      runId
    });
  }

  /**
   * The agent with the tools its definition lists and the offer gives it, and its data tools as
   * their source describes them now. Whether a tool may still be called is asked again by each
   * call, and a data tool that was not offered is refused.
   */
  private async agentToolsOf(
    runId: AgentRunId,
    listed: AgentConfig,
    offer: ConversationOffer | undefined,
    input: StartAgentRunInput,
    context: RuntimeCallContext
  ): Promise<{ agent: AgentConfig; dataTools: AgentDataTools }> {
    const withheld = new Set(offer?.withheldToolNames ?? []);
    // A subagent starts none of its own, and a Workflow step's agent never gets `run_agent`.
    // Neither has a person to ask (ASK-1) or to add a Data Store (STORE-USE-1).
    const agent = {
      ...listed,
      toolNames: [
        ...new Set([
          ...listed.toolNames.filter((toolName) => !toolName.startsWith(SUBJECT_TOOL_PREFIX)),
          ...(offer?.toolNames ?? [])
        ])
      ]
        .filter(
          (toolName) =>
            !withheld.has(toolName) &&
            !(
              (context.subagent || input.workflowAgent) &&
              (isRunAgentCall(toolName) || PERSON_TOOL_NAMES.includes(toolName))
            )
        )
        .filter((toolName) => !input.preview || !forbiddenPreviewTool(toolName))
    };
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
    return { agent, dataTools };
  }

  /** The tools a model of the run is sent for the agent. */
  private modelToolsOf(
    agent: AgentConfig,
    selection: ModelSelection,
    dataTools: AgentDataTools["described"]
  ): ModelTool[] {
    return withToolResultRead(
      materializeModelTools({
        agent,
        capabilities: selection.capabilities,
        toolRegistry: this.options.toolRegistry,
        dataTools,
        webAccess: this.options.webAccess
      })
    );
  }

  /**
   * Reads the conversation's offer again in the middle of the run, after a step added a Data
   * Store to it (STORE-USE-1): the store's read tools reach the next model request of this
   * turn. Nothing the run was offered is taken away; the system message stays as it was.
   */
  private async reoffer(
    runId: AgentRunId,
    input: StartAgentRunInput,
    context: RuntimeCallContext,
    setup: RunSetup,
    model: RunModel
  ): Promise<void> {
    const offer = await this.offerOf(runId, setup.listed, input, context);
    const { agent, dataTools } = await this.agentToolsOf(
      runId,
      setup.listed,
      offer,
      input,
      context
    );
    for (const tool of dataTools.described) setup.offeredDataTools.add(tool.name);
    const widen = (on: ModelSetup): ModelSetup => {
      const have = new Set(on.tools.map(modelToolKey));
      const added = this.modelToolsOf(agent, on.modelSelection, dataTools.described).filter(
        (tool) => !have.has(modelToolKey(tool))
      );
      return added.length === 0 ? on : { ...on, tools: [...on.tools, ...added] };
    };
    model.current = widen(model.current);
    if (model.fallback) model.fallback = widen(model.fallback);
  }

  /**
   * Whether the run notes what its previews reported (PREVIEW-STATUS-1), and whose browser's
   * reports it reads: the person whose turn it serves, never another member of the
   * conversation. A run with no person, such as a scheduled start, reads none, and every open
   * of it is "not viewed". A subagent and a Workflow step's agent note nothing.
   */
  private previewNotesOf(
    agent: AgentConfig,
    input: StartAgentRunInput,
    context: RuntimeCallContext
  ): Pick<RunSetup, "previewNotes"> {
    if (
      !this.previewNotes ||
      !agent.toolNames.includes(WORKSPACE_OPEN_TOOL_NAME) ||
      context.subagent ||
      context.workflowAgent ||
      input.workflowAgent
    ) {
      return {};
    }
    return {
      previewNotes: {
        viewer: context.unattended
          ? undefined
          : {
              clientInstanceId: context.clientInstanceId,
              conversationId: input.conversationId,
              userId: asUserId(getRuntimeSubjectUserId(context))
            }
      }
    };
  }

  /**
   * Notes on the result of the step's last open what the person's browser reported of that
   * revision, as the model reads it. Waits at most 6 seconds, and only while the person has a
   * preview mounted. A report that cannot be read leaves the result as it is.
   */
  private async noteOpenedPreview(
    runId: AgentRunId,
    setup: RunSetup,
    context: RuntimeCallContext,
    state: RunState,
    opened: readonly OpenedPreview[],
    messages: ModelMessage[]
  ): Promise<void> {
    const last = opened.at(-1);
    if (!this.previewNotes || !setup.previewNotes || !last || stopping(context, state)) return;
    try {
      const note = await this.previewNotes.afterOpen({
        viewer: setup.previewNotes.viewer,
        fileSetId: last.fileSetId,
        number: last.number,
        signal: context.signal
      });
      noteOnToolResult(messages, last.toolCallId, note);
    } catch {
      this.previewNoteUnavailable(runId);
    }
  }

  /** Notes, once, a report the person's browser sent since the last one the run's model read. */
  private async noteLaterPreview(
    runId: AgentRunId,
    setup: RunSetup,
    context: RuntimeCallContext,
    state: RunState,
    messages: ModelMessage[]
  ): Promise<void> {
    const viewer = setup.previewNotes?.viewer;
    // A run that stops takes nothing: what it took would be noted without a model reading it.
    if (!this.previewNotes || !viewer || stopping(context, state)) return;
    try {
      const note = await this.previewNotes.later(viewer);
      if (note) noteBeforeRequest(messages, note);
    } catch {
      this.previewNoteUnavailable(runId);
    }
  }

  /** The store's error names no value; the run goes on without the note. */
  private previewNoteUnavailable(runId: AgentRunId): void {
    this.options.logger?.warn(
      { type: "agent_run.preview_note_unavailable", runId },
      "A preview report could not be read; the run goes on without its note"
    );
  }

  /**
   * Whether the Shared Workspace that owns the run's agent allows the binding, by the list it
   * holds when the run starts. An agent of the instance, and one of a workspace without a list,
   * may use it.
   */
  private async workspaceAllows(
    assets: RuntimeAssetSnapshot,
    input: StartAgentRunInput,
    context: RuntimeCallContext,
    binding: ModelSelection["binding"]
  ): Promise<boolean> {
    const read = this.options.workspaceModelBindings;
    if (!read || !("bindingId" in binding)) return true;
    // A Workflow step's agent and a preview's are the run's own: its conversation's workspace
    // owns them. A named agent is owned where its definition is.
    const scope =
      input.workflowAgent || input.preview
        ? undefined
        : assets.agentKeys?.get(input.agentName)?.scope;
    if (scope?.kind === "instance") return true;
    const { clientInstanceId } = context;
    const allowed = await read(
      scope?.kind === "workspace"
        ? { clientInstanceId, workspaceId: scope.workspaceId }
        : { clientInstanceId, conversationId: input.conversationId }
    );
    return allowed === undefined || allowed.includes(binding.bindingId);
  }

  /**
   * The route a run above a subagent was started on. One whose model cannot be read now is a
   * route without a region, which no personal call passes.
   */
  private routeOf(
    assets: RuntimeAssetSnapshot,
    ancestor: AgentRunModelOrigin
  ): NonNullable<RuntimeCallContext["modelRoutes"]>[number] {
    try {
      const { provider } = this.modelInput.getModelSelectionForAgent(
        ancestor.preview?.config ?? getSnapshotAgentConfig(assets, ancestor.agentName),
        ancestor.modelBindingId
      );
      return { id: provider.id, region: provider.region };
    } catch {
      return { id: UNREAD_ANCESTOR_ROUTE };
    }
  }

  /** A run that starts: the conversation's history, then its input message. */
  private async startEntry(
    runId: AgentRunId,
    input: StartAgentRunInput,
    context: RuntimeCallContext,
    setup: RunSetup,
    model: RunModel
  ): Promise<StepEntry> {
    const { systemMessage, userMessage } = setup;
    // What a run on this model starts from: the history as that model's provider continues it.
    const historyFor = async (on: ModelSetup) => {
      const history = await this.modelInput.loadModelHistory(
        input,
        context,
        on.modelSelection.provider,
        { compactionEnabled: on.compactionEnabled, model: on.modelSelection.model }
      );
      return {
        messages: [systemMessage, ...history.messages, userMessage],
        providerContinuation: history.providerContinuation,
        ...(history.fromTurn ? { fromTurn: true as const } : {})
      };
    };
    const start = await historyFor(model.current);
    return {
      messages: start.messages,
      ownMessagesFrom: start.messages.length,
      firstStep: 0,
      repeatedToolCalls: new Map(),
      providerContinuation: start.providerContinuation,
      ...(start.fromTurn ? { fromTurn: true as const } : {}),
      runCompacted: false,
      modelInputFrom: { kind: "input" },
      historyFor,
      rebuildWithoutContinuation: async (on, fromTurn) => {
        const { provider } = on.modelSelection;
        // The provider can never accept this continuation, so every message of the
        // conversation would fail. Drop it and send the request once more. Refused reasoning
        // of the last run goes alone: the request goes on from the compaction checkpoint, so a
        // long conversation does not send all of its history. A refused checkpoint goes too,
        // and the request goes on from the conversation's history.
        await this.options.modelProviderContinuationStore?.deleteModelProviderContinuation({
          clientInstanceId: context.clientInstanceId,
          conversationId: input.conversationId,
          providerId: provider.id,
          ...(fromTurn ? { keepCheckpoint: true } : {}),
          runFence: context.runFence
        });
        this.options.logger?.warn(
          {
            type: "model_provider_continuation.dropped",
            runId,
            conversationId: input.conversationId,
            providerId: provider.id,
            continuation: fromTurn ? "turn" : "checkpoint"
          },
          fromTurn
            ? "Model provider reasoning dropped; request rebuilt from the checkpoint"
            : "Model provider continuation dropped; request rebuilt from history"
        );
        const rebuilt = await this.modelInput.loadModelHistory(input, context, provider, {
          compactionEnabled: on.compactionEnabled,
          ...(fromTurn ? {} : { withoutCheckpoint: true })
        });
        return {
          messages: [systemMessage, ...rebuilt.messages, userMessage],
          providerContinuation: rebuilt.providerContinuation
        };
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
    model: RunModel,
    resume: AgentRunResumeState
  ): Promise<StepEntry | undefined> {
    const messages = await resumedModelMessages({
      runId,
      startInput: input,
      context,
      resume,
      modelInput: this.modelInput,
      conversationHistory: this.options.conversationHistory,
      provider: model.current.modelSelection.provider,
      compactionEnabled: model.current.compactionEnabled,
      systemMessage: setup.systemMessage,
      userMessage: setup.userMessage
    });
    const repeatedToolCalls = new Map(Object.entries(resume.repeatedToolCalls));
    // The existing repeat counters survive a pause and include every attempted call of the
    // run, even before a compaction. Rebuild the in-memory restriction without new stored data.
    for (const key of repeatedToolCalls.keys()) {
      await this.toolDispatch.beforePersonalCall(key.slice(0, key.indexOf(":")), state);
    }
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
          compacted: resume.compacted,
          ...(model.switched ? { modelFallback: model.switched } : {})
        },
        modelInput: this.modelInput,
        toolDispatch: this.toolDispatch,
        messages
      });
      if (settled !== "answered") return undefined;
    }
    // A step that asked the person a question ends the turn, also when it paused (ASK-1).
    if (resume.toolCalls.some((call) => call.toolName === ASK_QUESTION_TOOL_NAME)) {
      state.complete();
      return undefined;
    }
    // The offer was read before the paused step's calls were answered: one that added a Data
    // Store brings its read tools now (STORE-USE-1).
    if (finished.offerChanged || resume.toolCalls.some(isDataStoreUse))
      await this.reoffer(runId, input, context, setup, model);
    return {
      messages,
      ownMessagesFrom: messages.length,
      firstStep: resume.step + 1,
      repeatedToolCalls,
      providerContinuation: resume.providerContinuation,
      runCompacted: resume.compacted,
      modelInputFrom: resume.modelInputFrom,
      // A continuation the provider refuses is left out; the messages hold the run all the same.
      rebuildWithoutContinuation: () => Promise.resolve(undefined)
    };
  }

  private async runSteps(
    state: RunState,
    runId: AgentRunId,
    input: StartAgentRunInput,
    context: RuntimeCallContext,
    setup: RunSetup,
    model: RunModel,
    entry: StepEntry
  ): Promise<void> {
    const { offeredDataTools, maxSteps } = setup;
    const { repeatedToolCalls } = entry;
    const knowledgeSources = new Map<string, KnowledgeCitationSource>();
    collectKnowledgeCitations(entry.messages, knowledgeSources);
    let { messages, providerContinuation, runCompacted, modelInputFrom, ownMessagesFrom } = entry;
    // True until the first answer: only then does a request carry a continuation from an earlier run.
    let carriesEarlierContinuation = providerContinuation !== undefined;
    // Whether that continuation is the last run's reasoning rather than the compaction checkpoint.
    let continuationFromTurn = entry.fromTurn === true;
    // The run's input from its history and its input message on: the history is taken again
    // where the run's model changes, the run's own messages are kept.
    const withHistory = (history: ModelMessage[]) => {
      messages = [...history, ...messages.slice(ownMessagesFrom)];
      ownMessagesFrom = history.length;
    };
    /**
     * Sends the call to the run's model. Where that model's route fails before it gave anything
     * and the run has a fallback, the run switches to the fallback, once, for the rest of the run,
     * and sends the call there. The switch is a model switch: the request goes on from what a run
     * on the fallback would start from, without the continuation and reasoning of the other model.
     */
    const callModel = async (
      request: { tools?: ModelTool[]; withoutContinuation?: true } = {}
    ): ReturnType<ModelInput["callModel"]> => {
      try {
        return await this.modelInput.callModel(
          runId,
          input,
          context,
          messages,
          model.current.modelSelection,
          request.tools ?? model.current.tools,
          request.withoutContinuation ? undefined : providerContinuation,
          state,
          this.runEvents,
          model.fallback !== undefined
        );
      } catch (error) {
        const to = model.fallback;
        if (!to || !(error instanceof ModelRouteFailedError)) throw error;
        const switched = {
          from: fallbackBindingOf(model.current.modelSelection),
          to: fallbackBindingOf(to.modelSelection),
          reason: error.reason
        };
        this.options.logger?.warn(
          {
            type: "model_fallback",
            runId,
            from: switched.from.bindingId,
            to: switched.to.bindingId,
            kind: error.kind
          },
          "Model route failed; the run goes on on the binding's fallback"
        );
        model.current = to;
        model.fallback = undefined;
        model.switched = switched;
        providerContinuation = undefined;
        carriesEarlierContinuation = false;
        continuationFromTurn = false;
        // A run compacted in the provider holds its context in the continuation it drops; a
        // resumed run holds its input as it paused. Both go on from the messages they hold.
        if (entry.historyFor && !runCompacted) {
          const history = await entry.historyFor(to);
          withHistory(history.messages);
          providerContinuation = history.providerContinuation;
          carriesEarlierContinuation = providerContinuation !== undefined;
          continuationFromTurn = history.fromTurn === true;
        }
        return callModel(request);
      }
    };

    /**
     * Sends the call. Where the provider refuses the continuation from an earlier run, it is
     * dropped and the call sent again: refused reasoning first, then a refused checkpoint.
     */
    const callAcceptingContinuation = (): ReturnType<ModelInput["callModel"]> =>
      callModel().catch(async (error: unknown) => {
        if (!carriesEarlierContinuation || !isModelProviderContinuationRejected(error)) {
          throw error;
        }
        const rebuilt = await entry.rebuildWithoutContinuation(model.current, continuationFromTurn);
        if (rebuilt) withHistory(rebuilt.messages);
        providerContinuation = rebuilt?.providerContinuation;
        carriesEarlierContinuation = providerContinuation !== undefined;
        continuationFromTurn = false;
        return callAcceptingContinuation();
      });

    for (let step = entry.firstStep; step < maxSteps; step += 1) {
      // The step boundary: all results of the last step are in. A new run's first request
      // goes out with its input alone, so a refused continuation rebuilds it in full.
      if (step > 0 || input.resume) await this.takeSteers(state, runId, input, context, messages);
      await this.noteLaterPreview(runId, setup, context, state, messages);
      const modelResult = await callAcceptingContinuation();
      carriesEarlierContinuation = false;
      const { modelSelection, compactThresholdTokens } = model.current;
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
            const repair = await callModel({ tools: [], withoutContinuation: true });
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
            modelContext,
            ...(model.switched ? { modelFallback: model.switched } : {})
          }),
          providerContinuation: persistedContinuation,
          // Kept for the model that answered: the next run on it sends its reasoning again.
          ...(providerContinuation
            ? {
                turnContinuation: {
                  providerId: providerContinuation.providerId,
                  model: modelSelection.model,
                  state: unknownToJsonValue(providerContinuation.state)
                }
              }
            : {})
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
        compacted: runCompacted,
        ...(model.switched ? { modelFallback: model.switched } : {})
      };
      if (outcome.kind === "paused") {
        pauseRun(state, outcome, {
          ...stepResume,
          doneToolCallIds: outcome.answeredToolCallIds,
          ...(outcome.subagents.length > 0 ? { subagents: outcome.subagents } : {})
        });
        return;
      }
      // A question to the person ends the turn after its step: their answer is their next
      // message (ASK-1). A subagent the step started is still answered first.
      if (outcome.asked && outcome.subagents.length === 0) {
        state.complete();
        return;
      }
      // A Data Store the step added brings its read tools to the next request (STORE-USE-1).
      if (outcome.offerChanged && !stopping(context, state))
        await this.reoffer(runId, input, context, setup, model);
      // The last step's open gets no note: no model request follows it.
      if (step + 1 < maxSteps)
        await this.noteOpenedPreview(runId, setup, context, state, outcome.opened, messages);
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

  /**
   * What the run's own person sent into the running turn (FU-2), appended after the step's
   * tool results as user messages: never between two results of one step. A subagent and a
   * Workflow step are never steered.
   */
  private async takeSteers(
    state: RunState,
    runId: AgentRunId,
    input: StartAgentRunInput,
    context: RuntimeCallContext,
    messages: ModelMessage[]
  ): Promise<void> {
    if (!this.options.takeSteers || context.subagent || input.workflowAgent) return;
    if (context.signal?.aborted || isCancellationRequested(state.getStatus())) return;
    const steered = await this.options.takeSteers({ runId, conversationId: input.conversationId });
    for (const { message } of steered) {
      messages.push({
        role: "user",
        content: await createSubmittedUserMessageContent(
          message.text,
          undefined,
          this.modelInput.modelContextOptions(context)
        )
      });
    }
  }
}

/** What a model of the run is sent beside the messages. */
interface ModelSetup {
  modelSelection: ModelSelection;
  tools: ModelTool[];
  compactThresholdTokens: number | undefined;
  compactionEnabled: boolean;
}

/** What every step of a run uses. Its own fields are those of the binding chosen for the run. */
interface RunSetup extends ModelSetup {
  /** The routes of the runs above a subagent, nearest first; none for any other run. */
  ancestorRoutes: NonNullable<RuntimeCallContext["modelRoutes"]>;
  /** The data tools the run was offered; a Data Store a step added widens it (`reoffer`). */
  offeredDataTools: Set<string>;
  /** The agent as its definition lists it, before the conversation's offer. */
  listed: AgentConfig;
  /** The binding's fallback, where the run may switch to it. */
  fallback?: ModelSetup;
  systemMessage: ModelMessage;
  userMessage: ModelMessage;
  maxSteps: number;
  /** Set where the run notes what its previews reported: whose browser's reports it reads. */
  previewNotes?: { viewer: PreviewViewerKey | undefined };
}

/** The model a run's calls go to now, and the fallback it may still switch to once. */
interface RunModel {
  current: ModelSetup;
  fallback?: ModelSetup;
  /** Set once the run switched: what the answer and a pause record of it. */
  switched?: StoredModelFallback;
}

/**
 * A run starts on the binding chosen for it. One that resumes after it switched goes on on the
 * fallback, where that is still the fallback the run may use; otherwise it starts over on its
 * binding with the fallback in reserve.
 */
function runModelOf(setup: RunSetup, switched: StoredModelFallback | undefined): RunModel {
  const { fallback } = setup;
  if (
    switched &&
    fallback &&
    "bindingId" in fallback.modelSelection.binding &&
    fallback.modelSelection.binding.bindingId === switched.to.bindingId
  ) {
    return { current: fallback, switched };
  }
  return { current: setup, ...(fallback ? { fallback } : {}) };
}

/** How the line under an answer names a binding of the switch. */
function fallbackBindingOf(selection: ModelSelection): StoredModelFallback["from"] {
  return {
    bindingId: "bindingId" in selection.binding ? selection.binding.bindingId : selection.model,
    model: selection.model,
    ...(selection.label === undefined ? {} : { label: selection.label })
  };
}

/** Where the steps of a run start: a new run's first step, or the step after a paused one. */
interface StepEntry {
  messages: ModelMessage[];
  /** Where in `messages` the run's own steps start, after its history and its input. */
  ownMessagesFrom: number;
  firstStep: number;
  repeatedToolCalls: Map<string, number>;
  providerContinuation: ModelCompletion["continuation"];
  runCompacted: boolean;
  modelInputFrom: AgentRunResumeState["modelInputFrom"];
  /**
   * The history and input a run on this model starts from, with the continuation it sends.
   * Missing on a resumed run, which goes on from the messages it paused with.
   */
  historyFor?(model: ModelSetup): Promise<{
    messages: ModelMessage[];
    providerContinuation: ModelCompletion["continuation"];
    fromTurn?: true;
  }>;
  /** The entry's continuation is the last run's reasoning, not the compaction checkpoint. */
  fromTurn?: true;
  /**
   * The history and input to send when the provider refuses the continuation the first request
   * carries (`fromTurn`: the last run's reasoning), with the continuation still to send;
   * `undefined` keeps the messages as they are and sends none.
   */
  rebuildWithoutContinuation(
    model: ModelSetup,
    fromTurn: boolean
  ): Promise<
    { messages: ModelMessage[]; providerContinuation?: ModelCompletion["continuation"] } | undefined
  >;
}

function isDataStoreUse(call: { toolName: string }): boolean {
  return call.toolName === DATA_STORE_USE_TOOL_NAME;
}

/** The run was cancelled or is stopping: nothing more is read for its model. */
function stopping(context: RuntimeCallContext, state: RunState): boolean {
  return context.signal?.aborted === true || isCancellationRequested(state.getStatus());
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
