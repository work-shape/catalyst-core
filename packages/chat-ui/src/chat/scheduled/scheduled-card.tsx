import { MoreHorizontal, Pause, Pencil, Play, Trash2 } from "lucide-react";
import { useId } from "react";
import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  FormNotice,
  type FormNoticeTone,
  IconButton,
  LoadError,
  Skeleton,
  Spinner
} from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { formatMomentShort, formatMomentShortZoned } from "../../shared/locale-format";
import type { WorkspaceRoute } from "../../shared/workspace-route";
import { RouteLink } from "../../studio/route-link";
import type { ScheduledRuns } from "./scheduled-data";
import {
  headingOf,
  runReasonKey,
  runState,
  scheduleLine,
  startNotice,
  type ScheduledRun,
  type ScheduledStart
} from "./scheduled-model";

/** What the card says where the person acted: under its buttons, until the next action. */
export interface ScheduledFeedback {
  tone: FormNoticeTone;
  text: TranslationKey;
}

/** The action of the card that is going: its button shows a spinner and the others wait. */
export type ScheduledBusy = "run" | "state" | undefined;

/**
 * One scheduled prompt: its heading from the prompt, the agent and the schedule, when it runs
 * next, what the owner must act on, its latest runs with their conversations, and its actions.
 */
export function ScheduledStartCard({
  start,
  agentLabel,
  runs,
  busy,
  feedback,
  connectionsRoute,
  onRunNow,
  onToggleState,
  onEdit,
  onDelete,
  onOpenRoute
}: {
  start: ScheduledStart;
  /** The agent as people know it. */
  agentLabel: string;
  runs: ScheduledRuns;
  busy: ScheduledBusy;
  feedback: ScheduledFeedback | undefined;
  /** Where the person connects their personal connections. Absent where they cannot open it. */
  connectionsRoute: WorkspaceRoute | undefined;
  onRunNow(): void;
  onToggleState(): void;
  onEdit(): void;
  onDelete(): void;
  onOpenRoute(route: WorkspaceRoute): void;
}) {
  const { locale, t } = useTranslation();
  const titleId = useId();
  const heading = headingOf(start.prompt);
  const paused = start.state === "paused";
  const notice = runs.runs === undefined ? undefined : startNotice(runs.runs);
  const conversation = (conversationId: string): WorkspaceRoute => ({
    kind: "conversation",
    collaborationWorkspaceId: start.collaborationWorkspaceId,
    conversationId
  });
  return (
    <Card
      padding="md"
      className="flex w-full min-w-0 flex-col"
      data-testid="scheduled-start"
      data-state={start.state}
      aria-labelledby={titleId}
      role="group"
    >
      <CardHeader>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <CardTitle id={titleId} clamp className="min-w-0">
            {heading}
          </CardTitle>
          {paused ? (
            <Badge tone="neutral" size="sm">
              {t("scheduled.paused")}
            </Badge>
          ) : null}
        </div>
        <p className="text-caption text-muted-foreground wrap-anywhere">
          {agentLabel} · {scheduleLine(start, { locale, t })}
        </p>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-3">
        {paused ? null : (
          <p className="text-caption text-muted-foreground" data-testid="scheduled-next">
            {t("scheduled.nextRun")}:{" "}
            {start.nextRunAt === null ? (
              t("scheduled.noNextRun")
            ) : (
              <time dateTime={start.nextRunAt} className="text-foreground">
                {formatMomentShortZoned(start.nextRunAt, locale)}
              </time>
            )}
          </p>
        )}
        {notice?.kind === "waiting" ? (
          <Banner
            tone="warning"
            data-testid="scheduled-waiting"
            action={
              notice.conversationId === null ? undefined : (
                <RouteLink
                  route={conversation(notice.conversationId)}
                  variant="link"
                  onOpen={onOpenRoute}
                >
                  {t("scheduled.openResult")}
                </RouteLink>
              )
            }
          >
            {t("scheduled.waitingNotice")}
          </Banner>
        ) : notice?.kind === "connection" ? (
          <Banner
            tone="warning"
            data-testid="scheduled-connection"
            action={
              connectionsRoute === undefined ? undefined : (
                <RouteLink route={connectionsRoute} variant="link" onOpen={onOpenRoute}>
                  {t("scheduled.openConnections")}
                </RouteLink>
              )
            }
          >
            {t(notice.message)}
          </Banner>
        ) : null}
        <section className="grid min-w-0 gap-1.5" aria-label={t("scheduled.recentRuns")}>
          <h3 className="text-label">{t("scheduled.recentRuns")}</h3>
          {runs.failed ? (
            <LoadError onRetry={runs.retry}>{t("scheduled.runsFailed")}</LoadError>
          ) : runs.runs === undefined ? (
            <Skeleton className="w-48" />
          ) : runs.runs.length === 0 ? (
            <p className="text-caption text-muted-foreground">{t("scheduled.noRuns")}</p>
          ) : (
            <ul className="grid min-w-0 gap-1.5" data-testid="scheduled-runs">
              {runs.runs.map((run) => (
                <RunLine
                  key={run.id}
                  run={run}
                  locale={locale}
                  conversation={
                    run.conversationId === null ? undefined : conversation(run.conversationId)
                  }
                  onOpenRoute={onOpenRoute}
                />
              ))}
            </ul>
          )}
        </section>
      </CardContent>
      <CardFooter className="flex-wrap">
        <Button
          variant="outline"
          aria-describedby={titleId}
          loading={busy === "run"}
          disabled={busy !== undefined}
          onClick={onRunNow}
        >
          <Play aria-hidden="true" />
          {t("scheduled.runNow")}
        </Button>
        <Button
          variant="outline"
          aria-describedby={titleId}
          loading={busy === "state"}
          disabled={busy !== undefined}
          onClick={onToggleState}
        >
          {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
          {t(paused ? "scheduled.resume" : "scheduled.pause")}
        </Button>
        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton size="sm" label={t("scheduled.actions")} aria-describedby={titleId}>
                <MoreHorizontal aria-hidden="true" />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem icon={<Pencil aria-hidden="true" />} onSelect={onEdit}>
                {t("scheduled.edit")}
              </DropdownMenuItem>
              <DropdownMenuItem
                icon={<Trash2 aria-hidden="true" />}
                tone="danger"
                onSelect={onDelete}
              >
                {t("scheduled.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {feedback ? (
          <FormNotice tone={feedback.tone} className="basis-full" data-testid="scheduled-feedback">
            {t(feedback.text)}
          </FormNotice>
        ) : null}
      </CardFooter>
    </Card>
  );
}

/** One run: when it was due, how it went, why where it did not start, and its conversation. */
function RunLine({
  run,
  locale,
  conversation,
  onOpenRoute
}: {
  run: ScheduledRun;
  locale: Parameters<typeof formatMomentShort>[1];
  conversation: WorkspaceRoute | undefined;
  onOpenRoute(route: WorkspaceRoute): void;
}) {
  const { t } = useTranslation();
  const state = runState(run.status);
  const reason = runReasonKey(run);
  return (
    <li
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption"
      data-testid="scheduled-run"
      data-status={run.status}
    >
      <time dateTime={run.scheduledFor} className="text-muted-foreground">
        {formatMomentShort(run.scheduledFor, locale)}
      </time>
      <Badge
        tone={state.tone}
        size="sm"
        {...(state.spins ? { leading: <Spinner size="sm" /> } : { dot: true })}
      >
        {t(state.label)}
      </Badge>
      {conversation ? (
        <RouteLink route={conversation} variant="link" onOpen={onOpenRoute}>
          {t("scheduled.openResult")}
        </RouteLink>
      ) : null}
      {reason ? <span className="basis-full text-muted-foreground">{t(reason)}</span> : null}
    </li>
  );
}
