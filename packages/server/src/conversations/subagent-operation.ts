import {
  AGENTS_RUN_OPERATION,
  answerAsTool,
  asAgentRunId,
  type AuthenticatedIdentity,
  type ClientInstanceId,
  type CollaborationWorkspaceId,
  type ConfigAssetSource,
  type OperationDefinition,
  type OperationRegistry,
  type PlatformStores,
  type ToolExecutionErrorCode
} from "@work-shape/catalyst-core";
import {
  runAgentInputSchema,
  runAgentOutputSchema,
  type RunAgentInput
} from "@work-shape/catalyst-tool-execution";

/** How long a start of a subagent may take: it writes its thread and its run, nothing more. */
const AGENTS_RUN_TIMEOUT_MS = 30_000;

export interface SubagentOperationOptions {
  clientInstanceId: ClientInstanceId;
  stores: Pick<
    PlatformStores,
    "agentRuns" | "childAgentRuns" | "conversations" | "scheduledStarts"
  >;
  assetSource: ConfigAssetSource;
  /**
   * Whether a person may use an agent in a workspace now: the rule a new run starts under,
   * availability and `agent.use` (AGENT-USE-1). A refusal of `agent.use` is recorded.
   */
  agentAvailable(input: {
    agentName: string;
    workspaceId: CollaborationWorkspaceId;
    actor: AuthenticatedIdentity;
    correlationId: string;
  }): Promise<boolean>;
}

/**
 * The operation `agents.run` (CR-1), which an agent's `run_agent` call is. It starts a
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
      // Q3: the parent's own agent, and the agents its config lists, each only where the
      // person may use it in the root conversation's workspace.
      const listed =
        agentName === parent.agentName || (own?.subagentNames ?? []).includes(agentName);
      const exists = assets.agents.some((agent) => agent.name === agentName);
      if (
        !listed ||
        !exists ||
        !(await options.agentAvailable({
          agentName,
          workspaceId: root.collaborationWorkspaceId,
          actor: context.actor,
          correlationId: context.correlationId
        }))
      ) {
        return refused(
          "agent_not_available",
          `Agent '${agentName}' is not available as a subagent here. Run yourself by leaving out 'agent'${
            (own?.subagentNames ?? []).length > 0
              ? `, or name one of: ${(own?.subagentNames ?? []).join(", ")}`
              : ""
          }.`
        );
      }
      // Without an agent of its own, the parent runs itself with its own model and effort.
      const sameAgent = agentName === parent.agentName;
      const started = await options.stores.childAgentRuns.startSubagentRun({
        clientInstanceId: options.clientInstanceId,
        parentRunId: parent.id,
        parentOperationRunId: context.runId,
        agentName,
        ...(sameAgent && parent.modelBindingId ? { modelBindingId: parent.modelBindingId } : {}),
        ...(sameAgent && parent.reasoningEffort ? { reasoningEffort: parent.reasoningEffort } : {}),
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
