import {
  RECALL_QUERY_MAX_CHARS,
  RECALL_READ_DEFAULT_MESSAGES,
  RECALL_READ_MAX_MESSAGES,
  RECALL_ROLES,
  RECALL_TOOLS,
  type RecallMessage,
  type RecallRole,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";
import { defineTool, toolSuccess, type AnyToolDefinition } from "@work-shape/catalyst-tool-sdk";
import { z } from "zod";

// The tools an agent reaches its own conversation with (RECALL-1), in every chat: what fell out
// of its context, behind a compaction checkpoint or the window of recent messages, is still in
// the store. They take no conversation: the call reaches the conversation it came from, and no
// other. Both only read, for the person the agent acts for.

/** One row per tool: its name for the agent, and the operation of the API it projects. */
export const HISTORY_TOOLS = {
  search: {
    name: RECALL_TOOLS.historySearch,
    operation: "conversations.messages.search",
    effect: "reading"
  },
  read: {
    name: RECALL_TOOLS.historyRead,
    operation: "conversations.messages.list",
    effect: "reading"
  }
} as const;

const HISTORY_SEARCH_MAX_HITS = 20;
const HISTORY_SEARCH_DEFAULT_HITS = 8;

export interface HistorySearchInput {
  query: string;
  beforeCut: boolean;
  limit: number;
}

export interface HistoryHit {
  messageId: string;
  role: RecallRole;
  createdAt: string;
  snippet: string;
}

/** At most one anchor; none reads from the start. */
export interface HistoryReadInput {
  around?: string;
  after?: string;
  before?: string;
  limit: number;
}

export interface HistoryRead {
  messages: RecallMessage[];
  moreBefore: boolean;
  moreAfter: boolean;
}

/** What carries the tools out, in the conversation the call came from. */
export interface HistoryCalls {
  /**
   * The best matches in the conversation of the call; with `beforeCut` only among the messages
   * its run did not send its model, which are none where it sent all of them.
   */
  searchHistory(
    context: ToolExecutionContext,
    input: HistorySearchInput
  ): Promise<{ hits: HistoryHit[]; more: boolean }>;
  /** Messages of the conversation of the call; `before: "cut"` names the run's cut. */
  readHistory(context: ToolExecutionContext, input: HistoryReadInput): Promise<HistoryRead>;
}

const queryText = z
  .string()
  .trim()
  .min(1)
  .max(RECALL_QUERY_MAX_CHARS)
  .regex(/^[^\u0000]*$/u, "must not contain a NUL character");

const messageId = z.string().min(1).max(200);

const recallMessageSchema = z.object({
  messageId: z.string(),
  role: z.enum(RECALL_ROLES),
  createdAt: z.string(),
  text: z.string(),
  cut: z.literal(true).optional(),
  tools: z.array(z.string()).optional()
});

const hitSchema = z.object({
  messageId: z.string(),
  role: z.enum(RECALL_ROLES),
  createdAt: z.string(),
  snippet: z.string()
});

const readLimit = z
  .number()
  .int()
  .min(1)
  .max(RECALL_READ_MAX_MESSAGES)
  .default(RECALL_READ_DEFAULT_MESSAGES);

/** At most one of the anchors a read names. */
function oneAnchor(input: Record<string, unknown>, anchors: readonly string[]): boolean {
  return anchors.filter((anchor) => input[anchor] !== undefined).length <= 1;
}

export function createHistoryTools(calls: HistoryCalls): AnyToolDefinition[] {
  const { search, read } = HISTORY_TOOLS;
  return [
    defineTool({
      name: search.name,
      title: { en: "Search this chat", de: "Diesen Chat durchsuchen" },
      summary: {
        en: "Finds what was said earlier in this chat, also what is no longer in the agent's view.",
        de: "Findet, was früher in diesem Chat gesagt wurde, auch was der Agent nicht mehr sieht."
      },
      group: "platform",
      icon: "prompt",
      effect: search.effect,
      description: [
        "Search the earlier messages of this chat, yours and the user's, also those no longer in your context. Use it when the user refers to something said earlier that you no longer see, or when you need an exact figure, name or decision from before the cut.",
        "Search in the words the chat used, in its language; every word must occur, and a word also finds longer forms of it ('Checkliste' finds 'Checklisten'); put an exact phrase in double quotes. When nothing is found, try fewer words or another word form.",
        `By default only messages before the cut, the ones you do not see; beforeCut: false searches the whole chat. It returns message ids and short snippets with the match in « »; read around the best hit with ${read.name} before you answer. Tool calls and their results are not searched.`
      ].join(" "),
      inputSchema: z.object({
        query: queryText.describe("The words to find, as the chat wrote them."),
        beforeCut: z
          .boolean()
          .default(true)
          .describe("Only the messages before the cut, which are out of your context."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(HISTORY_SEARCH_MAX_HITS)
          .default(HISTORY_SEARCH_DEFAULT_HITS)
          .describe("How many hits.")
      }),
      outputSchema: z.object({ hits: z.array(hitSchema), more: z.boolean() }),
      async execute(input, context) {
        const found = await calls.searchHistory(context, input);
        return toolSuccess(found, {
          auditSummary: {
            action: search.name,
            metadata: { hitCount: found.hits.length, more: found.more }
          }
        });
      }
    }),
    defineTool({
      name: read.name,
      title: { en: "Read earlier in this chat", de: "Weiter oben in diesem Chat lesen" },
      summary: {
        en: "Reads earlier messages of this chat, also those no longer in the agent's view.",
        de: "Liest frühere Nachrichten dieses Chats, auch die, die der Agent nicht mehr sieht."
      },
      group: "platform",
      icon: "prompt",
      effect: read.effect,
      description: [
        "Read earlier messages of this chat, yours and the user's, in order. Give at most one of: around (a message id: that message and up to 5 before and after it), after (the next messages after an id) or before (the messages just before an id; before: 'cut' reads what was said just before the part of the chat you still see). With none of them it reads from the chat's start.",
        "A long message is cut and marked cut; 'tools' names the tools the agent called in that turn, never their results. Continue with after set to the last message id while moreAfter is true, or with before set to the first while moreBefore is true."
      ].join(" "),
      inputSchema: z
        .object({
          around: messageId.optional().describe("A message id from a search hit."),
          after: messageId.optional().describe("Read on after this message id."),
          before: messageId
            .optional()
            .describe("Read the messages just before this message id, or 'cut'."),
          limit: readLimit.describe("How many messages; ignored with around.")
        })
        .refine((input) => oneAnchor(input, ["around", "after", "before"]), {
          message: "Give at most one of around, after and before"
        }),
      outputSchema: z.object({
        messages: z.array(recallMessageSchema),
        moreBefore: z.boolean(),
        moreAfter: z.boolean()
      }),
      async execute(input, context) {
        const found = await calls.readHistory(context, input);
        return toolSuccess(found, {
          auditSummary: {
            action: read.name,
            metadata: {
              messageCount: found.messages.length,
              bytes: found.messages.reduce(
                (sum, message) => sum + Buffer.byteLength(message.text, "utf8"),
                0
              )
            }
          }
        });
      }
    })
  ];
}
