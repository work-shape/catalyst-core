import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@vivd-catalyst/api-client";
import { useAppsHost } from "../apps/apps-host";
import { workspaceRoutePath } from "../routes";
import { useSettingsPage } from "../settings/settings-page-context";
import { apiErrorCode } from "../workspace-utils";
import { instanceSentence } from "./build-refusals";

/** The state of one Data Store, as `data_stores.get` answers it. */
export type DataStoreState = Awaited<ReturnType<ApiClient["data_stores"]["get"]>>;
/** The tables and columns of one Data Store, as `data_stores.describe` answers them. */
export type DataStoreSchema = Awaited<ReturnType<ApiClient["data_stores"]["describe"]>>;
/** The stores the reader may read with what was last measured, as `data_stores.list` answers. */
export type DataStoreListed = Awaited<ReturnType<ApiClient["data_stores"]["list"]>>;
/** One page of the rows of a table, as `data_stores.rows` answers it. */
export type DataStoreRowsPage = Awaited<ReturnType<ApiClient["data_stores"]["rows"]>>;
/** One value of one row whole, as `data_stores.value` answers it. */
export type DataStoreValue = Awaited<ReturnType<ApiClient["data_stores"]["value"]>>;
/** The Apps and Workflows that use a store, as `data_stores.used_by` answers them. */
export type DataStoreUsedBy = Awaited<ReturnType<ApiClient["data_stores"]["used_by"]>>;

/** Where one value lies: its table, its column and `at` of its row. */
export interface DataStoreValuePlace {
  table: string;
  column: string;
  at: string;
}

/** One answer of the instance, as the page asked for it. */
export type DataStoreRead<Answer> =
  | { status: "loading" }
  /** The instance answered that this person may not read this. */
  | { status: "refused" }
  /**
   * The read failed. The sentence is the instance's own, where it sent one, and `reason` is
   * the one its refusal names, such as `value_too_large`.
   */
  | { status: "failed"; message: string | undefined; reason?: string; retry(): void }
  /** `renewing`: the answer shown is the one before, while the one asked for is read. */
  | { status: "ready"; data: Answer; renewing?: boolean };

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
  /** A hook: every store with what its last measurement found. One read for the whole list. */
  useListed(): DataStoreRead<DataStoreListed>;
  /** A hook: the page of a table that starts behind `after`, or its first page without one. */
  useRowsPage(
    store: string,
    table: string,
    after: string | undefined
  ): DataStoreRead<DataStoreRowsPage>;
  /** A hook: one value whole. Without a place it reads nothing and stays loading. */
  useValue(store: string, place: DataStoreValuePlace | undefined): DataStoreRead<DataStoreValue>;
  /** A hook: the Apps and Workflows that use the store. */
  useUsedBy(store: string): DataStoreRead<DataStoreUsedBy>;
  /**
   * A hook: the page of an App or a Workflow that uses a store, as its address and the way to
   * open it, or nothing where the interface has no page for it. `workspaceId` is the workspace
   * the store belongs to, where it belongs to one.
   */
  useUsingPage(
    workspaceId: string | undefined
  ): (kind: "app" | "workflow", name: string) => { href: string; open(): void } | undefined;
}

/**
 * The Data Store pages on the instance: `data_stores.get`, `.describe`, `.list`, `.rows`,
 * `.value` and `.used_by`.
 */
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
    useListed: () => useRead(key("list"), (signal) => calls.list({ signal })),
    useRowsPage: (store, table, after) =>
      useRead(
        key("rows", store, table, after ?? ""),
        (signal) =>
          calls.rows({
            params: { store },
            query: { table, ...(after === undefined ? {} : { after }) },
            signal
          }),
        // The page before stays while the next one is read: the table keeps its height.
        { keepPrevious: true }
      ),
    useValue: (store, place) =>
      useRead(
        key("value", store, place?.table ?? "", place?.column ?? "", place?.at ?? ""),
        (signal) =>
          calls.value({
            params: { store },
            query: place ?? { table: "", column: "", at: "" },
            signal
          }),
        { enabled: place !== undefined }
      ),
    useUsedBy: (store) =>
      useRead(key("used-by", store), (signal) => calls.used_by({ params: { store }, signal })),
    useUsingPage(workspaceId) {
      // An App is opened inside a workspace: the store's own, or the one the reader has open.
      const host = useAppsHost();
      const collaborationWorkspaceId = workspaceId ?? host?.workspace?.id;
      return (kind, name) => {
        // A Workflow has no page in the interface yet, so nothing links to one.
        if (kind !== "app" || !host?.enabled || collaborationWorkspaceId === undefined) {
          return undefined;
        }
        const route = { kind: "app" as const, collaborationWorkspaceId, app: name };
        return { href: workspaceRoutePath(route), open: () => host.showRoute(route) };
      };
    }
  };
}

/** The reason a refusal of the instance names in its details, read from an unvouched answer. */
function refusalReason(error: unknown): string | undefined {
  let value: unknown = error;
  for (const member of ["payload", "error", "details", "reason"]) {
    value =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.getOwnPropertyDescriptor(value, member)?.value
        : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

function useRead<Answer>(
  queryKey: string[],
  read: (signal: AbortSignal) => Promise<Answer>,
  options: { enabled?: boolean; keepPrevious?: boolean } = {}
): DataStoreRead<Answer> {
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => read(signal),
    retry: false,
    enabled: options.enabled ?? true,
    ...(options.keepPrevious ? { placeholderData: keepPreviousData } : {})
  });
  // What was read stays while it is read again: the page does not blink.
  if (query.data !== undefined) {
    return {
      status: "ready",
      data: query.data,
      ...(query.isPlaceholderData ? { renewing: true } : {})
    };
  }
  if (query.error && !query.isFetching) {
    if (apiErrorCode(query.error) === "FORBIDDEN") {
      return { status: "refused" };
    }
    const reason = refusalReason(query.error);
    return {
      status: "failed",
      message: instanceSentence(query.error),
      ...(reason === undefined ? {} : { reason }),
      retry: () => void query.refetch().catch(() => undefined)
    };
  }
  return { status: "loading" };
}
