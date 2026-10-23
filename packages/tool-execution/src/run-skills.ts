import type {
  RuntimeAssetSnapshot,
  ConversationOfferSource,
  ToolExecutionContext
} from "@work-shape/catalyst-core";

/** The skills this run may read or use, including its frozen Try draft and conversation offer. */
export async function runSkillNames(options: {
  context: ToolExecutionContext;
  assets: RuntimeAssetSnapshot;
  conversationOffer?: ConversationOfferSource;
}): Promise<Set<string>> {
  const { context, assets } = options;
  const agentName = context.toolRequest?.agentName;
  if (!agentName) return new Set();
  const draft = context.agentPreview?.config;
  const preview = draft?.name === agentName ? draft : undefined;
  const agent = preview ?? assets.agents.find((candidate) => candidate.name === agentName);
  const conversationId = context.toolRequest?.conversationId;
  // Try turns use only their frozen draft, with no conversation offer.
  const offer =
    conversationId && !preview
      ? await options.conversationOffer?.offerOf({
          clientInstanceId: context.clientInstanceId,
          conversationId,
          agentToolNames: agent?.toolNames ?? []
        })
      : undefined;
  return new Set([...(agent?.skillNames ?? []), ...(offer?.skillNames ?? [])]);
}
