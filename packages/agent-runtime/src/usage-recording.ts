import {
  type AgentRunId,
  type ModelProviderConfig,
  type ModelUsageRecorder,
  type RuntimeCallContext,
  type StartAgentRunInput
} from "@vivd-catalyst/core";
import type { ModelCompletion } from "@vivd-catalyst/model-provider";

export async function recordModelUsage(input: {
  usageStore: ModelUsageRecorder;
  runId: AgentRunId;
  startInput: StartAgentRunInput;
  context: RuntimeCallContext;
  provider: ModelProviderConfig;
  model: string;
  completion: ModelCompletion;
}): Promise<void> {
  await input.usageStore.recordModelUsage({
    clientInstanceId: input.context.clientInstanceId,
    conversationId: input.startInput.conversationId,
    agentRunId: input.runId,
    agentName: input.startInput.agentName,
    providerId: input.provider.id,
    model: input.model,
    correlationId: input.context.correlationId,
    ...input.completion.usage
  });
}
