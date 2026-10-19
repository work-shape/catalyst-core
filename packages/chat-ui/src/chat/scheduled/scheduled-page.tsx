import { CalendarClock, Clock, Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  FormNotice,
  LoadError,
  LoadMore,
  Page,
  PageHeader,
  SkeletonList,
  Starter,
  StarterList
} from "@work-shape/catalyst-ui";
import { WORKSPACE_AUTH_SCOPE } from "../workspace/workspace-chat-state";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { usePlatformContextQuery } from "../../shared/api/workspace-queries";
import { AreaFrame, useAreaTitleFocus } from "../../shared/area-frame";
import { useTranslation } from "../../shared/i18n";
import type { WorkspaceRoute } from "../../shared/workspace-route";
import { instanceTimeZoneOf } from "../../studio/workflows/workflow-model";
import { ScheduledStartCard, type ScheduledBusy, type ScheduledFeedback } from "./scheduled-card";
import {
  useScheduledList,
  useScheduledRuns,
  useScheduledWrites,
  type ScheduledList
} from "./scheduled-data";
import { ScheduledDialog, type ScheduledAgent, type ScheduledDraft } from "./scheduled-dialog";
import { headingOf, type ScheduledStart } from "./scheduled-model";

/** The zone a schedule runs in where the instance names none. */
const FALLBACK_TIME_ZONE = "UTC";

/** What the workspace shell gives the page. */
export interface ScheduledPageProps {
  workspaceId: string;
  /** The agents the open workspace offers: the only ones a scheduled prompt may ask. */
  agents: readonly ScheduledAgent[];
  defaultAgentName: string | undefined;
  /** Where the person connects their personal connections. Absent where they cannot open it. */
  connectionsRoute?: WorkspaceRoute;
  onOpenRoute(route: WorkspaceRoute): void;
}

/** The two examples an empty page offers, each opening the dialog with its prompt and time. */
const EXAMPLES = [
  {
    title: "scheduled.exampleTicketsTitle",
    prompt: "scheduled.exampleTicketsPrompt",
    cron: "0 8 * * 1-5"
  },
  {
    title: "scheduled.exampleWeeklyTitle",
    prompt: "scheduled.exampleWeeklyPrompt",
    cron: "0 9 * * 1"
  }
] as const;

