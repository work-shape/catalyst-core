import {
  AGENTS_RUN_OPERATION,
  answerAsTool,
  asAgentRunId,
  type ClientInstanceId,
  ALL_SUBAGENTS,
  defaultReasoningEffortForAgentBinding,
  type ConfigAssetSource,
  type OperationDefinition,
  type OperationRegistry,
  type PlatformStores,
  type ReasoningEffortConfig,
  type ToolExecutionErrorCode
} from "@work-shape/catalyst-core";
import {
  runAgentInputSchema,
  runAgentOutputSchema,
  type RunAgentInput
} from "@work-shape/catalyst-tool-execution";
import {
  listsSubagent,
  subagentAvailable,
  subagentModelChoices,
  type SubagentChoiceOptions
} from "./subagent-choices";

/** How long a start of a subagent may take: it writes its thread and its run, nothing more. */
const AGENTS_RUN_TIMEOUT_MS = 30_000;

export interface SubagentOperationOptions extends Omit<SubagentChoiceOptions, "stores"> {
  clientInstanceId: ClientInstanceId;
  stores: Pick<
    PlatformStores,
    "agentRuns" | "childAgentRuns" | "conversations" | "scheduledStarts" | "workspaces"
  >;
  assetSource: ConfigAssetSource;
}

/**
 * The operation `agents.run` (CR-1, CR-3m), which an agent's `run_agent` call is. It starts a
 * subagent in a run thread of its own and ends `done` once the child is committed: the child's
 * answer reaches the parent when the parent's step ends, not through this run. A subagent acts
 * as its parent's person, so this call needs no right of its own; every call the child makes
 * is checked against that person's rights. It has no HTTP face.
 */
export function subagentOperation(
  options: SubagentOperationOptions
): OperationDefinition<RunAgentInput> {
  return {
    name: AGENTS_RUN_OPERATION,
    effect: "changing",
    defaultPolicy: "allow",
    repeatsUnderKey: true,
    action: null,
    authorize: (_input, { origin }) =>
      origin.kind === "agent"
        ? { allowed: true }
        : {
            allowed: false,
            reason: "no_grant",
            message: "Only an agent's run starts a subagent"
          },
    scope: null,
    auth: "user",
    inputSchema: runAgentInputSchema,
    outputSchema: runAgentOutputSchema,
    resource: () => undefined,
    timeoutMs: AGENTS_RUN_TIMEOUT_MS,
    async execute(input, context) {
      const { origin } = context;
      if (origin.kind !== "agent") {
        return refused("agent_not_available", "Only an agent's run starts a subagent.");
      }
      // EW-8 defers scheduled subagents; other existing unattended callers keep CR-1 behavior.
      if (
        await options.stores.scheduledStarts.isScheduledAgentRun({
          clientInstanceId: options.clientInstanceId,
          runId: asAgentRunId(origin.agentRunId)
        })
      )
        return refused("agent_not_available", "Scheduled prompts cannot start subagents yet.");
      const parent = await options.stores.agentRuns.getAgentRun({
        clientInstanceId: options.clientInstanceId,
        runId: asAgentRunId(origin.agentRunId)
      });
      const root =
        parent &&
        (await options.stores.conversations.getConversation(
          options.clientInstanceId,
          parent.conversationId
        ));
      if (!parent || !root || root.kind !== "chat") {
        return refused("agent_not_available", "This run cannot start a subagent.");
      }
      const agentName = input.agent ?? parent.agentName;
      const assets = await options.assetSource.getSnapshot();
      const own = assets.agents.find((agent) => agent.name === parent.agentName);
      const child = assets.agents.find((agent) => agent.name === agentName);
      // Q3: the parent's own agent, and the agents its config lists (every one for "*"), each
      // only where the person may use it in the root conversation's workspace. Asked again on
      // every call: the rights can change while the run works (CR-3m).
      if (
        !listsSubagent(own, parent.agentName, agentName) ||
        !child ||
        !(await subagentAvailable(options, {
          agentName,
          parentAgentName: parent.agentName,
          root,
          actor: context.actor,
          correlationId: context.correlationId
        }))
      ) {
        const named = own?.subagentNames === ALL_SUBAGENTS ? [] : (own?.subagentNames ?? []);
        return refused(
          "agent_not_available",
          `Agent '${agentName}' is not available as a subagent here. Run yourself by leaving out 'agent'${
            named.length > 0 ? `, or name one of: ${named.join(", ")}` : ""
          }.`
        );
      }
      // CR-3m: a model the person may pick on the child's agent, with that agent's effort for
      // it. Without one the child runs on the parent's model and effort.
      let selection: { modelBindingId?: string; reasoningEffort?: ReasoningEffortConfig };
      if (input.model !== undefined) {
        const offered = await subagentModelChoices(options, assets, child);
        const binding = options.config.modelBindings.find(
          (candidate) => candidate.id === input.model
        );
        if (!binding || !offered.some((model) => model.bindingId === input.model)) {
          return refused(
            "model_not_available",
            `Model '${input.model}' is not available for agent '${agentName}'. Leave out 'model' to run on your own model${
              offered.length > 0
                ? `, or name one of: ${offered.map((model) => model.bindingId).join(", ")}`
                : ""
            }.`
          );
        }
        const reasoningEffort = defaultReasoningEffortForAgentBinding(child, binding);
        selection = {
          modelBindingId: binding.id,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort })
        };
      } else {
        // A copy of the parent runs on the parent's model and effort, as CR-1 had it. Another
        // agent runs on its own default: its builder chose it, and the parent's model may not
        // be allowed there.
        const sameAgent = agentName === parent.agentName;
        selection = {
          ...(sameAgent && parent.modelBindingId ? { modelBindingId: parent.modelBindingId } : {}),
          ...(sameAgent && parent.reasoningEffort
            ? { reasoningEffort: parent.reasoningEffort }
            : {})
        };
      }
      const started = await options.stores.childAgentRuns.startSubagentRun({
        clientInstanceId: options.clientInstanceId,
        parentRunId: parent.id,
        parentOperationRunId: context.runId,
        agentName,
        ...selection,
        description: input.description,
        task: input.task,
        correlationId: context.correlationId
      });
      if (started.status === "limit_reached") {
        return refused(
          "subagent_limit",
          "This run started as many subagents as one run may. Do the rest of the task yourself."
        );
      }
      return {
        runId: started.run.id,
        threadId: started.threadId,
        agent: agentName,
        description: input.description
      };
    }
  };
}

/** Registers `agents.run` on the registry of a process that runs agents. */
export function registerSubagentOperation(
  registry: OperationRegistry,
  options: SubagentOperationOptions
): void {
  registry.register(subagentOperation(options));
}

function refused(code: ToolExecutionErrorCode, message: string) {
  return answerAsTool<{ runId: string; threadId: string; agent: string; description: string }>({
    status: "failed",
    error: { code, message }
  });
}
