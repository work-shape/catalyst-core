import {
  KNOWLEDGE_ADD_FILES_TOOL_NAME,
  isKnowledgeAddFilesOperation,
  runKnowledgeAddFiles
} from "../knowledge-add-files-tool";
import type { ToolProjection } from "./projection";

/** Adding files to a Knowledge Base the agent lists, as one call of its operation per base. */
export const knowledgeAddFilesProjection: ToolProjection = {
  toolName: KNOWLEDGE_ADD_FILES_TOOL_NAME,
  async project(request, { context, options, deps, runner }) {
    const listed = (await deps.agentToolNames?.(request.agentName, request.conversationId)) ?? [];
    return { answer: await runKnowledgeAddFiles(request, context, options, listed, runner) };
  },
  operationEffect: (operation) => (isKnowledgeAddFilesOperation(operation) ? "changing" : undefined)
};
