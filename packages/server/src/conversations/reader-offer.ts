import { createSafeConfigView } from "@work-shape/catalyst-config-schema";
import type {
  ActorAccess,
  AuthenticatedUser,
  ConversationId,
  LocaleCode
} from "@work-shape/catalyst-core";
import { agentConnections } from "../connections/agent-connections";
import type { ChatServerOptions } from "../types";
import { agentWriter, getWorkspaceAssetSnapshot } from "../workspaces/agent-availability";
import { requireConversationReach, workspaceOfConversation } from "./conversation-access";

/**
 * What a reader of a chat is offered in it: the chat's workspace by name, whether they read it
 * from outside that workspace, and the agents their own turns may run there (CHAT-SHARE-6).
 * It reaches the workspace through the conversation's own check alone, so a named person who
 * is no member gets it for this chat, and nothing of the workspace beyond its name and the
 * agents open to them: for one from outside, the instance's own agents their rights allow.
 */
export async function conversationReaderOffer(
  options: ChatServerOptions,
  caller: { user: AuthenticatedUser; access: ActorAccess; locale: LocaleCode },
  conversationId: ConversationId
) {
  const { conversation, outside } = await requireConversationReach(
    options,
    conversationId,
    caller.user
  );
  const workspace = await workspaceOfConversation(options, conversation);
  const assets = await getWorkspaceAssetSnapshot(options, workspace, caller.access, { outside });
  const { defaultAgentName, agents } = createSafeConfigView(
    options.config,
    assets,
    options.modules,
    {
      requestedLocale: caller.locale,
      reasoningEffortsOfBinding: (bindingId: string) =>
        options.modelGateway.capabilities({ bindingId }).reasoningEfforts,
      connections: await agentConnections(options),
      mayWriteAgent: agentWriter(caller, assets)
    }
  );
  return {
    workspace: { id: workspace.id, name: workspace.name },
    outside,
    ...(defaultAgentName === undefined ? {} : { defaultAgentName }),
    agents
  };
}
