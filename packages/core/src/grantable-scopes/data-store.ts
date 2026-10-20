import type { ActionScopes } from "./action-scopes";

export const DATA_STORE_GRANT_SCOPES = {
  // Definition and row rights are granted separately, on one store, what a workspace owns,
  // or the instance. Editing or publishing a definition grants no right to write rows.
  "data_store.read": ["workspace", "asset", "instance"],
  "data_store.insert": ["workspace", "asset", "instance"],
  "data_store.execute": ["workspace", "asset", "instance"],
  "data_store.write": ["workspace", "asset", "instance"],
  "data_store.publish": ["workspace", "asset", "instance"],
  "data_store.delete": ["workspace", "asset", "instance"],
  "data_store.records": ["workspace", "asset", "instance"]
} as const satisfies ActionScopes;
