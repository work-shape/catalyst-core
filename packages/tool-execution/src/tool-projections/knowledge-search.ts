import { KNOWLEDGE_SEARCH_TOOL_NAME } from "@work-shape/catalyst-core";
import { runKnowledgeSearch } from "../knowledge-search-tool";
import type { ToolProjection } from "./projection";

/** One call of each Knowledge Base's search, merged: each call takes this runner's path. */
export const knowledgeSearchProjection: ToolProjection = {
  toolName: KNOWLEDGE_SEARCH_TOOL_NAME,
  async project(request, { context, options, deps, runner, takeKnowledgeRefs }) {
    return {
      answer: await runKnowledgeSearch(request, context, options, deps, runner, takeKnowledgeRefs)
    };
  }
};
