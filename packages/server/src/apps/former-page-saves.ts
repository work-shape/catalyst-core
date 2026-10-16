import {
  readToolResultMetadata,
  type ClientInstanceId,
  type ConversationHistoryReader,
  type ConversationId
} from "@work-shape/catalyst-core";
import { openedPageName } from "@work-shape/catalyst-tool-execution";
import { z } from "zod";

// Before `workspace.open`, the former `page.save` kept a folder as a Page under a name the agent
// chose, and an App was saved from that Page. An open names its Page by the path, so the folder
// of such an App now opens as a Page of its own. The conversation's stored calls of `page.save`
// are the one record of the folder the App's Page was kept from.

/** The former name of `workspace.open`, whose calls stored conversations still hold. */
const FORMER_OPEN_TOOL_NAME = "page.save";

/** A call of the former `page.save` that kept a folder as a Page. */
const formerSaveSchema = z.object({
  input: z.object({ directory: z.string() }),
  result: z.object({ status: z.literal("success"), output: z.object({ pageId: z.string() }) })
});

/**
 * Whether the former `page.save` of the conversation kept, as the Page `pageId`, the folder an
 * open now keeps as the Page `pageName`.
 */
export async function wasKeptByFormerSave(
  history: ConversationHistoryReader,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    pageId: string;
    pageName: string;
  }
): Promise<boolean> {
  const messages = await history.listMessages({
    clientInstanceId: input.clientInstanceId,
    conversationId: input.conversationId
  });
  return messages.some((message) => {
    const call = readToolResultMetadata(message.metadata);
    if (call?.toolName !== FORMER_OPEN_TOOL_NAME) return false;
    const save = formerSaveSchema.safeParse(call);
    if (!save.success || save.data.result.output.pageId !== input.pageId) return false;
    const folder = openedPageName(save.data.input.directory);
    return "name" in folder && folder.name === input.pageName;
  });
}
