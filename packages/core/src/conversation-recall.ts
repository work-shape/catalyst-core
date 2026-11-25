import { RECALL_ROLES } from "@work-shape/catalyst-asset-schemas";
import type { ClientInstanceId, ConversationId, MessageId } from "./ids";

export { RECALL_ROLES };

// Conversation recall (RECALL): an agent searches and reads what was said in a conversation,
// its own earlier messages before the cut of its history, and in a project the project's other
// chats. Only the text of the user's and the agent's messages: no tool input or output, no
// system note. The search is Postgres full text with the `simple` configuration, computed when
// it runs: chats mix German and English, and what people search for is names, numbers and
// terms of the trade, which stemming mangles.

/** The tools of recall, by the conversation they reach. */
export const RECALL_TOOLS = {
  historySearch: "platform.history.search",
  historyRead: "platform.history.read",
  conversationsSearch: "platform.conversations.search",
  conversationsRead: "platform.conversations.read"
} as const;

/** What the agent of every chat is offered to reach its own conversation (RECALL-1). */
export const HISTORY_TOOL_NAMES: readonly string[] = [
  RECALL_TOOLS.historySearch,
  RECALL_TOOLS.historyRead
];

/**
 * The sentence a run's system message ends with where its history does not start at the
 * conversation's first message and the agent holds the history tools.
 */
export const HISTORY_CUT_POINTER = `Earlier messages of this conversation are not in your context; ${RECALL_TOOLS.historySearch} and ${RECALL_TOOLS.historyRead} reach them.`;

/** The longest search text. */
export const RECALL_QUERY_MAX_CHARS = 200;
/** One snippet around a match, the match marked « ». */
export const RECALL_SNIPPET_MAX_CHARS = 300;
/** The longest message text a read returns; a longer one is cut and marked. */
export const RECALL_MESSAGE_MAX_CHARS = 6_000;
/** What one read returns at most, whichever of the two comes first. */
export const RECALL_READ_MAX_CHARS = 24_000;
export const RECALL_READ_MAX_MESSAGES = 30;
export const RECALL_READ_DEFAULT_MESSAGES = 20;
/** A read `around` a message returns it and this many before and after it. */
export const RECALL_AROUND_MESSAGES = 5;
/** How long one search may take before it is refused as too broad. */
export const RECALL_SEARCH_TIMEOUT_MS = 2_000;

export type RecallRole = (typeof RECALL_ROLES)[number];

/** One message as a recall read returns it. */
export interface RecallMessage {
  messageId: MessageId;
  role: RecallRole;
  createdAt: string;
  text: string;
  /** The text was longer than `RECALL_MESSAGE_MAX_CHARS` and is cut. */
  cut?: true;
  /** The tools the agent called in this turn, by name; never their input or output. */
  tools?: string[];
}

/** One message a search found. */
export interface RecallHit {
  conversationId: ConversationId;
  messageId: MessageId;
  role: RecallRole;
  createdAt: string;
  /** At most `RECALL_SNIPPET_MAX_CHARS` around the match, the match marked « ». */
  snippet: string;
  rank: number;
}

/** Where a read starts: around, after or before a message, or at the conversation's start. */
export type RecallAnchor =
  { around: MessageId } | { after: MessageId } | { before: MessageId } | { start: true };

export interface ConversationRecallStore {
  /**
   * The best matches of `tsQuery` (from `recallTsQuery`) among the user's and the agent's
   * messages of these conversations, best first and ties to the newer message; with `before`
   * only messages stored before that one of the same conversation. `perConversation` caps the
   * hits of one conversation. A search that takes longer than `RECALL_SEARCH_TIMEOUT_MS` is
   * refused with `RecallSearchTooBroadError`.
   */
  searchRecallMessages(input: {
    clientInstanceId: ClientInstanceId;
    conversationIds: readonly ConversationId[];
    tsQuery: string;
    before?: MessageId;
    limit: number;
    perConversation?: number;
  }): Promise<RecallHit[]>;
  /**
   * Up to `limit` of the user's and the agent's messages of one conversation from `anchor`, in
   * the order they were stored, with whether there are more before and after them. An anchor
   * that names no message of the conversation answers nothing. Texts are whole: the caller
   * cuts them.
   */
  readRecallMessages(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    anchor: RecallAnchor;
    limit: number;
  }): Promise<{ messages: RecallMessage[]; moreBefore: boolean; moreAfter: boolean }>;
}

/** The search ran into its time limit: the words match too much. */
export class RecallSearchTooBroadError extends Error {
  constructor() {
    super("The search took too long");
    this.name = "RecallSearchTooBroadError";
  }
}

/** Letters and digits: what one term of the `simple` configuration is made of. */
const TERM = /[\p{L}\p{N}]+/gu;

/**
 * The Postgres `tsquery` of a search text, or nothing where no word remains: every word a
 * prefix term, so that "Checkliste" also finds "Checklisten", and a quoted phrase a phrase of
 * whole words in that order; all of them joined with AND. Only letters and digits reach the
 * query, so no input can change its syntax.
 */
export function recallTsQuery(text: string): string | undefined {
  const parts: string[] = [];
  const phrase = /"([^"]*)"/gu;
  let rest = text;
  for (const match of text.matchAll(phrase)) {
    const words = termsOf(match[1] ?? "");
    const [only, ...more] = words;
    if (only !== undefined) parts.push(more.length === 0 ? only : `(${words.join(" <-> ")})`);
    rest = rest.replace(match[0], " ");
  }
  for (const word of termsOf(rest.replaceAll('"', " "))) parts.push(`${word}:*`);
  return parts.length > 0 ? parts.join(" & ") : undefined;
}

function termsOf(text: string): string[] {
  return [...text.toLowerCase().matchAll(TERM)].map((match) => match[0]);
}

/** A message text as a read returns it: whole up to `RECALL_MESSAGE_MAX_CHARS`, else cut. */
export function recallMessageText(text: string): { text: string; cut?: true } {
  return text.length > RECALL_MESSAGE_MAX_CHARS
    ? { text: text.slice(0, RECALL_MESSAGE_MAX_CHARS), cut: true }
    : { text };
}

/**
 * The messages of a read within `RECALL_READ_MAX_CHARS`, each cut to its own maximum. Messages
 * past the budget are left out from the side away from the anchor: the end for a read forward,
 * the start for a read backward. At least one message is kept.
 */
export function withinRecallBudget(
  messages: readonly RecallMessage[],
  direction: "forward" | "backward"
): { messages: RecallMessage[]; dropped: boolean } {
  const ordered = direction === "forward" ? [...messages] : [...messages].reverse();
  const kept: RecallMessage[] = [];
  let used = 0;
  for (const message of ordered) {
    const cut = { ...message, ...recallMessageText(message.text) };
    if (kept.length > 0 && used + cut.text.length > RECALL_READ_MAX_CHARS) break;
    kept.push(cut);
    used += cut.text.length;
  }
  return {
    messages: direction === "forward" ? kept : kept.reverse(),
    dropped: kept.length < messages.length
  };
}
