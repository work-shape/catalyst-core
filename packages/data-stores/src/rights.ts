/**
 * The rights of the kind `data_store`. The one declaration of these names until the shared
 * list of actions carries them; then this file is deleted and its readers import from there.
 */
export const DATA_STORE_ACTIONS = {
  read: "data_store.read",
  write: "data_store.write",
  publish: "data_store.publish",
  delete: "data_store.delete"
} as const;
