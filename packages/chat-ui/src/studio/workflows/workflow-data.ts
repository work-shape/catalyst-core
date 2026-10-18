import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { ApiError } from "@work-shape/catalyst-api-client";
import { WORKFLOW_ASSET_KIND } from "@work-shape/catalyst-core";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import { PendingApprovalError } from "../build-area/build-refusals";
import { retryUnlessGone } from "../pages/page-address";
import type { WorkflowRunsSource, WorkflowStepRunStatusFilter } from "./source-shapes";
import { useWorkflowsSource } from "./workflow-source";
import type {
  LiveOnceSwitchView,
  WorkflowListItem,
  WorkflowRunView,
  WorkflowStepRunView,
  WorkflowView
} from "./workflow-views";

// The reads and the two writes of the Workflow screens, as hooks over the source at hand. No
// screen names an operation or a type of the API contract.

/** How many Workflows one read of the list asks for. */
const WORKFLOW_LIST_PAGE_SIZE = 50;
/** How often a run that is going, and its steps, are read again. */
const RUN_REFRESH_MS = 2_000;
/** How often a list of runs is read again while one of its runs is going. */
const RUN_LIST_REFRESH_MS = 5_000;
/** How many step runs of a loop's entries one read asks for. */
const ENTRY_STEP_RUNS_PAGE_SIZE = 50;

/** Why a read did not answer what was asked for. */
export type WorkflowReadProblem = "missing" | "unavailable" | "failed";

function readProblem(error: unknown): WorkflowReadProblem {
  if (error instanceof ApiError && error.status === 404) {
    return "missing";
  }
  return error instanceof ApiError && error.status === 403 ? "unavailable" : "failed";
}

function useWorkflowKeys() {
  const { apiBaseUrl } = useWorkspaceApiClient();
  const source = useWorkflowsSource();
  return useMemo(
    () => ({
      // Under the key of every asset read, so a write from Build drops these too.
      assets: [
        ...workspaceQueryKeys.assets(apiBaseUrl, "standalone"),
        WORKFLOW_ASSET_KIND,
        source.key
      ] as const,
      runs: ["workflow-runs", source.key] as const,
      liveOnce: ["workflow-live-once", source.key] as const
    }),
    [apiBaseUrl, source.key]
  );
}

/** The Workflows of one workspace as far as the reader has asked for them. */
export interface WorkflowList {
  /** The rows read so far. Absent until the first page arrived. */
  rows: readonly WorkflowListItem[] | undefined;
  failed: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore(): void;
  retry(): void;
}

