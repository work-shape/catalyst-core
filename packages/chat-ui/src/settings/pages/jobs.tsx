import { MoreHorizontal, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, type Job, type JobKindSummary, type JobStatus } from "@vivd-catalyst/api-client";
import {
  Badge,
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  FilterBar,
  IconButton,
  PageHeader,
  Section,
  SkeletonList,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type BadgeTone
} from "@vivd-catalyst/ui";
import { formatDateTime, formatElapsed } from "../../control-plane/locale-format";
import { useTranslation, type TranslationKey } from "../../i18n";
import { useModuleName } from "../../module-texts";
import { useSettingsPage } from "../settings-page-context";

// A worker polls once a second, so a due job is taken within seconds while a process that
// serves its kind is up and has a free slot. After this long with none of the kind running,
// the page says that nothing takes the kind.
const NOT_TAKEN_AFTER_MS = 60 * 1000;

/**
 * True when jobs of the kind have been due for a while and none is running: no process that
 * executes the kind is up. For `agent_run.execute` that is the missing Agent Run worker.
 */
function isNotBeingTaken(row: JobKindSummary, now: Date): boolean {
  if (row.running > 0 || !row.waitingSince) return false;
  return now.getTime() - new Date(row.waitingSince).getTime() >= NOT_TAKEN_AFTER_MS;
}

/** How often the page asks again while its browser tab is visible. */
const JOBS_REFRESH_MS = 10_000;

/** The tabs of the list: which statuses each shows and what it says when it is empty. */
const jobTabs = [
  {
    id: "attention",
    statuses: ["failed", "dead"],
    labelKey: "jobs.tabFailedAndDead",
    emptyKey: "jobs.emptyFailedAndDead"
  },
  {
    id: "running",
    statuses: ["running"],
    labelKey: "jobs.statusRunning",
    emptyKey: "jobs.emptyRunning"
  },
  {
    id: "queued",
    statuses: ["queued"],
    labelKey: "jobs.statusQueued",
    emptyKey: "jobs.emptyQueued"
  }
] as const satisfies readonly {
  id: string;
  statuses: readonly JobStatus[];
  labelKey: TranslationKey;
  emptyKey: TranslationKey;
}[];
type JobTab = (typeof jobTabs)[number];

const statusLabelKeys: Record<JobStatus, TranslationKey> = {
  queued: "jobs.statusQueued",
  running: "jobs.statusRunning",
  succeeded: "jobs.statusSucceeded",
  failed: "jobs.statusFailed",
  dead: "jobs.statusDead",
  cancelled: "jobs.statusCancelled"
};
const statusTones: Record<JobStatus, BadgeTone> = {
  queued: "neutral",
  running: "info",
  succeeded: "success",
  failed: "warning",
  dead: "danger",
  cancelled: "neutral"
};

/**
 * The filters of one list of jobs. A later filter, such as the subject, is one more field
 * here and in the query of `instance.jobs.list`.
 */
interface JobListFilter {
  statuses: readonly JobStatus[];
  kind?: string;
}

function useJobsApi() {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const scope = ["instance-jobs", apiBaseUrl, authScope] as const;
  return { client, scope };
}

/** Instance > Jobs: what the background is doing, and the retry of a job that died. */
export function JobsPage() {
  const { t } = useTranslation();
  const { client, scope } = useJobsApi();
  const summaryQuery = useQuery({
    queryKey: [...scope, "summary"],
    queryFn: async () => (await client.instance.jobs.summary()).items,
    refetchInterval: JOBS_REFRESH_MS
  });
  // The page opens on what needs a person: the jobs that failed.
  const [tab, setTab] = useState<string>(jobTabs[0].id);
  const [kind, setKind] = useState<string>();
  const summary = summaryQuery.data;
  const counted = summary?.filter((row) => kind === undefined || row.kind === kind);

  return (
    <>
      <PageHeader title={t("jobs.title")} description={t("jobs.description")} />
      <Section layout="stacked" title={t("jobs.byKind")}>
        <div className="grid gap-4">
          {summaryQuery.error ? (
            <Banner tone="danger">{t(summary ? "jobs.refreshFailed" : "jobs.loadFailed")}</Banner>
          ) : null}
          {summary ? (
            <JobSummaryTable summary={summary} selectedKind={kind} onSelectKind={setKind} />
          ) : summaryQuery.error ? null : (
            <SkeletonList rows={3} />
          )}
        </div>
      </Section>
      <Section layout="stacked" title={t("jobs.list")}>
        {kind === undefined ? null : (
          <FilterBar
            className="mb-3"
            filters={
              <Chip onRemove={() => setKind(undefined)}>{t("jobs.kindFilter", { kind })}</Chip>
            }
          />
        )}
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList label={t("jobs.tabs")}>
            {jobTabs.map((jobTab) => (
              <TabsTrigger
                key={jobTab.id}
                value={jobTab.id}
                count={counted ? countOf(counted, jobTab.statuses) : undefined}
              >
                {t(jobTab.labelKey)}
              </TabsTrigger>
            ))}
          </TabsList>
          {jobTabs.map((jobTab) => (
            <TabsContent key={jobTab.id} value={jobTab.id} className="pt-4">
              <JobList tab={jobTab} kind={kind} />
            </TabsContent>
          ))}
        </Tabs>
      </Section>
    </>
  );
}

