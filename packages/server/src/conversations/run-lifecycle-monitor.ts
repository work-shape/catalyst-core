import {
  isAppError,
  type AgentRuntime,
  type AgentRunId,
  type AuthenticatedUser,
  type ConversationId,
  type RuntimeCallContext
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";
import { RunObservationWorkflow } from "./run-observation-service";

const monitors = new WeakMap<AgentRuntime, Map<AgentRunId, Promise<void>>>();

/** Every accepted turn, including a dispatched follow-up, records its lifecycle the same way. */
export function monitorRunLifecycle(
  options: ChatServerOptions,
  input: {
    conversationId: ConversationId;
    context: RuntimeCallContext;
    runId: AgentRunId;
    user: AuthenticatedUser;
  }
): void {
  const tasks = monitors.get(options.agentRuntime) ?? new Map<AgentRunId, Promise<void>>();
  monitors.set(options.agentRuntime, tasks);
  if (tasks.has(input.runId)) return;
  const observations = new RunObservationWorkflow(options);
  // The accepted run outlives the request or dispatch job that started it. Its lifecycle
  // audit must keep observing when that caller's signal ends.
  const context: RuntimeCallContext = { ...input.context, signal: undefined };
  const task = (async () => {
    let assistantMessageCount = 0;
    for await (const event of observations.observeRun(input.runId, context)) {
      if (event.type === "message_completed") assistantMessageCount += 1;
      if (event.type === "run_failed") {
        await observations.recordRunFailed(
          input.conversationId,
          input.user,
          input.context,
          input.runId,
          assistantMessageCount,
          event
        );
        return;
      }
      if (event.type === "run_cancelled") {
        await observations.recordRunCancelled(
          input.conversationId,
          input.user,
          input.context,
          input.runId,
          assistantMessageCount,
          event
        );
        return;
      }
      if (event.type === "run_completed") {
        await observations.recordRunCompleted(
          input.conversationId,
          input.user,
          input.context,
          input.runId,
          assistantMessageCount
        );
        return;
      }
    }
  })()
    .catch((error: unknown) => {
      options.logger.warn(
        {
          conversationId: input.conversationId,
          runId: input.runId,
          errorCode: isAppError(error) ? error.code : "INTERNAL"
        },
        "Agent run lifecycle monitor failed"
      );
    })
    .finally(() => {
      tasks.delete(input.runId);
    });
  tasks.set(input.runId, task);
}

/** An observer sees the terminal event only after the lifecycle audit has settled. */
export async function awaitRunLifecycleAudit(
  runtime: AgentRuntime,
  runId: AgentRunId
): Promise<void> {
  await monitors.get(runtime)?.get(runId);
}
