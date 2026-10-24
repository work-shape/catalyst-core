import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import type { ApiClient } from "@work-shape/catalyst-api-client";
import { OPERATIONS_AUDIENCES } from "@work-shape/catalyst-core";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import { usePlatformContextQuery } from "../../shared/api/workspace-queries";
import { canViewSystem } from "../../shared/governance";
import { workspaceRoutePath, type WorkspaceRoute } from "../../shared/routes";
import { useSettingsPage } from "../../shared/settings-page-context";
import { apiErrorCode } from "../../shared/workspace-utils";
import { useAppsHost } from "../apps/apps-host";
import { useWorkflowsHost } from "../workflows/workflows-host";
import { instanceSentence } from "./build-refusals";
import type { DataFlows } from "./data-flows-model";
import { dataStoreStateSettling, type DataStoreState } from "./data-store-model";

export type { DataStoreState };
/** The tables and columns of one Data Store, as `data_stores.describe` answers them. */
export type DataStoreSchema = Awaited<ReturnType<ApiClient["data_stores"]["describe"]>>;
/** The stores the reader may read with what was last measured, as `data_stores.list` answers. */
export type DataStoreListed = Awaited<ReturnType<ApiClient["data_stores"]["list"]>>;
/** One page of the rows of a table, as `data_stores.rows` answers it. */
export type DataStoreRowsPage = Awaited<ReturnType<ApiClient["data_stores"]["rows"]>>;
/** One value of one row whole, as `data_stores.value` answers it. */
export type DataStoreValue = Awaited<ReturnType<ApiClient["data_stores"]["value"]>>;
/**
 * The Apps and Workflows that use a store, as `data_stores.used_by` answers them, with the
 * data Workflows that fill or process it.
 */
export type DataStoreUsedBy = Awaited<ReturnType<ApiClient["data_stores"]["used_by"]>> & {
  dataFlows?: DataFlows;
};

/** One page of the record fields that wait for a person, as `data_stores.records_flagged` answers. */
export type DataStoreFlagged = Awaited<ReturnType<ApiClient["data_stores"]["records_flagged"]>>;
/** One candidate of a flagged field, with the reason it waits. */
export type DataStoreFlaggedItem = DataStoreFlagged["items"][number];
/** A person's decision on one field, as `data_stores.records_decide` takes it. */
export type DataStoreDecision = Parameters<ApiClient["data_stores"]["records_decide"]>[0]["body"];

/**
 * "Prüfen" of a store with records rules: the fields that wait for a person and the decision on
 * one. The only write of the page; Publish and Delete stay the frame's.
 */
export interface DataStoreReviewSource {
  /**
   * A hook: the first `limit` candidates that wait, in the instance's order. Without a limit it
   * reads nothing and stays loading, as for a store without records rules.
   */
  useFlagged(store: string, limit: number | undefined): DataStoreRead<DataStoreFlagged>;
  /**
   * Decides one field and reads what waits, and the rows, again. Answers the instance's
   * sentence where it refused, and nothing where the decision was taken.
   */
  decide(store: string, decision: DataStoreDecision): Promise<string | undefined>;
}

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
 * What the database server leaves open around a store, as far as the reader can close it: all
 * of it for whoever runs the server, nothing for anybody else. The list and the page both read
 * it here, so neither counts what the other does not show.
 */
export function serverConditionsShown(
  source: Pick<DataStoreSource, "seesServerConditions">,
  state: Pick<DataStoreState, "conditions">
): DataStoreState["conditions"] {
  return source.seesServerConditions ? state.conditions : [];
}

/**
 * Everything the Data Store list and page read beyond the asset the frame hands them. The page
 * is handed this and reads nothing else, so a test hands it answers of its own. Every read is
 * the store's own operation and needs the right to read the store. Only a decision in "Prüfen"
 * writes.
 */
export interface DataStoreSource {
  /**
   * The reader sees how the instance runs (`system.view`, RIGHTS-1e), as who runs the database
   * server does: only they can close what the server leaves open around a store, so only they
   * are shown it.
   */
  seesServerConditions: boolean;
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
  ): (
    kind: (typeof OPERATIONS_AUDIENCES)[number],
    name: string
  ) => { href: string; open(): void } | undefined;
  /** "Prüfen" of a store with records rules. */
  review: DataStoreReviewSource;
}

/**
 * The Data Store pages on the instance: `data_stores.get`, `.describe`, `.list`, `.rows`,
 * `.value`, `.used_by`, `.records_flagged` and `.records_decide`.
 */
