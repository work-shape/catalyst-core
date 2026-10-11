import { CONNECTION_OPERATION_PREFIX } from "./connection-operations";
import type { OperationListScope } from "./operation-registry";
import type { OperationEffect } from "./operations";
import type { ToolDescriptor } from "./tool-execution";

/**
 * A tool an agent carries that exists as data: the projection of an operation an
 * `OperationSource` contributes. It has no handler of its own. A call of it is a call of that
 * operation through `runOperation`.
 */
export interface DataToolDescriptor extends ToolDescriptor {
  effect: OperationEffect;
}

/** Describes the data tools an agent lists, as they are now. */
export interface DataToolSource {
  /**
   * Of the named tools, those that exist now and that an agent may carry. One read, never one
   * per name. A name that is gone, disabled or not exposed to agents is left out.
   */
  describe(toolNames: readonly string[], scope: OperationListScope): Promise<DataToolDescriptor[]>;
}

/**
 * The name prefixes that belong to data tools. A tool of the release may not take a name that
 * starts with one, and an agent may list such a name without the release knowing it.
 */
export const DATA_TOOL_PREFIXES = [CONNECTION_OPERATION_PREFIX] as const;

export function isDataToolName(name: string): boolean {
  return DATA_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}
