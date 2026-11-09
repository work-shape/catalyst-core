import {
  CONVERSATION_RENAME_TOOL_NAME,
  CONVERSATION_TITLE_MAX_CHARS,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";
import { defineTool, toolSuccess, type AnyToolDefinition } from "@work-shape/catalyst-tool-sdk";
import { z } from "zod";

/** The tool's name for the agent, and the operation of the API it projects. */
export const CONVERSATION_RENAME_TOOL = {
  name: CONVERSATION_RENAME_TOOL_NAME,
  operation: "conversations.rename",
  effect: "changing"
} as const;

/** What carries out the tool that renames the conversation. */
export interface ConversationRenameCalls {
  /**
   * Renames the conversation the call came from, with the right of the person of `context` as
   * `conversations.rename` asks it. A subagent's thread is refused: it is read only.
   */
  renameConversation(context: ToolExecutionContext, title: string): Promise<{ title: string }>;
}

const inputSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .max(CONVERSATION_TITLE_MAX_CHARS)
    .describe("The new title of this conversation.")
});

const outputSchema = z.object({ title: z.string() });

/** The tool that gives the conversation it is called in a title. */
export function createConversationRenameTool(calls: ConversationRenameCalls): AnyToolDefinition {
  return defineTool({
    name: CONVERSATION_RENAME_TOOL.name,
    title: { en: "Rename the chat", de: "Chat umbenennen" },
    summary: {
      en: "Gives the current chat a new title.",
      de: "Gibt dem aktuellen Chat einen neuen Titel."
    },
    group: "platform",
    icon: "prompt",
    effect: CONVERSATION_RENAME_TOOL.effect,
    // Named, because a changing tool without a mode takes the instance default: the person sees
    // the title change and can change it back in the rail.
    permission: { mode: "allow" },
    changeClass: "reversible",
    description: [
      "Give the conversation you are in a new title, shown in the conversation list and above the chat. It takes only the title, and acts on this conversation and no other, as the person you work for.",
      "Use it when your instructions, a skill or the person ask for a certain title. Otherwise leave it: a new conversation gets a title by itself. A title you give stays, and no automatic title replaces it.",
      `Write the title itself, at most ${CONVERSATION_TITLE_MAX_CHARS} characters, without quotes. A subagent's thread cannot be renamed.`
    ].join(" "),
    inputSchema,
    outputSchema,
    async execute(input, context) {
      const renamed = await calls.renameConversation(context, input.title);
      return toolSuccess(renamed, {
        // The audit counts the title and does not hold it, as `conversation.renamed` does.
        auditSummary: {
          action: CONVERSATION_RENAME_TOOL.name,
          metadata: { titleLength: renamed.title.length }
        }
      });
    }
  });
}
