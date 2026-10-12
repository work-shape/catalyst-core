import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { OperationRunResource } from "@vivd-catalyst/api-client";
import {
  Banner,
  Button,
  Dialog,
  EmptyState,
  PageHeader,
  Section,
  SkeletonList
} from "@vivd-catalyst/ui";
import { useCollaborationWorkspacesQuery } from "../../api/workspace-queries";
import { useTranslation } from "../../i18n";
import {
  defaultOperationRunFilter,
  isOperationRunFilterDefault,
  isOperationRunFilterReadsOnly,
  operationRunFilterShowsReads,
  operationRunOfSearch,
  operationRunQuery,
  type OperationRunFilter
} from "../../operations/operations-model";
import {
  OperationRunDetail,
  OperationRunFilters,
  OperationRunsTable,
  type OperationRunWorkspace
} from "../../operations/operations-view";
import { workspaceRoutePath } from "../../routes";
import { useSettingsPage } from "../settings-page-context";

/** How often the page asks again while its browser tab is visible. */
const OPERATIONS_REFRESH_MS = 10_000;

/** How long typing in the operation filter rests before the list asks for that name. */
const OPERATION_NAME_FILTER_DELAY_MS = 300;

const noWorkspaces: readonly OperationRunWorkspace[] = [];

function useOperationRunsApi() {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const scope = ["instance-operation-runs", apiBaseUrl, authScope] as const;
  return { apiBaseUrl, authScope, client, scope };
}

/** Instance > Operations: every call of an operation, who made it and how it ended. */
export function OperationsPage() {
  const { t } = useTranslation();
  const { apiBaseUrl, authScope, client, scope } = useOperationRunsApi();
  const [filter, setFilter] = useState<OperationRunFilter>(defaultOperationRunFilter);
  // The name is asked for once typing rests; the selects apply at once.
  const appliedOperation = useRested(filter.operation, OPERATION_NAME_FILTER_DELAY_MS);
  const applied: OperationRunFilter = { ...filter, operation: appliedOperation };
  const query = operationRunQuery(applied);
  // The same list the shell holds: it names a workspace by its id and fills the filter.
  const workspaces =
    useCollaborationWorkspacesQuery({ apiBaseUrl, authScope, client, enabled: true }).data ??
    noWorkspaces;
  const runsQuery = useInfiniteQuery({
    queryKey: [...scope, "list", query],
    queryFn: ({ pageParam, signal }) =>
      client.operations.list_runs({ query: { ...query, cursor: pageParam }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: OPERATIONS_REFRESH_MS
  });
  // A link to one run, such as the one a test of an App's action gives, opens the page on it.
  const [open, setOpen] = useState<OpenRun | undefined>(() => {
    const id = operationRunOfSearch(window.location.search);
    return id === undefined ? undefined : { id };
  });
  const runs = runsQuery.data?.pages.flatMap((page) => page.items);
  // An empty list of reads says the same sentence as its empty text, so it is said once.
  const readsEmpty = runs?.length === 0 && isOperationRunFilterReadsOnly(applied);

  return (
    <>
      <PageHeader title={t("operations.title")} description={t("operations.description")} />
      <Section layout="stacked" title={t("operations.list")}>
        <div className="grid gap-4">
          <OperationRunFilters filter={filter} workspaces={workspaces} onChange={setFilter} />
          {operationRunFilterShowsReads(filter) && !readsEmpty ? (
            <p className="text-sm text-muted-foreground" data-operation-runs-reads-note>
              {t("operations.readsNote")}
            </p>
          ) : null}
          {/* A refresh that failed leaves the rows that were loaded and says so above them. */}
          {runsQuery.error ? (
            <Banner tone="danger">
              {t(runs ? "operations.refreshFailed" : "operations.loadFailed")}
            </Banner>
          ) : null}
          {!runs ? (
            runsQuery.error ? null : (
              <SkeletonList />
            )
          ) : runs.length === 0 ? (
            <EmptyState
              layout="inline"
              data-operation-runs-empty
              action={
                isOperationRunFilterDefault(applied) ? undefined : (
                  <Button variant="outline" onClick={() => setFilter(defaultOperationRunFilter)}>
                    {t("operations.clearFilters")}
                  </Button>
                )
              }
            >
              {t(
                readsEmpty
                  ? "operations.readsNote"
                  : isOperationRunFilterDefault(applied)
                    ? "operations.empty"
                    : "operations.emptyFiltered"
              )}
            </EmptyState>
          ) : (
            <OperationRunsTable
              runs={runs}
              workspaces={workspaces}
              onOpen={(row) => setOpen({ id: row.id, row })}
            />
          )}
          {runsQuery.hasNextPage ? (
            <Button
              variant="outline"
              className="justify-self-start"
              loading={runsQuery.isFetchingNextPage}
              onClick={() => {
                // A failed page shows through `runsQuery.error`, so there is nothing to catch here.
                runsQuery.fetchNextPage().catch(() => undefined);
              }}
            >
              {t("operations.showMore")}
            </Button>
          ) : null}
        </div>
      </Section>
      <OperationRunDialog
        run={open}
        workspaces={workspaces}
        onClose={() => {
          setOpen(undefined);
          // The address stops naming the run, so a reload shows the list.
          if (operationRunOfSearch(window.location.search) !== undefined) {
            window.history.replaceState(window.history.state, "", window.location.pathname);
          }
        }}
      />
    </>
  );
}

/** The run the dialog shows: named by its id, with what its row held where a row opened it. */
interface OpenRun {
  id: string;
  row?: OperationRunResource;
}

/**
 * One run in full. It opens with what the row held and keeps up with the run itself, so a call
 * that waits shows its decision once it has one, also after the row left the filtered list. A
 * run the address names is read by its id.
 */
function OperationRunDialog({
  run,
  workspaces,
  onClose
}: {
  run: OpenRun | undefined;
  workspaces: readonly OperationRunWorkspace[];
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { client, scope } = useOperationRunsApi();
  const runId = run?.id;
  const runQuery = useQuery({
    queryKey: [...scope, "run", runId],
    queryFn: ({ signal }) => client.operations.get_run({ params: { runId: runId ?? "" }, signal }),
    enabled: runId !== undefined,
    placeholderData: run?.row,
    refetchInterval: OPERATIONS_REFRESH_MS
  });
  const shown = runQuery.data ?? run?.row;

  return (
    <Dialog
      open={run !== undefined}
      size="lg"
      title={t("operations.detailTitle")}
      onClose={onClose}
    >
      {shown ? (
        <div className="grid gap-4">
          {runQuery.error ? (
            <Banner tone="danger">{t("operations.detailLoadFailed")}</Banner>
          ) : null}
          <OperationRunDetail
            run={shown}
            workspaces={workspaces}
            approvalRequestHref={
              shown.approvalRequestId
                ? workspaceRoutePath({ kind: "inbox-item", itemId: shown.approvalRequestId })
                : undefined
            }
          />
        </div>
      ) : runQuery.error ? (
        <Banner tone="danger">{t("operations.detailLoadFailed")}</Banner>
      ) : (
        <SkeletonList rows={6} />
      )}
    </Dialog>
  );
}

/** A value once it has stayed the same for `delayMs`. Clearing it applies at once. */
function useRested(value: string, delayMs: number): string {
  const [rested, setRested] = useState(value);
  useEffect(() => {
    const timeout = setTimeout(() => setRested(value), value === "" ? 0 : delayMs);
    return () => clearTimeout(timeout);
  }, [value, delayMs]);
  return rested;
}