function countOf(summary: readonly JobKindSummary[], statuses: JobTab["statuses"]): number {
  return summary.reduce(
    (sum, kind) => sum + statuses.reduce((ofKind, status) => ofKind + kind[status], 0),
    0
  );
}

/** Kinds with failed or dead jobs first, then by name. */
function failuresFirst(summary: readonly JobKindSummary[]): JobKindSummary[] {
  const needsAttention = (row: JobKindSummary) => (row.failed + row.dead > 0 ? 0 : 1);
  return [...summary].sort(
    (a, b) => needsAttention(a) - needsAttention(b) || a.kind.localeCompare(b.kind)
  );
}

function JobSummaryTable({
  summary,
  selectedKind,
  onSelectKind
}: {
  summary: readonly JobKindSummary[];
  selectedKind: string | undefined;
  onSelectKind(kind: string | undefined): void;
}) {
  const { t, locale } = useTranslation();
  if (summary.length === 0) {
    return <EmptyState layout="inline">{t("jobs.summaryEmpty")}</EmptyState>;
  }
  const now = new Date();
  /** A zero steps back, so the eye lands on what is there. */
  const count = (value: number, tone?: BadgeTone) =>
    value === 0 ? (
      <span className="text-muted-foreground">0</span>
    ) : tone ? (
      <Badge tone={tone}>{value.toLocaleString(locale)}</Badge>
    ) : (
      value.toLocaleString(locale)
    );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("jobs.kind")}</TableHead>
          <TableHead className="text-right">{t("jobs.statusQueued")}</TableHead>
          <TableHead className="text-right">{t("jobs.statusRunning")}</TableHead>
          <TableHead className="text-right">{t("jobs.statusFailed")}</TableHead>
          <TableHead className="text-right">{t("jobs.statusDead")}</TableHead>
          <TableHead className="text-right">{t("jobs.waitingFor")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {failuresFirst(summary).map((row) => {
          const selected = row.kind === selectedKind;
          return (
            <TableRow key={row.kind} data-job-kind={row.kind}>
              <TableCell>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto px-0 font-mono text-foreground"
                  aria-pressed={selected}
                  aria-label={t("jobs.showKind", { kind: row.kind })}
                  onClick={() => onSelectKind(selected ? undefined : row.kind)}
                >
                  {row.kind}
                </Button>
              </TableCell>
              <TableCell className="text-right tabular-nums">{count(row.queued)}</TableCell>
              <TableCell className="text-right tabular-nums">{count(row.running)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {count(row.failed, "warning")}
              </TableCell>
              <TableCell className="text-right tabular-nums">{count(row.dead, "danger")}</TableCell>
              <TableCell className="text-right text-muted-foreground tabular-nums">
                {isNotBeingTaken(row, now) ? (
                  <Badge tone="warning" className="mr-2" data-job-not-taken>
                    {t("jobs.notTaken")}
                  </Badge>
                ) : null}
                {row.waitingSince ? formatElapsed(row.waitingSince, now, locale) : "—"}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function JobList({ tab, kind }: { tab: JobTab; kind: string | undefined }) {
  const { t, locale } = useTranslation();
  const { user } = useSettingsPage();
  const { client, scope } = useJobsApi();
  const queryClient = useQueryClient();
  const filter: JobListFilter = { statuses: tab.statuses, kind };
  const jobsQuery = useInfiniteQuery({
    queryKey: [...scope, "list", filter],
    queryFn: ({ pageParam, signal }) =>
      client.instance.jobs.list({
        query: { status: filter.statuses.join(","), kind: filter.kind, cursor: pageParam },
        signal
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: JOBS_REFRESH_MS
  });
  const [confirming, setConfirming] = useState<Job>();
  const retry = useMutation({
    mutationFn: (job: Job) => client.instance.jobs.retry({ params: { jobId: job.id } }),
    // Whatever the answer, the job is no longer what the row says.
    onSettled: () => queryClient.invalidateQueries({ queryKey: scope })
  });
  const canRetry = user.roles.includes("superadmin");
  const moduleName = useModuleName();
  const jobs = jobsQuery.data?.pages.flatMap((page) => page.items);

  if (!jobs) {
    return jobsQuery.error ? (
      <Banner tone="danger">{t("jobs.loadFailed")}</Banner>
    ) : (
      <SkeletonList />
    );
  }
  return (
    <div className="grid gap-4">
      {/* A refresh that failed leaves the rows that were loaded and says so above them. */}
      {jobsQuery.error ? <Banner tone="danger">{t("jobs.refreshFailed")}</Banner> : null}
      {retry.error ? (
        <Banner tone="danger">
          {t(
            retry.error instanceof ApiError && retry.error.code === "CONFLICT"
              ? "jobs.retryConflict"
              : "jobs.retryFailed"
          )}
        </Banner>
      ) : null}
      {jobs.length === 0 ? (
        <EmptyState layout="inline">{t(tab.emptyKey)}</EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("jobs.kind")}</TableHead>
              <TableHead>{t("jobs.status")}</TableHead>
              <TableHead>{t("jobs.attempts")}</TableHead>
              <TableHead>{t("jobs.created")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((job) => (
              <TableRow key={job.id} data-job-id={job.id}>
                <TableCell className="font-mono wrap-anywhere">
                  {job.kind}
                  {job.subject ? (
                    <JobDetail label={t("jobs.subject")}>{job.subject}</JobDetail>
                  ) : null}
                </TableCell>
                <TableCell>
                  <Badge tone={statusTones[job.status]} dot>
                    {t(statusLabelKeys[job.status])}
                  </Badge>
                  {job.errorCode ? (
                    <JobDetail label={t("jobs.errorClass")}>{job.errorCode}</JobDetail>
                  ) : null}
                  {job.waitingForModule ? (
                    <div
                      className="mt-1 text-caption text-muted-foreground"
                      data-waiting-for-module
                    >
                      {t("jobs.waitingForModule", { module: moduleName(job.waitingForModule) })}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {t("jobs.attemptsOf", {
                    attempts: job.attempts,
                    maxAttempts: job.maxAttempts
                  })}
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {formatDateTime(job.createdAt, locale)}
                  {job.finishedAt ? (
                    <div className="mt-1 text-caption">
                      {t("jobs.ended", { time: formatDateTime(job.finishedAt, locale) })}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className="w-0 text-right">
                  {job.retryable ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IconButton size="sm" label={t("jobs.actions", { id: job.id })}>
                          <MoreHorizontal aria-hidden="true" />
                        </IconButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          icon={<RotateCcw aria-hidden="true" />}
                          disabledReason={canRetry ? undefined : t("jobs.retrySuperadminOnly")}
                          onSelect={() => setConfirming(job)}
                        >
                          {t("jobs.retry")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {jobsQuery.hasNextPage ? (
        <Button
          variant="outline"
          className="justify-self-start"
          loading={jobsQuery.isFetchingNextPage}
          onClick={() => {
            // A failed page shows through `jobsQuery.error`, so there is nothing to catch here.
            jobsQuery.fetchNextPage().catch(() => undefined);
          }}
        >
          {t("jobs.showMore")}
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirming !== undefined}
        tone="primary"
        title={t("jobs.retryDialogTitle")}
        confirmLabel={t("jobs.retry")}
        loading={retry.isPending}
        onConfirm={() => {
          if (confirming) {
            retry.mutate(confirming, { onSettled: () => setConfirming(undefined) });
          }
        }}
        onClose={() => setConfirming(undefined)}
      >
        {t("jobs.retryDialogDescription", { kind: confirming?.kind ?? "" })}
      </ConfirmDialog>
    </div>
  );
}

/** A second line of a cell: the label is for screen readers, the value is what the row shows. */
function JobDetail({ label, children }: { label: string; children: string }) {
  return (
    <div className="mt-1 font-mono text-caption text-muted-foreground">
      <span className="sr-only">{label}: </span>
      {children}
    </div>
  );
}
