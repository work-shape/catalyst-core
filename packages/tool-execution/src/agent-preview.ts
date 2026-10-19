import {
  forbiddenPreviewTool,
  knowledgeOperationNamesOf,
  type OperationDraftContext,
  type OperationResult,
  type ToolExecutionResult,
  type LocaleCode,
  type RuntimeCallContext
} from "@work-shape/catalyst-core";
import type { RunOperationDeps } from "./operation-execution";

/** The frozen preview definition decides its tools; the ordinary authorization still asks the person's rights. */
export function previewToolDeps(
  deps: RunOperationDeps,
  context: RuntimeCallContext
): RunOperationDeps {
  const preview = context.agentPreview;
  if (!preview) return deps;
  const names = [
    ...preview.config.toolNames.filter((name) => !forbiddenPreviewTool(name)),
    ...knowledgeOperationNamesOf(preview.config)
  ];
  return { ...deps, agentToolNames: async (name) => (name === preview.config.name ? names : []) };
}

export function previewDraft(
  context: RuntimeCallContext,
  conversationId: string
): OperationDraftContext | undefined {
  const preview = context.agentPreview;
  return preview
    ? {
        kind: "agent_preview",
        asset: { kind: "agent", id: preview.agentId, name: preview.config.name },
        revisionId: `${preview.source}:${preview.revision}`,
        part: conversationId
      }
    : undefined;
}

/** A simulated operation is a successful explanation, never a claim that the change ran. */
export function previewToolResult(
  result: Extract<OperationResult, { status: "dry_run" }>,
  locale?: LocaleCode
): ToolExecutionResult {
  return {
    status: "success",
    output: {
      ...result,
      message:
        locale === "de"
          ? "Würde diese Aktion mit den angegebenen Werten ausführen. Es wurde nichts geändert."
          : "Would have performed this action with the supplied input. Nothing was changed."
    }
  };
}