/** The Workflows of a workspace the reader may read, page by page. */
export function useWorkflowList(workspaceId: string | undefined): WorkflowList {
  const source = useWorkflowsSource();
  const keys = useWorkflowKeys();
  const query = useInfiniteQuery({
    queryKey: [...keys.assets, "list", workspaceId ?? ""],
    queryFn: ({ pageParam, signal }) =>
      source.listWorkflows(
        workspaceId ?? "",
        { limit: WORKFLOW_LIST_PAGE_SIZE, cursor: pageParam },
        signal
      ),
    enabled: workspaceId !== undefined,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor
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

/** One Workflow as its page asked for it. */
export interface WorkflowRead {
  workflow: WorkflowView | undefined;
  problem: WorkflowReadProblem | undefined;
  retry(): void;
}

/** One Workflow with its definition. Without an id nothing is read. */
export function useWorkflow(
  workspaceId: string | undefined,
  workflow: string | undefined
): WorkflowRead {
  const source = useWorkflowsSource();
  const keys = useWorkflowKeys();
  const query = useQuery({
    queryKey: [...keys.assets, "workflow", workspaceId ?? "", workflow ?? ""],
    queryFn: ({ signal }) => source.getWorkflow(workspaceId ?? "", workflow ?? "", signal),
    enabled: workspaceId !== undefined && workflow !== undefined,
    retry: retryUnlessGone,
    // The agent of a conversation saves a draft without this page knowing: whoever comes back
    // to the page is shown the Workflow as it is now. A return to the window reads it again
    // by the default of every read.
    refetchOnMount: "always"
  });
  return {
    workflow: query.data,
    problem: query.isError ? readProblem(query.error) : undefined,
    retry: () => void query.refetch().catch(() => undefined)
  };
}

/** The names of Workflows, by the order of their ids. A name is absent until it arrived. */
export function useWorkflowNames(
  workspaceId: string | undefined,
  workflows: readonly string[]
): (string | undefined)[] {
  const source = useWorkflowsSource();
  const keys = useWorkflowKeys();
  return useQueries({
    // The key and the read of `useWorkflow`, so a Workflow the reader came through is held.
    queries: workflows.map((workflow) => ({
      queryKey: [...keys.assets, "workflow", workspaceId ?? "", workflow],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        source.getWorkflow(workspaceId ?? "", workflow, signal),
      enabled: workspaceId !== undefined,
      retry: retryUnlessGone
    })),
    combine: (results) => results.map((result) => result.data?.name)
  });
}

/** The runs of one Workflow, newest first, as far as the reader has asked for them. */
export interface WorkflowRunList {
  rows: readonly WorkflowRunView[] | undefined;
  failed: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore(): void;
  retry(): void;
}

/** How often a list of runs is read again: while one of them is going, and not after. */
export function runListRefreshMs(runs: readonly Pick<WorkflowRunView, "ended">[]): number | false {
  return runs.some((run) => !run.ended) ? RUN_LIST_REFRESH_MS : false;
}

/** How often one run is read again: while it is going, and not once it has ended. */
export function runRefreshMs(run: Pick<WorkflowRunView, "ended"> | undefined): number | false {
  return run === undefined || run.ended ? false : RUN_REFRESH_MS;
}

/** The instance runs Workflows: there are runs to list, to start and to cancel. */
export function useRunsAvailable(): boolean {
  return useWorkflowsSource().runs !== undefined;
}

function runsOf(runs: WorkflowRunsSource | undefined): WorkflowRunsSource {
  if (runs === undefined) {
    throw new Error("This instance runs no Workflow.");
  }
  return runs;
}

/**
 * The runs of a Workflow, `pageSize` at a time, all of them or those whose run key starts with
 * `keyPrefix`. While one of them is going the list is read again at an interval; the query
 * pauses that by itself while the page is hidden.
 */
export function useWorkflowRuns(
  workflow: string,
  pageSize: number,
  keyPrefix?: string,
  /** False while the list is not to be read, such as for a reader known not to read the runs. */
  enabled = true
): WorkflowRunList {
  const { runs } = useWorkflowsSource();
  const keys = useWorkflowKeys();
  const query = useInfiniteQuery({
    queryKey: [...keys.runs, "list", workflow, pageSize, keyPrefix ?? null],
    queryFn: ({ pageParam, signal }) =>
      runsOf(runs).listRuns(
        workflow,
        {
          limit: pageSize,
          cursor: pageParam,
          ...(keyPrefix === undefined ? {} : { keyPrefix })
        },
        signal
      ),
    enabled: enabled && runs !== undefined,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    retry: retryUnlessGone,
    refetchInterval: (current) =>
      runListRefreshMs(current.state.data?.pages.flatMap((page) => page.items) ?? [])
  });
  return {
    rows: query.data?.pages.flatMap((page) => page.items),
    failed: query.isError,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage().catch(() => undefined),
    retry: () => void query.refetch().catch(() => undefined)
  };
}

/** One run as its page follows it. */
export interface WorkflowRunRead {
  run: WorkflowRunView | undefined;
  problem: WorkflowReadProblem | undefined;
  /** When the instance last answered about the run, while the readings since have failed. */
  silentSince: number | undefined;
  /**
   * The run was read and the latest reading of its steps failed. While the run's own reading
   * fails too, the page says only that it lost the instance.
   */
  stepsFailed: boolean;
  /**
   * The step runs outside every entry of a loop: what the canvas draws. Absent until they
   * arrived.
   */
  stepRuns: readonly WorkflowStepRunView[] | undefined;
  /**
   * The step runs of loops inside an item of another loop, which the canvas never draws: their
   * counts say what failed inside a run that ended `done`. Absent until they arrived.
   */
  entryLoops?: readonly WorkflowStepRunView[] | undefined;
  /** The run has more step runs than the page reads: steps late in the run may show no state. */
  stepRunsCut: boolean;
  retry(): void;
}

/**
 * One run and the step runs of its frame, read every two seconds while the run is going. The
 * reading stops when the run has ended and its steps were read once more after that, and it
 * pauses while the page is hidden.
 */
export function useWorkflowRun(runId: string): WorkflowRunRead {
  const { runs } = useWorkflowsSource();
  const keys = useWorkflowKeys();
  const query = useQuery({
    queryKey: [...keys.runs, "run", runId],
    queryFn: ({ signal }) => runsOf(runs).getRun(runId, signal),
    retry: retryUnlessGone,
    refetchInterval: (current) => runRefreshMs(current.state.data)
  });
  const run = query.data;
  // The run's own answer is part of the key once it has ended, so the steps are read once
  // more after the last change and never again.
  const steps = useQuery({
    queryKey: [...keys.runs, "frame", runId, run?.ended === true ? run.status : "going"],
    queryFn: ({ signal }) => runsOf(runs).listFrameStepRuns(runId, signal),
    enabled: run !== undefined,
    retry: retryUnlessGone,
    // The steps stay in view while the key moves from "going" to the run's end, never into the
    // page of another run, whose state they would claim until its own steps arrive.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey.includes(runId) === true ? previous : undefined,
    refetchInterval: () => runRefreshMs(run)
  });
  return {
    run,
    problem: query.isError && run === undefined ? readProblem(query.error) : undefined,
    silentSince: query.isError && run !== undefined ? query.dataUpdatedAt : undefined,
    // Said until a reading of the steps succeeds, also where earlier steps are held.
    stepsFailed: steps.isError && !query.isError,
    stepRuns: steps.data?.stepRuns,
    entryLoops: steps.data?.entryLoops,
    stepRunsCut: steps.data?.complete === false,
    retry: () => {
      void query.refetch().catch(() => undefined);
      // Before the run arrived there are no steps to ask for.
      if (run !== undefined) void steps.refetch().catch(() => undefined);
    }
  };
}

/** The step runs of a loop's entries in one state, as far as the reader has asked for them. */
export interface LoopEntriesRead {
  stepRuns: readonly WorkflowStepRunView[] | undefined;
  failed: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore(): void;
  retry(): void;
}

/**
 * The step runs of the entries of one loop, filtered by the instance: by the loop's step run
 * and by state. A loop over thousands of entries is read a page at a time, and only when its
 * panel is open.
 */
export function useLoopEntries(input: {
  runId: string;
  containerStepRunId: string;
  status: WorkflowStepRunStatusFilter | undefined;
  /** The run is going: what is listed is read again at an interval. */
  following: boolean;
}): LoopEntriesRead {
  const { runs } = useWorkflowsSource();
  const keys = useWorkflowKeys();
  const query = useInfiniteQuery({
    queryKey: [
      ...keys.runs,
      "entries",
      input.runId,
      input.containerStepRunId,
      input.status ?? "all"
    ],
    queryFn: ({ pageParam, signal }) =>
      runsOf(runs).listEntryStepRuns(
        input.runId,
        {
          containerStepRunId: input.containerStepRunId,
          status: input.status,
          limit: ENTRY_STEP_RUNS_PAGE_SIZE,
          cursor: pageParam
        },
        signal
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    retry: retryUnlessGone,
    refetchInterval: input.following ? RUN_REFRESH_MS : false
  });
  return {
    stepRuns: query.data?.pages.flatMap((page) => page.items),
    failed: query.isError,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage().catch(() => undefined),
    retry: () => void query.refetch().catch(() => undefined)
  };
}

/** Why the instance did not start or cancel a run, as far as the page says it itself. */
export type WorkflowWriteRefusal = "refused" | "pending";

/** What a failed write means, where the page has a sentence of its own for it. */
export function workflowWriteRefusal(error: unknown): WorkflowWriteRefusal | undefined {
  if (error instanceof PendingApprovalError) {
    return "pending";
  }
  return error instanceof ApiError && error.status === 403 ? "refused" : undefined;
}

/** The two things a person does to a run from these screens. */
export interface WorkflowWrites {
  start(workflow: string, input: Readonly<Record<string, unknown>>): Promise<WorkflowRunView>;
  cancel(runId: string): Promise<WorkflowRunView>;
}

export function useWorkflowWrites(): WorkflowWrites {
  const { runs } = useWorkflowsSource();
  const queryClient = useQueryClient();
  const keys = useWorkflowKeys();
  return useMemo(() => {
    const changed = () => queryClient.invalidateQueries({ queryKey: keys.runs });
    return {
      start: async (workflow, input) => runsOf(runs).start(workflow, input).finally(changed),
      cancel: async (runId) => runsOf(runs).cancel(runId).finally(changed)
    };
  }, [keys, queryClient, runs]);
}

/**
 * The reader's own "Run live once" switches on the draft of one Workflow. A test run uses
 * them, so they are read again when the run the page shows has ended (`runEnded` is part of
 * the key). Nothing is read where `enabled` is false.
 */
export function useLiveOnceSwitches(
  workflow: string,
  enabled: boolean,
  runEnded: boolean
): readonly LiveOnceSwitchView[] | undefined {
  const { drafts } = useWorkflowsSource();
  const keys = useWorkflowKeys();
  const query = useQuery({
    queryKey: [...keys.liveOnce, workflow, runEnded],
    queryFn: ({ signal }) => drafts?.listLiveOnce(workflow, signal) ?? Promise.resolve([]),
    enabled: enabled && drafts !== undefined
  });
  return query.data;
}

/** What a person does to the draft of a Workflow from its page and from a test run. */
export interface WorkflowDraftWrites {
  publish(workflow: string, revision: number): Promise<void>;
  discard(workflow: string, expectedRevision: number): Promise<void>;
  test(workflow: string, input: Readonly<Record<string, unknown>>): Promise<WorkflowRunView>;
  runLiveOnce(workflow: string, step: string, expectedRevision: number): Promise<void>;
}

/**
 * The publish and the discard of a draft, where the source holds drafts. Each drops every
 * read of a Workflow, refused or not: a refusal may say that the draft is another one now.
 */
export function useWorkflowDraftWrites(): WorkflowDraftWrites | undefined {
  const { drafts } = useWorkflowsSource();
  const queryClient = useQueryClient();
  const keys = useWorkflowKeys();
  return useMemo(() => {
    if (drafts === undefined) {
      return undefined;
    }
    const changed = () => queryClient.invalidateQueries({ queryKey: keys.assets });
    const ran = () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.runs }),
        queryClient.invalidateQueries({ queryKey: keys.liveOnce })
      ]);
    return {
      publish: async (workflow, revision) => drafts.publish(workflow, revision).finally(changed),
      discard: async (workflow, expectedRevision) =>
        drafts.discard(workflow, expectedRevision).finally(changed),
      test: async (workflow, input) => drafts.test(workflow, input).finally(ran),
      runLiveOnce: async (workflow, step, expectedRevision) =>
        drafts
          .runLiveOnce(workflow, step, expectedRevision)
          .finally(() => queryClient.invalidateQueries({ queryKey: keys.liveOnce }))
    };
  }, [drafts, keys, queryClient]);
}
