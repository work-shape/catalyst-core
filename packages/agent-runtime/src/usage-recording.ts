import {
  type AgentRunId,
  type ModelProviderConfig,
  type ModelUsageEventStore,
  type RuntimeCallContext,
  type StartAgentRunInput
} from "@vivd-catalyst/core";
import type { ModelCompletion } from "@vivd-catalyst/model-provider";

export async function recordModelUsage(input: {
  usageStore: ModelUsageEventStore;
  runId: AgentRunId;
  startInput: StartAgentRunInput;
  context: RuntimeCallContext;
  provider: ModelProviderConfig;
  completion: ModelCompletion;
}): Promise<void> {
  await input.usageStore.appendModelUsageEvent({
    clientInstanceId: input.context.clientInstanceId,
    conversationId: input.startInput.conversationId,
    agentRunId: input.runId,
    agentName: input.startInput.agentName,
    providerId: input.provider.id,
    model: input.provider.model,
    correlationId: input.context.correlationId,
    ...input.completion.usage
  });
}