export function useDataStoreSource(): DataStoreSource {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const queryClient = useQueryClient();
  const platform = usePlatformContextQuery({ apiBaseUrl, authScope, client, enabled: true }).data;
  const calls = client.data_stores;
  const key = (read: string, ...parts: string[]) => [
    ...workspaceQueryKeys.dataStores(apiBaseUrl),
    authScope,
    read,
    ...parts
  ];
  return {
    seesServerConditions: canViewSystem(platform),
    // A store being set up or migrated is read again until it settles, as the jobs run apart
    // from the page that published it.
    useStoreState: (store) =>
      useRead(key("state", store), (signal) => calls.get({ params: { store }, signal }), {
        pollWhile: dataStoreStateSettling
      }),
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
    useUsingPage,
    review: {
      useFlagged: (store, limit) =>
        useRead(
          key("flagged", store, String(limit ?? 0)),
          (signal) =>
            calls.records_flagged({ params: { store }, query: { limit: limit ?? 1 }, signal }),
          // A longer list keeps the shorter one while it is read.
          { keepPrevious: true, enabled: limit !== undefined }
        ),
      decide: async (store, decision) => {
        try {
          await calls.records_decide({ params: { store }, body: decision });
        } catch (error) {
          return instanceSentence(error) ?? "";
        }
        // What waits, the rows the decision wrote and the store's size are read again.
        await queryClient.invalidateQueries({ queryKey: key("flagged", store) });
        await queryClient.invalidateQueries({ queryKey: key("rows", store) });
        return undefined;
      }
    }
  };
}

/**
 * A hook: the way to the page of an App or a Workflow, or nothing where the reader is shown no
 * such page. An App and a Workflow are opened inside a workspace: the one named, such as the
 * one an asset belongs to, or the one the reader has open.
 */
export function useUsingPage(workspaceId: string | undefined): (
  kind: (typeof OPERATIONS_AUDIENCES)[number],
  name: string,
  /** The workspace that owns what is opened, where it is not the one `workspaceId` names. */
  ownerWorkspaceId?: string
) => { href: string; open(): void } | undefined {
  const apps = useAppsHost();
  const workflows = useWorkflowsHost();
  const collaborationWorkspaceId = workspaceId ?? apps?.workspace?.id ?? workflows?.workspace?.id;
  return (kind, name, ownerWorkspaceId) => {
    const route = usingPageRoute(kind, name, {
      collaborationWorkspaceId: ownerWorkspaceId ?? collaborationWorkspaceId,
      apps: apps?.enabled ?? false,
      workflows: workflows !== undefined
    });
    const showRoute = kind === "app" ? apps?.showRoute : workflows?.showRoute;
    return route && showRoute
      ? { href: workspaceRoutePath(route), open: () => showRoute(route) }
      : undefined;
  };
}

/**
 * The page of an App or a Workflow that uses a store, or nothing where its reader is shown no
 * such page: the Apps module is off, the Workflows area is not open to the reader, or no
 * workspace is.
 */
export function usingPageRoute(
  kind: (typeof OPERATIONS_AUDIENCES)[number],
  name: string,
  shown: { collaborationWorkspaceId: string | undefined; apps: boolean; workflows: boolean }
): WorkspaceRoute | undefined {
  const { collaborationWorkspaceId } = shown;
  if (collaborationWorkspaceId === undefined) return undefined;
  if (kind === "app") {
    return shown.apps ? { kind: "app", collaborationWorkspaceId, app: name } : undefined;
  }
  return shown.workflows
    ? { kind: "workflow", collaborationWorkspaceId, workflow: name }
    : undefined;
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

/** How often the state of a store is read again while it is set up or migrated. */
const STATE_POLL_MS = 3_000;
/**
 * How long a store that does not settle is read again, from its first unsettled answer, also
 * while reads fail: a set up or a migration takes seconds. Past it the page keeps the last state
 * it read and reads again when it is opened again.
 */
const STATE_POLL_MAX_MS = 10 * 60_000;

function useRead<Answer>(
  queryKey: string[],
  read: (signal: AbortSignal) => Promise<Answer>,
  options: {
    enabled?: boolean;
    keepPrevious?: boolean;
    /** Reads again every `STATE_POLL_MS` while what was read says so, for a bounded time. */
    pollWhile?: (answer: Answer) => boolean;
  } = {}
): DataStoreRead<Answer> {
  const { pollWhile } = options;
  // Since when the store this reads, by its query, has been read again: by the clock, as a
  // failed read changes no answer.
  const polling = useRef<{ queryHash: string; since: number } | undefined>(undefined);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => read(signal),
    retry: false,
    enabled: options.enabled ?? true,
    ...(options.keepPrevious ? { placeholderData: keepPreviousData } : {}),
    refetchInterval: ({ state, queryHash }) => {
      if (!pollWhile || state.data === undefined || !pollWhile(state.data)) {
        polling.current = undefined;
        return false;
      }
      if (polling.current?.queryHash !== queryHash) {
        polling.current = { queryHash, since: Date.now() };
      }
      return Date.now() - polling.current.since < STATE_POLL_MAX_MS ? STATE_POLL_MS : false;
    }
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
