import { AppError, PROJECT_RECALL_NOTICE, asConversationId } from "@work-shape/catalyst-core";
import type { ProjectConversationCalls } from "@work-shape/catalyst-tool-execution";
import { requireConversationAccess } from "../../conversations/conversation-access";
import {
  readProjectConversation,
  recallAnchorOf,
  searchProjectConversations,
  shownRecallHit
} from "../../conversations/conversation-recall";
import type { AssetCallScope } from "./scope";

/**
 * The agent's search and read of the other chats of its project (RECALL-2): from a chat in a
 * project the person reads, the project's chats the person reads, never the calling one. The
 * output opens with the notice that the text is information, not instructions, and carries the
 * project's source tag as a read of a project file does.
 */
export function projectConversationCalls(scope: AssetCallScope): ProjectConversationCalls {
  const { options, conversationOf } = scope;
  const calling = async (
    context: Parameters<ProjectConversationCalls["readProjectConversation"]>[0]
  ) => {
    const conversation = await conversationOf(context);
    await requireConversationAccess(options, conversation.id, context.user);
    // The pair is offered only in a project's chats; one moved out since reaches nothing.
    if (conversation.projectId === undefined) {
      throw new AppError(
        "CONFLICT",
        "This chat is in no project, so it has no other chats of a project to reach",
        { reason: "conversation_without_project" },
        { exposeMessage: true }
      );
    }
    return { conversation, projectId: conversation.projectId };
  };
  const frame = (projectId: string) => ({
    notice: PROJECT_RECALL_NOTICE,
    source: `project:${projectId}`
  });
  return {
    async searchProjectConversations(context, input) {
      const { conversation, projectId } = await calling(context);
      const found = await searchProjectConversations(options, context.user, {
        projectId,
        ...(input.query === undefined ? {} : { query: input.query }),
        limit: input.limit,
        except: conversation.id
      });
      return {
        ...frame(projectId),
        conversations: found.conversations.map(({ hits, ...chat }) => ({
          ...chat,
          hits: hits.map(shownRecallHit)
        })),
        more: found.more
      };
    },

    async readProjectConversation(context, input) {
      const { conversation, projectId } = await calling(context);
      const read = await readProjectConversation(options, context.user, {
        projectId,
        except: conversation.id,
        conversationId: asConversationId(input.conversationId),
        anchor: recallAnchorOf(input),
        limit: input.limit
      });
      return { ...frame(projectId), ...read };
    }
  };
}
