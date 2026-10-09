import type { LocalAgentRuntimeOptions } from "@vivd-catalyst/agent-runtime";
import type { Logger } from "@vivd-catalyst/core";

export function createRuntimeFailureReporter(
  logger: Logger
): NonNullable<LocalAgentRuntimeOptions["runFailureReporter"]> {
  return (report) => {
    logger.error(
      {
        type: "agent_runtime.run_failed",
        runId: report.runId,
        conversationId: report.input.conversationId,
        agentName: report.input.agentName,
        clientInstanceId: report.context.clientInstanceId,
        correlationId: report.context.correlationId,
        failure: report.failure,
        error: report.error instanceof Error ? report.error : { thrown: report.error }
      },
      "Agent run failed"
    );
  };
}
