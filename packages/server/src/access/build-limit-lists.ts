import { AppError } from "@work-shape/catalyst-core";

/**
 * The lists a Namespace or a Shared Workspace may restrict its agents to: its build limits.
 * `null` lifts a restriction.
 */
export interface BuildLimitListsCommand {
  allowedToolNames?: string[] | null;
  allowedModelBindingIds?: string[] | null;
}

/**
 * The lists as a Namespace or a workspace keeps them, each entry once. An entry must exist on
 * this instance: an enabled tool, a known model binding.
 */
export function buildLimitLists(
  refs: { enabledToolNames: readonly string[]; modelBindingIds: readonly string[] },
  command: BuildLimitListsCommand
): BuildLimitListsCommand {
  const unknownTool = command.allowedToolNames?.find(
    (name) => !refs.enabledToolNames.includes(name)
  );
  if (unknownTool !== undefined) {
    throw new AppError("VALIDATION_FAILED", `'${unknownTool}' is not an enabled tool`, {
      reason: "unknown_tool",
      toolName: unknownTool
    });
  }
  const unknownBinding = command.allowedModelBindingIds?.find(
    (id) => !refs.modelBindingIds.includes(id)
  );
  if (unknownBinding !== undefined) {
    throw new AppError("VALIDATION_FAILED", `'${unknownBinding}' is not a model binding`, {
      reason: "unknown_model_binding",
      modelBindingId: unknownBinding
    });
  }
  return {
    ...(command.allowedToolNames === undefined
      ? {}
      : { allowedToolNames: unique(command.allowedToolNames) }),
    ...(command.allowedModelBindingIds === undefined
      ? {}
      : { allowedModelBindingIds: unique(command.allowedModelBindingIds) })
  };
}

function unique(values: string[] | null): string[] | null {
  return values === null ? null : [...new Set(values)];
}
