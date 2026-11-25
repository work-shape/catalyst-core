import {
  AppError,
  RECALL_AROUND_MESSAGES,
  RECALL_HITS_PER_CONVERSATION,
  RECALL_TITLES_MAX,
  RecallSearchTooBroadError,
  asMessageId,
  recallTsQuery,
  getSubjectUserId,
  withinRecallBudget,
  type AuthenticatedUser,
  type ClientInstanceId,
  type ConversationId,
  type ConversationRecallStore,
  type MessageId,
  type RecallAnchor,
  type RecallHit,
  type RecallMessage
} from "@work-shape/catalyst-core";
import { requireProjectAccess } from "../projects/project-access";
import type { ChatServerOptions } from "../types";
import { requireConversationAccess } from "./conversation-access";

// Searching and reading what was said in conversations (RECALL), as the API's search of a
// conversation's messages and the agent's history tools both do it. Whose conversation may be
// searched is the caller's question; this answers within the conversations it is given.

interface RecallOptions {
  clientInstanceId: ClientInstanceId;
  stores: { conversations: ConversationRecallStore };
}

/**
 * The best matches of `query` in these conversations, at most `limit`, and whether there are
 * more. A query without a word or number is refused, and so is one the store gave up on.
 */
export async function searchConversationMessages(
  options: RecallOptions,
  input: {
    conversationIds: readonly ConversationId[];
    query: string;
    before?: MessageId;
    limit: number;
    perConversation?: number;
  }
): Promise<{ hits: RecallHit[]; more: boolean }> {
  const tsQuery = recallTsQuery(input.query);
  if (tsQuery === undefined) throw searchWithoutWords();
  try {
    // One more than is answered says whether there are more.
    const found = await options.stores.conversations.searchRecallMessages({
      clientInstanceId: options.clientInstanceId,
      conversationIds: input.conversationIds,
      tsQuery,
      ...(input.before === undefined ? {} : { before: input.before }),
      limit: input.limit + 1,
      ...(input.perConversation === undefined ? {} : { perConversation: input.perConversation })
    });
    return { hits: found.slice(0, input.limit), more: found.length > input.limit };
  } catch (error) {
    throw error instanceof RecallSearchTooBroadError ? searchTooBroad() : error;
  }
}

/** A hit as an answer shows it: without its rank, which only orders the hits. */
export function shownRecallHit({ messageId, role, createdAt, snippet }: RecallHit) {
  return { messageId, role, createdAt, snippet };
}

function searchWithoutWords(): AppError {
  return new AppError(
    "VALIDATION_FAILED",
    "Name at least one word or number to search for",
    { reason: "search_without_words" },
    { exposeMessage: true }
  );
}

function searchTooBroad(): AppError {
  return new AppError(
    "CONFLICT",
    "Too much to search; use more specific words",
    { reason: "search_too_broad" },
    { exposeMessage: true }
  );
}

type ProjectRecallOptions = Pick<ChatServerOptions, "stores" | "clientInstanceId">;

/** A chat of the project a search found, by its title or its messages. */
export interface ProjectConversationMatch {
  conversationId: ConversationId;
  title: string;
  updatedAt: string;
  titleMatch: boolean;
  hits: RecallHit[];
}

/** The chats of the project the person may reach from here, after the project's own check. */
async function projectConversations(
  options: ProjectRecallOptions,
  user: AuthenticatedUser,
  input: { projectId: string; except?: ConversationId }
) {
  const project = await requireProjectAccess(options, user, input.projectId);
  return options.stores.conversations.listRecallConversations({
    clientInstanceId: options.clientInstanceId,
    collaborationWorkspaceId: project.collaborationWorkspaceId,
    projectId: project.id,
    userId: getSubjectUserId(user),
    ...(input.except === undefined ? {} : { except: input.except })
  });
}

/**
 * The project's chats whose title or messages match `query`, a title match first, then by the
 * best message, ties to the newer chat; each with its best snippets. Without a query the
 * newest chats by title alone. `except` is left out: the chat the agent calls from.
 */
