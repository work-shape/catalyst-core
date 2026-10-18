import {
  type ToolExecutionRequest,
  type RuntimeCallContext,
  type ToolOperationRunner,
  type ToolDecisionWait,
  type ToolExecutionResult,
  type OperationCallRuntime,
  KNOWLEDGE_ADD_FILES_MAX_COUNT
} from "@work-shape/catalyst-core";
import { defineTool, toolFailed } from "@work-shape/catalyst-tool-sdk";
import { z } from "zod";
import { failed } from "./tool-results";

export const KNOWLEDGE_ADD_FILES_TOOL_NAME = "knowledge.add_files";

const knowledgeBase = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .max(63);
const knowledgeAddFilesInput = z.strictObject({
  knowledgeBase,
  files: z
    .array(
      z.strictObject({
        conversationId: z.string().min(1).max(200),
        fileId: z.string().min(1).max(200)
      })
    )
    .min(1)
    .max(KNOWLEDGE_ADD_FILES_MAX_COUNT)
});

/** Only the existing per-Knowledge-Base write operation is projected by this tool. */
export function isKnowledgeAddFilesOperation(name: string): boolean {
  const parts = name.split(".");
  return (
    parts.length === 3 &&
    parts[0] === "knowledge" &&
    parts[2] === "add_files" &&
    knowledgeBase.safeParse(parts[1]).success
  );
}

export function createKnowledgeAddFilesTool() {
  return defineTool({
    name: KNOWLEDGE_ADD_FILES_TOOL_NAME,
    title: { en: "Add files to Knowledge Base", de: "Dateien zur Wissensbasis hinzufügen" },
    group: "platform",
    icon: "knowledge_base",
    effect: "changing",
    description:
      "Add conversation attachments to an existing published Knowledge Base that keeps documents. Find the Knowledge Base with platform.assets.list first. Name it under knowledgeBase and send files as conversationId/fileId pairs from the attachment manifest or platform.files.list. The person needs knowledge_base.write and must be able to open each source file. This uses the same operation as Studio > Knowledge Bases > the Knowledge Base > Documents > From your conversations (Studio > Wissensbasen > die Wissensbasis > Dokumente > Aus deinen Unterhaltungen). Its ordinary confirmation policy applies; pending confirmation has added nothing. On success the Knowledge Base owns a copy independent of the conversation, and everyone who uses it can search the file once indexing finishes. This neither creates nor publishes a Knowledge Base. If one is needed, help the person create and publish it in Studio first, then add the files.",
    inputSchema: knowledgeAddFilesInput,
    execute: () =>
      toolFailed("handler_failed", "Call Knowledge Base writes through the operation runner")
  });
}

/** The tool delegates to the native write, which owns authorization, policy and copying. */
export async function runKnowledgeAddFiles(
  request: ToolExecutionRequest,
  context: RuntimeCallContext,
  options: Pick<OperationCallRuntime, "unreadableInput">,
  listed: readonly string[],
  run: ToolOperationRunner
): Promise<ToolExecutionResult | ToolDecisionWait> {
  const parsed = knowledgeAddFilesInput.safeParse(request.input);
  if (!parsed.success || options.unreadableInput)
    return failed(
      "validation_failed",
      "Name a Knowledge Base and conversationId/fileId pairs under files."
    );
  if (!listed.includes(KNOWLEDGE_ADD_FILES_TOOL_NAME))
    return failed("not_allowed", "This agent cannot add files to Knowledge Bases.");
  return run(
    {
      ...request,
      toolName: `knowledge.${parsed.data.knowledgeBase}.add_files`,
      input: { files: parsed.data.files }
    },
    context,
    options
  );
}
