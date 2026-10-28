import { APP_ACTION_OPERATION_PREFIX } from "./app-actions";
import { DATA_STORE_OPERATION_PREFIX } from "./data-store-operation-names";
import { CONNECTION_OPERATION_PREFIX } from "./connection-operations";

// The names of data tools, apart from their types: the operation registry reads the prefixes,
// and the types of a data tool source read the registry's.

/**
 * The release tools under `app.` load and save an App working copy. Other names under
 * `app.` are kept for the actions of Apps, `app.<id>.<action>`.
 */
export const APP_SAVE_TOOL_NAME = "app.save";
export const APP_EDIT_TOOL_NAME = "app.edit";

/**
 * The tool that adds a Data Store to a conversation for reading (STORE-USE-1). It is a tool of
 * the platform, not one of a store: no store's operation is named `use`.
 */
export const DATA_STORE_USE_TOOL_NAME = "data_store.use";

/**
 * The prefix of the data tools a name belongs to, or nothing. Every name under `connection.` is
 * a Connection's, every name under `data_store.` a Data Store's, and every name under `app.` but the edit and save tools an App's. A tool of the
 * release may not take a data tool's name, and an agent may list one without the release
 * knowing it.
 */
export function dataToolPrefixOf(name: string): string | undefined {
  if (name.startsWith(DATA_STORE_OPERATION_PREFIX) && name !== DATA_STORE_USE_TOOL_NAME)
    return DATA_STORE_OPERATION_PREFIX;
  if (name.startsWith(CONNECTION_OPERATION_PREFIX)) return CONNECTION_OPERATION_PREFIX;
  return name.startsWith(APP_ACTION_OPERATION_PREFIX) &&
    name !== APP_SAVE_TOOL_NAME &&
    name !== APP_EDIT_TOOL_NAME
    ? APP_ACTION_OPERATION_PREFIX
    : undefined;
}

export function isDataToolName(name: string): boolean {
  return dataToolPrefixOf(name) !== undefined;
}