/** The Scheduled page: the person's own scheduled prompts in the open workspace. */
export function ScheduledPage({
  workspaceId,
  agents,
  defaultAgentName,
  connectionsRoute,
  onOpenRoute
}: ScheduledPageProps) {
  const { t } = useTranslation();
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const list = useScheduledList(workspaceId);
  const writes = useScheduledWrites(workspaceId);
  const context = usePlatformContextQuery({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    enabled: true
  });
  const instanceTimeZone = instanceTimeZoneOf(context.data)?.timeZone ?? FALLBACK_TIME_ZONE;
  const [draft, setDraft] = useState<ScheduledDraft>();
  const [deleting, setDeleting] = useState<ScheduledStart>();
  const agentLabel = (name: string) =>
    agents.find((agent) => agent.name === name)?.displayName ?? name;

  function openDraft(next: ScheduledDraft) {
    writes.save.reset();
    setDraft(next);
  }

  return (
    <>
      <ScheduledPageView
        list={list}
        onNew={(start) => openDraft(start ?? { prompt: "" })}
        renderStart={(start) => (
          <ScheduledStartItem
            start={start}
            agentLabel={agentLabel(start.agentName)}
            workspaceId={workspaceId}
            connectionsRoute={connectionsRoute}
            onEdit={() =>
              openDraft({
                scheduledStartId: start.id,
                agentName: start.agentName,
                prompt: start.prompt,
                cron: start.cron,
                timeZone: start.timeZone
              })
            }
            onDelete={() => {
              writes.remove.reset();
              setDeleting(start);
            }}
            onOpenRoute={onOpenRoute}
          />
        )}
      />
      {draft ? (
        <ScheduledDialog
          draft={draft}
          agents={agents}
          defaultAgentName={defaultAgentName}
          instanceTimeZone={instanceTimeZone}
          saving={writes.save.isPending}
          failed={writes.save.isError}
          onSave={(values) =>
            writes.save.mutate(
              {
                ...(draft.scheduledStartId === undefined
                  ? {}
                  : { scheduledStartId: draft.scheduledStartId }),
                values
              },
              { onSuccess: () => setDraft(undefined) }
            )
          }
          onClose={() => setDraft(undefined)}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== undefined}
        title={t("scheduled.deleteTitle")}
        confirmLabel={t("scheduled.delete")}
        loading={writes.remove.isPending}
        onConfirm={() => {
          if (deleting) {
            writes.remove.mutate(deleting.id, { onSuccess: () => setDeleting(undefined) });
          }
        }}
        onClose={() => setDeleting(undefined)}
      >
        <DeleteBody
          heading={deleting === undefined ? "" : headingOf(deleting.prompt)}
          failed={writes.remove.isError}
        />
      </ConfirmDialog>
    </>
  );
}

function DeleteBody({ heading, failed }: { heading: string; failed: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3">
      <p>{t("scheduled.deleteBody", { heading })}</p>
      {failed ? <FormNotice tone="error">{t("scheduled.deleteFailed")}</FormNotice> : null}
    </div>
  );
}

/**
 * The page as it stands for a list: its head with the one New button, the list or what stands
 * in its place while it loads, when it failed and when it is empty.
 */
export function ScheduledPageView({
  list,
  onNew,
  renderStart
}: {
  list: ScheduledList;
  /** Opens the dialog, empty or with an example's prompt and schedule. */
  onNew(example?: ScheduledDraft): void;
  renderStart(start: ScheduledStart): ReactNode;
}) {
  const { t } = useTranslation();
  const rows = list.rows;
  const areaRef = useAreaTitleFocus(true);
  // A page may come back empty with more to read: the list is empty only once read to its end.
  const listedNone = rows?.length === 0 && !list.hasMore;
  return (
    <AreaFrame ref={areaRef} label={t("scheduled.title")}>
      <Page>
        <PageHeader
          title={t("scheduled.title")}
          description={t("scheduled.description")}
          // The empty page offers New with its examples, so the head drops it there.
          primaryAction={
            listedNone ? undefined : (
              <Button onClick={() => onNew()}>
                <Plus aria-hidden="true" />
                {t("scheduled.new")}
              </Button>
            )
          }
        />
        <div className="grid min-w-0 gap-4" data-testid="scheduled-area">
          {list.failed ? (
            <LoadError onRetry={list.retry}>{t("scheduled.listFailed")}</LoadError>
          ) : null}
          {rows === undefined ? (
            list.failed ? null : (
              <SkeletonList rows={3} />
            )
          ) : listedNone ? (
            <EmptyState
              icon={<Clock aria-hidden="true" />}
              action={<Button onClick={() => onNew()}>{t("scheduled.new")}</Button>}
              presets={
                <StarterList label={t("scheduled.examples")}>
                  {EXAMPLES.map((example) => (
                    <Starter
                      key={example.title}
                      icon={
                        <CalendarClock
                          aria-hidden="true"
                          className="size-5 text-muted-foreground"
                        />
                      }
                      title={t(example.title)}
                      hint={t(example.prompt)}
                      onClick={() => onNew({ prompt: t(example.prompt), cron: example.cron })}
                    />
                  ))}
                </StarterList>
              }
            >
              {t("scheduled.empty")}
            </EmptyState>
          ) : (
            <ul aria-label={t("scheduled.title")} className="grid grid-cols-1 gap-4">
              {rows.map((start) => (
                <li key={start.id} className="flex min-w-0">
                  {renderStart(start)}
                </li>
              ))}
            </ul>
          )}
          {list.hasMore ? (
            <LoadMore
              loading={list.loadingMore}
              onLoad={list.loadMore}
              label={t("scheduled.showMore")}
            />
          ) : null}
        </div>
      </Page>
    </AreaFrame>
  );
}

/** One scheduled prompt with its runs and its own actions and feedback. */
function ScheduledStartItem({
  start,
  agentLabel,
  workspaceId,
  connectionsRoute,
  onEdit,
  onDelete,
  onOpenRoute
}: {
  start: ScheduledStart;
  agentLabel: string;
  workspaceId: string;
  connectionsRoute: WorkspaceRoute | undefined;
  onEdit(): void;
  onDelete(): void;
  onOpenRoute(route: WorkspaceRoute): void;
}) {
  const writes = useScheduledWrites(workspaceId);
  // After Run now the runs are read again until a newer run than this one shows.
  const [awaitingAfter, setAwaitingAfter] = useState<string | null>();
  const runs = useScheduledRuns(start.id, awaitingAfter);
  const [feedback, setFeedback] = useState<ScheduledFeedback>();
  const newest = runs.runs?.[0]?.id ?? null;
  if (awaitingAfter !== undefined && newest !== awaitingAfter) {
    setAwaitingAfter(undefined);
  }
  const busy: ScheduledBusy = writes.runNow.isPending
    ? "run"
    : writes.setState.isPending
      ? "state"
      : undefined;
  return (
    <ScheduledStartCard
      start={start}
      agentLabel={agentLabel}
      runs={runs}
      busy={busy}
      feedback={feedback}
      connectionsRoute={connectionsRoute}
      onRunNow={() => {
        setFeedback(undefined);
        writes.runNow.mutate(start.id, {
          onSuccess: () => {
            setAwaitingAfter(newest);
            setFeedback({ tone: "success", text: "scheduled.runStarted" });
          },
          onError: () => setFeedback({ tone: "error", text: "scheduled.runFailed" })
        });
      }}
      onToggleState={() => {
        setFeedback(undefined);
        const state = start.state === "active" ? "paused" : "active";
        writes.setState.mutate(
          { scheduledStartId: start.id, state },
          {
            onSuccess: () =>
              setFeedback({
                tone: "success",
                text: state === "paused" ? "scheduled.pausedNotice" : "scheduled.resumedNotice"
              }),
            onError: () => setFeedback({ tone: "error", text: "scheduled.stateFailed" })
          }
        );
      }}
      onEdit={onEdit}
      onDelete={onDelete}
      onOpenRoute={onOpenRoute}
    />
  );
}
