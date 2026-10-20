import { knowledgeAddFilesProjection } from "./tool-projections/knowledge-add-files";
import { knowledgeQueryProjection } from "./tool-projections/knowledge-query";
import { knowledgeSearchProjection } from "./tool-projections/knowledge-search";
import type { ToolProjection } from "./tool-projections/projection";
import { runAgentProjection } from "./tool-projections/run-agent";

/**
 * The tools whose calls the runner projects before it runs them, one line per tool, sorted.
 * A further one is a file under `tool-projections/` and a line here.
 */
export const TOOL_PROJECTIONS: readonly ToolProjection[] = [
  knowledgeAddFilesProjection,
  knowledgeQueryProjection,
  knowledgeSearchProjection,
  runAgentProjection
];

/** The projection of the tool a call names, or nothing for a tool that is its own operation. */
export function projectionOf(toolName: string): ToolProjection | undefined {
  return TOOL_PROJECTIONS.find((projection) => projection.toolName === toolName);
}

/** The effect of an operation a projection calls and no tool registers, or nothing. */
export function projectedOperationEffect(operation: string) {
  for (const projection of TOOL_PROJECTIONS) {
    const effect = projection.operationEffect?.(operation);
    if (effect !== undefined) return effect;
  }
  return undefined;
}
