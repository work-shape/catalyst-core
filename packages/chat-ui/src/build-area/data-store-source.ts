import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@vivd-catalyst/api-client";
import { useSettingsPage } from "../settings/settings-page-context";
import { instanceSentence } from "./build-refusals";

/** The state of one Data Store, as `data_stores.get` answers it. */
export type DataStoreState = Awaited<ReturnType<ApiClient["data_stores"]["get"]>>;
/** The tables and columns of one Data Store, as `data_stores.describe` answers them. */
export type DataStoreSchema = Awaited<ReturnType<ApiClient["data_stores"]["describe"]>>;
/** The first rows of one table, as `data_stores.preview_rows` answers them. */
export type DataStoreRows = Awaited<ReturnType<ApiClient["data_stores"]["preview_rows"]>>;

/** How many rows the page asks for: the most one preview answers. */
const DATA_STORE_PREVIEW_ROWS = 50;

/** One answer of the instance, as the page asked for it. */
export type DataStoreRead<Answer> =
  | { status: "loading" }
  /** The read failed. The sentence is the instance's own, where it sent one. */
  | { status: "failed"; message: string | undefined; retry(): void }
  | { status: "ready"; data: Answer };

/**
 * Everything the Data Store list and page read beyond the asset the frame hands them. The page
 * is handed this and reads nothing else, so a test hands it answers of its own. Every read is
 * the store's own operation and needs the right to read the store. Nothing here writes.
 */
export interface DataStoreSource {
  /** A hook: where the store's migrations stand, its size and what the server leaves open. */
  useStoreState(store: string): DataStoreRead<DataStoreState>;
  /** A hook: the tables and columns of the store. */
  useSchema(store: string): DataStoreRead<DataStoreSchema>;
  /** A hook: the first rows of one table, as many as one preview answers. */
  useRows(store: string, table: string): DataStoreRead<DataStoreRows>;
}

/** The Data Store pages on the instance: `data_stores.get`, `.describe` and `.preview_rows`. */
export function useDataStoreSource(): DataStoreSource {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const calls = client.data_stores;
  const key = (read: string, ...parts: string[]) => [
    "data-store",
    apiBaseUrl,
    authScope,
    read,
    ...parts
  ];
  return {
    useStoreState: (store) =>
      useRead(key("state", store), (signal) => calls.get({ params: { store }, signal })),
    useSchema: (store) =>
      useRead(key("schema", store), (signal) => calls.describe({ params: { store }, signal })),
    useRows: (store, table) =>
      useRead(key("rows", store, table), (signal) =>
        calls.preview_rows({
          params: { store },
          query: { table, limit: DATA_STORE_PREVIEW_ROWS },
          signal
        })
      )
  };
}

function useRead<Answer>(
  queryKey: string[],
  read: (signal: AbortSignal) => Promise<Answer>
): DataStoreRead<Answer> {
  const query = useQuery({ queryKey, queryFn: ({ signal }) => read(signal), retry: false });
  // What was read stays while it is read again: the page does not blink.
  if (query.data !== undefined) {
    return { status: "ready", data: query.data };
  }
  if (query.error && !query.isFetching) {
    return {
      status: "failed",
      message: instanceSentence(query.error),
      retry: () => void query.refetch().catch(() => undefined)
    };
  }
  return { status: "loading" };
}
