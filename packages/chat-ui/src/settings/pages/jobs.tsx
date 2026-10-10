import { MoreHorizontal, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, type Job, type JobKindSummary, type JobStatus } from "@vivd-catalyst/api-client";
import {
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
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
import { useSettingsPage } from "../settings-page-context";

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
  const [tab, setTab] = useState<string>(jobTabs[0].id);
  const summary = summaryQuery.data;

  return (
    <>
      <PageHeader title={t("jobs.title")} description={t("jobs.description")} />
      <Section layout="stacked" title={t("jobs.byKind")}>
        {summaryQuery.error ? (
          <Banner tone="danger">{t("jobs.loadFailed")}</Banner>
        ) : summary ? (
          <JobSummaryTable summary={summary} />
        ) : (
          <SkeletonList rows={3} />
        )}
      </Section>
      <Section layout="stacked" title={t("jobs.list")}>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList label={t("jobs.tabs")}>
            {jobTabs.map((jobTab) => (
              <TabsTrigger
                key={jobTab.id}
                value={jobTab.id}
                count={summary ? countOf(summary, jobTab.statuses) : undefined}
              >
                {t(jobTab.labelKey)}
              </TabsTrigger>
            ))}
          </TabsList>
          {jobTabs.map((jobTab) => (
            <TabsContent key={jobTab.id} value={jobTab.id} className="pt-4">
              <JobList tab={jobTab} />
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

function JobSummaryTable({ summary }: { summary: readonly JobKindSummary[] }) {
  const { t, locale } = useTranslation();
  if (summary.length === 0) {
    return <EmptyState layout="inline">{t("jobs.summaryEmpty")}</EmptyState>;
  }
  const now = new Date();
  const count = (value: number) => value.toLocaleString(locale);
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
        {summary.map((kind) => (
          <TableRow key={kind.kind}>
            <TableCell className="font-mono">{kind.kind}</TableCell>
            <TableCell className="text-right tabular-nums">{count(kind.queued)}</TableCell>
            <TableCell className="text-right tabular-nums">{count(kind.running)}</TableCell>
            <TableCell className="text-right tabular-nums">{count(kind.failed)}</TableCell>
            <TableCell className="text-right tabular-nums">{count(kind.dead)}</TableCell>
            <TableCell className="text-right text-muted-foreground tabular-nums">
              {kind.waitingSince ? formatElapsed(kind.waitingSince, now, locale) : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function JobList({ tab }: { tab: JobTab }) {
  const { t, locale } = useTranslation();
  const { user } = useSettingsPage();
  const { client, scope } = useJobsApi();
  const queryClient = useQueryClient();
  const filter: JobListFilter = { statuses: tab.statuses };
  const jobsQuery = useInfiniteQuery({
    queryKey: [...scope, "list", filter],
    queryFn: ({ pageParam, signal }) =>
      client.instance.jobs.list({
        query: { status: filter.statuses.join(","), cursor: pageParam },
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
  const jobs = jobsQuery.data?.pages.flatMap((page) => page.items);

  if (jobsQuery.error) {
    return <Banner tone="danger">{t("jobs.loadFailed")}</Banner>;
  }
  if (!jobs) {
    return <SkeletonList />;
  }
  return (
    <div className="grid gap-4">
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
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {t("jobs.attemptsOf", {
                    attempts: job.attempts,
                    maxAttempts: job.maxAttempts
                  })}
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {formatDateTime(job.createdAt, locale)}
                </TableCell>
                <TableCell className="w-0 text-right">
                  {job.status === "failed" || job.status === "dead" ? (
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