export async function searchProjectConversations(
  options: ProjectRecallOptions,
  user: AuthenticatedUser,
  input: { projectId: string; query?: string; limit: number; except?: ConversationId }
): Promise<{ conversations: ProjectConversationMatch[]; more: boolean }> {
  const reachable = await projectConversations(options, user, input);
  if (input.query === undefined) {
    return {
      conversations: reachable
        .slice(0, RECALL_TITLES_MAX)
        .map((conversation) => ({ ...conversation, titleMatch: false, hits: [] })),
      more: reachable.length > RECALL_TITLES_MAX
    };
  }
  const tsQuery = recallTsQuery(input.query);
  if (tsQuery === undefined) throw searchWithoutWords();
  let hits: RecallHit[];
  try {
    hits = await options.stores.conversations.searchRecallMessages({
      clientInstanceId: options.clientInstanceId,
      conversationIds: reachable.map((conversation) => conversation.conversationId),
      tsQuery,
      limit: reachable.length * RECALL_HITS_PER_CONVERSATION,
      perConversation: RECALL_HITS_PER_CONVERSATION
    });
  } catch (error) {
    throw error instanceof RecallSearchTooBroadError ? searchTooBroad() : error;
  }
  // Titles match as the list of a workspace matches them: the text as written, any case.
  const titleText = input.query.replaceAll('"', " ").trim().toLocaleLowerCase();
  const matches = reachable.flatMap((conversation, newest) => {
    const own = hits.filter((hit) => hit.conversationId === conversation.conversationId);
    const titleMatch =
      titleText !== "" && conversation.title.toLocaleLowerCase().includes(titleText);
    if (own.length === 0 && !titleMatch) return [];
    return [
      { conversation: { ...conversation, titleMatch, hits: own }, best: own[0]?.rank ?? 0, newest }
    ];
  });
  matches.sort(
    (a, b) =>
      Number(b.conversation.titleMatch) - Number(a.conversation.titleMatch) ||
      b.best - a.best ||
      a.newest - b.newest
  );
  return {
    conversations: matches.slice(0, input.limit).map((match) => match.conversation),
    more: matches.length > input.limit
  };
}

/**
 * Messages of another chat of the project, read as `readConversationMessages` reads them. Any
 * id the project's search would not return, `except` among them, answers as a chat that does
 * not exist; the target's own read check runs as well.
 */
export async function readProjectConversation(
  options: ProjectRecallOptions,
  user: AuthenticatedUser,
  input: {
    projectId: string;
    except: ConversationId;
    conversationId: ConversationId;
    anchor: RecallAnchor;
    limit: number;
  }
): Promise<{
  conversationId: ConversationId;
  title: string;
  messages: RecallMessage[];
  moreBefore: boolean;
  moreAfter: boolean;
}> {
  const reachable = await projectConversations(options, user, input);
  const target = reachable.find(
    (conversation) => conversation.conversationId === input.conversationId
  );
  if (target === undefined) throw new AppError("NOT_FOUND", "Conversation is not available");
  await requireConversationAccess(options, target.conversationId, user);
  const read = await readConversationMessages(options, {
    conversationId: target.conversationId,
    anchor: input.anchor,
    limit: input.limit
  });
  return { conversationId: target.conversationId, title: target.title, ...read };
}

/**
 * Messages of one conversation from an anchor, within the budget of one read: a long message is
 * cut, and what does not fit is left for the next read on the side away from the anchor.
 */
export async function readConversationMessages(
  options: RecallOptions,
  input: { conversationId: ConversationId; anchor: RecallAnchor; limit: number }
): Promise<{ messages: RecallMessage[]; moreBefore: boolean; moreAfter: boolean }> {
  const around = "around" in input.anchor;
  const read = await options.stores.conversations.readRecallMessages({
    clientInstanceId: options.clientInstanceId,
    conversationId: input.conversationId,
    anchor: input.anchor,
    limit: around ? RECALL_AROUND_MESSAGES * 2 + 1 : input.limit
  });
  const backward = "before" in input.anchor;
  const { messages, dropped } = withinRecallBudget(
    read.messages,
    backward ? "backward" : "forward"
  );
  return {
    messages,
    moreBefore: read.moreBefore || (dropped && backward),
    moreAfter: read.moreAfter || (dropped && !backward)
  };
}

/** The anchor of a read, from at most one of its three. */
export function recallAnchorOf(input: {
  around?: string;
  after?: string;
  before?: string;
}): RecallAnchor {
  if (input.around !== undefined) return { around: asMessageId(input.around) };
  if (input.after !== undefined) return { after: asMessageId(input.after) };
  if (input.before !== undefined) return { before: asMessageId(input.before) };
  return { start: true };
}
