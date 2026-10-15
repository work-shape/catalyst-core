import { AppError } from "@vivd-catalyst/core";

/** The lists a Namespace may restrict its agents to. `null` lifts a restriction. */
export interface NamespaceListsCommand {
  allowedToolNames?: string[] | null;
  allowedModelBindingIds?: string[] | null;
}

/**
 * The lists as a Namespace keeps them, each entry once. An entry must exist on this instance:
 * an enabled tool, a known model binding.
 */
export function namespaceLists(
  refs: { enabledToolNames: readonly string[]; modelBindingIds: readonly string[] },
  command: NamespaceListsCommand
): NamespaceListsCommand {
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
