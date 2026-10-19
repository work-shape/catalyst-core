import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { listAll } from "@work-shape/catalyst-api-client";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import {
  runGoing,
  type ScheduledRun,
  type ScheduledStart,
  type ScheduledStartInput
} from "./scheduled-model";
import { createScheduledStartsSource, type ScheduledStartsSource } from "./scheduled-source";

/** How many scheduled starts one read of the list asks for. */
const LIST_PAGE_SIZE = 50;
/** How many runs a scheduled start shows. */
const RECENT_RUNS = 3;
/** How often the runs are read again while one is going or a run asked for has not shown. */
const RUNS_REFRESH_MS = 2_000;
/**
 * How often the list and the runs are read again while the page is open and nothing is going,
 * so a due time that passed shows its run, its skip reason and the next time. React Query
 * stops this while the tab is hidden.
 */
const IDLE_REFRESH_MS = 30_000;

/**
 * How long until the runs of a scheduled start are read again: soon while one is going or a
 * run asked for (`awaitingAfter`, the newest run's id then, `null` for none) has not shown,
 * else at the idle pace.
 */
export function runsRefreshMs(
  runs: readonly ScheduledRun[],
  awaitingAfter: string | null | undefined
): number {
  const newest = runs[0]?.id ?? null;
  const awaiting = awaitingAfter !== undefined && newest === awaitingAfter;
  return awaiting || runs.some(runGoing) ? RUNS_REFRESH_MS : IDLE_REFRESH_MS;
}

function useScheduledSource(): { source: ScheduledStartsSource; key: readonly string[] } {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  return useMemo(
    () => ({ source: createScheduledStartsSource(client), key: ["scheduled-starts", apiBaseUrl] }),
    [apiBaseUrl, client]
  );
}

/** A person's scheduled starts in one workspace, as far as read. */
export interface ScheduledList {
  /** Absent until the first page arrived. */
  rows: readonly ScheduledStart[] | undefined;
  failed: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore(): void;
  retry(): void;
}

export function useScheduledList(workspaceId: string): ScheduledList {
  const { source, key } = useScheduledSource();
  const query = useInfiniteQuery({
    queryKey: [...key, "list", workspaceId],
    queryFn: ({ pageParam, signal }) =>
      source.list(
        workspaceId,
        { limit: LIST_PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
        signal
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: IDLE_REFRESH_MS
  });
  return {
    rows: query.data?.pages.flatMap((page) => page.items),
    failed: query.isError,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    // A failed page shows through `failed`, so there is nothing to catch here.
    loadMore: () => void query.fetchNextPage().catch(() => undefined),
    retry: () => void query.refetch().catch(() => undefined)
  };
}

/** The latest runs of one scheduled start. */
export interface ScheduledRuns {
  /** Newest first. Absent until they arrived. */
  runs: readonly ScheduledRun[] | undefined;
  failed: boolean;
  retry(): void;
}

/**
 * The latest runs of a scheduled start, read again at the pace of `runsRefreshMs`.
 */
export function useScheduledRuns(
  scheduledStartId: string,
  awaitingAfter: string | null | undefined
): ScheduledRuns {
  const { source, key } = useScheduledSource();
  const query = useQuery({
    queryKey: [...key, "runs", scheduledStartId],
    queryFn: ({ signal }) => source.runs(scheduledStartId, { limit: RECENT_RUNS }, signal),
    refetchInterval: (current) => runsRefreshMs(current.state.data?.items ?? [], awaitingAfter)
  });
  return {
    runs: query.data?.items,
    failed: query.isError,
    retry: () => void query.refetch().catch(() => undefined)
  };
}

/**
 * One of the person's own scheduled starts by its id, as a confirmation names it. The person's
 * list is read to its end, since there is no read of one; it is nothing where the list does
 * not hold it.
 */
export function useOwnScheduledStart(scheduledStartId: string): {
  pending: boolean;
  start: ScheduledStart | undefined;
} {
  const { source, key } = useScheduledSource();
  const query = useQuery({
    queryKey: [...key, "own", scheduledStartId],
    queryFn: async ({ signal }) => {
      const starts = await listAll((paging) => source.list(undefined, paging, signal));
      return starts.find((start) => start.id === scheduledStartId) ?? null;
    }
  });
  return { pending: query.isPending, start: query.data ?? undefined };
}

/** The writes of the page. Each reads the list again once it is done. */
export function useScheduledWrites(workspaceId: string) {
  const { source, key } = useScheduledSource();
  const queryClient = useQueryClient();
  // A change shows on the page and in every confirmation that names a saved one.
  const refreshList = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: [...key, "list"] }),
      queryClient.invalidateQueries({ queryKey: [...key, "own"] })
    ]);
  const refreshRuns = (scheduledStartId: string) =>
    queryClient.invalidateQueries({ queryKey: [...key, "runs", scheduledStartId] });
  return {
    save: useMutation({
      mutationFn: (input: { scheduledStartId?: string; values: ScheduledStartInput }) =>
        input.scheduledStartId === undefined
          ? source.create(workspaceId, input.values)
          : source.update(input.scheduledStartId, input.values),
      onSuccess: refreshList
    }),
    setState: useMutation({
      mutationFn: (input: { scheduledStartId: string; state: ScheduledStart["state"] }) =>
        source.setState(input.scheduledStartId, input.state),
      onSuccess: refreshList
    }),
    runNow: useMutation({
      mutationFn: (scheduledStartId: string) => source.runNow(scheduledStartId),
      onSuccess: (_answer, scheduledStartId) => refreshRuns(scheduledStartId)
    }),
    remove: useMutation({
      mutationFn: (scheduledStartId: string) => source.remove(scheduledStartId),
      onSuccess: refreshList
    })
  };
}
