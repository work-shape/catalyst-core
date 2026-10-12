import { APP_ACTION_OPERATION_PREFIX } from "./app-actions";
import { CONNECTION_OPERATION_PREFIX } from "./connection-operations";

// The names of data tools, apart from their types: the operation registry reads the prefixes,
// and the types of a data tool source read the registry's.

/**
 * The name prefixes that belong to data tools. A tool of the release may not take a name that
 * starts with one, and an agent may list such a name without the release knowing it.
 */
export const DATA_TOOL_PREFIXES = [
  CONNECTION_OPERATION_PREFIX,
  APP_ACTION_OPERATION_PREFIX
] as const;

export function isDataToolName(name: string): boolean {
  return DATA_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}
