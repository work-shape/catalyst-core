import { APP_ACTION_OPERATION_PREFIX } from "./app-actions";
import { DATA_STORE_OPERATION_PREFIX } from "./data-store-operation-names";
import { CONNECTION_OPERATION_PREFIX } from "./connection-operations";

// The names of data tools, apart from their types: the operation registry reads the prefixes,
// and the types of a data tool source read the registry's.

/**
 * The one tool of the release whose name lies under `app.`: it saves what a conversation opened
 * as an App. Every other name under `app.` is kept for the actions of Apps, `app.<id>.<action>`.
 */
export const APP_SAVE_TOOL_NAME = "app.save";

/**
 * The prefix of the data tools a name belongs to, or nothing. Every name under `connection.` is
 * a Connection's, every name under `data_store.` a Data Store's, and every name under `app.` but `APP_SAVE_TOOL_NAME` an App's. A tool of the
 * release may not take a data tool's name, and an agent may list one without the release
 * knowing it.
 */
export function dataToolPrefixOf(name: string): string | undefined {
  if (name.startsWith(DATA_STORE_OPERATION_PREFIX)) return DATA_STORE_OPERATION_PREFIX;
  if (name.startsWith(CONNECTION_OPERATION_PREFIX)) return CONNECTION_OPERATION_PREFIX;
  return name.startsWith(APP_ACTION_OPERATION_PREFIX) && name !== APP_SAVE_TOOL_NAME
    ? APP_ACTION_OPERATION_PREFIX
    : undefined;
}

export function isDataToolName(name: string): boolean {
  return dataToolPrefixOf(name) !== undefined;
}
