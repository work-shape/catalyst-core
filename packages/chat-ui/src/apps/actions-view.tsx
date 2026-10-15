import { useState, type ReactNode } from "react";
import type { AppAction } from "@work-shape/catalyst-api-client";
import {
  Button,
  EmptyState,
  InlineError,
  Page,
  RunLiveOnce,
  SkeletonList,
  Table,
  TableBody,
  TableCell,
  TableCellDetail,
  TableHead,
  TableHeader,
  TableRow,
  TargetBadge
} from "@work-shape/catalyst-ui";
import { instanceSentence } from "../build-area/build-refusals";
import { useTranslation } from "../i18n";
import { apiErrorCode } from "../workspace-utils";
import { ActionTestDialog } from "./action-test-dialog";
import { AppActionEffect, AppActionOutcomeBadge, AppActionTarget } from "./app-action-facts";
import {
  appActionLiveOnceOffered,
  appActionTargetKeys,
  appActionTestable,
  appActionUnavailableKeys
} from "./app-actions-model";
import {
  useAppActions,
  useAppActionsReload,
  type AppActionsRead,
  type AppWrites
} from "./app-data";
import type { AppRights } from "./app-model";

/**
 * The Actions side of a draft (layout 3): the named actions of the draft, the test of each,
 * and "Run live once" for a changing one. The test is a real call from the draft, made as the
 * builder; a changing action is simulated there unless the builder switched it live once.
 */
export function AppDraftActions({
  app,
  rights,
  writes
}: {
  app: string;
  rights: AppRights;
  writes: Pick<AppWrites, "runLiveOnce">;
}) {
  const { t } = useTranslation();
  const read = useAppActions(app, true);
  const reload = useAppActionsReload(app);
  const [tested, setTested] = useState<AppAction>();
  const [switching, setSwitching] = useState<string>();
  const [failed, setFailed] = useState<{ action: string; message: string }>();
  const switchOn = (action: AppAction) => {
    if (read.status !== "ready") {
      return;
    }
    setSwitching(action.name);
    setFailed(undefined);
    writes
      .runLiveOnce(app, action.name, read.revision)
      .catch((caught: unknown) =>
        setFailed({
          action: action.name,
          message:
            apiErrorCode(caught) === "REVISION_CONFLICT"
              ? t("apps.liveOnceStale")
              : (instanceSentence(caught) ?? t("apps.liveOnceFailed"))
        })
      )
      .finally(() => setSwitching(undefined));
  };
  return (
    <>
      <AppActionsView
        read={read}
        rights={rights}
        onTest={setTested}
        liveOnce={{ switching, failed, switchOn }}
      />
      {tested ? (
        <ActionTestDialog
          app={app}
          action={tested}
          onTested={reload}
          onClose={() => setTested(undefined)}
        />
      ) : null}
    </>
  );
}

/** "Run live once" on the rows of a draft: which one is being switched, and which failed. */
export interface AppActionsLiveOnce {
  switching: string | undefined;
  failed: { action: string; message: string } | undefined;
  switchOn(action: AppAction): void;
}

/**
 * The named actions of one revision for given facts: one row per action with what it is, what
 * it reaches and what a call of it would come to for the reader. A row whose call cannot
 * reach its operation says why.
 */
export function AppActionsView({
  read,
  rights,
  onTest,
  liveOnce
}: {
  read: AppActionsRead;
  rights: Pick<AppRights, "write">;
  onTest(action: AppAction): void;
  /** Left out where the rows offer no switch. */
  liveOnce?: AppActionsLiveOnce;
}) {
  const { t } = useTranslation();
  if (read.status === "loading") {
    return (
      <ActionsPage intro>
        <SkeletonList rows={3} />
      </ActionsPage>
    );
  }
  if (read.status === "failed") {
    return (
      <ActionsPage>
        <EmptyState
          layout="inline"
          data-app-actions="failed"
          action={
            <Button variant="outline" size="sm" onClick={read.retry}>
              {t("tryAgain")}
            </Button>
          }
        >
          {t("apps.actionsFailed")}
        </EmptyState>
      </ActionsPage>
    );
  }
  if (read.actions.length === 0) {
    return (
      <ActionsPage>
        <EmptyState layout="inline" data-app-actions="empty">
          {t("apps.actionsEmpty")}
        </EmptyState>
      </ActionsPage>
    );
  }
  // The column of the test is there only where the rows have one: no room is kept for nothing.
  const tests = appActionTestable(read.view, rights);
  return (
    <ActionsPage intro>
      {/* Too narrow for the columns, each action is a block with its test in reach. */}
      <Table narrow="stack" data-app-actions="ready">
        <TableHeader>
          <TableRow>
            <TableHead>{t("apps.actionName")}</TableHead>
            <TableHead>{t("apps.actionEffect")}</TableHead>
            <TableHead>{t("apps.actionCalls")}</TableHead>
            <TableHead>{t("apps.actionInDraft")}</TableHead>
            {tests ? (
              <TableHead>
                <span className="sr-only">{t("apps.actionTest")}</span>
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {read.actions.map((action) => (
            <TableRow key={action.name} data-app-action={action.name}>
              <TableCell className="min-w-44">
                <code className="font-mono text-code wrap-anywhere">{action.name}</code>
                {action.description ? (
                  <TableCellDetail className="line-clamp-2 whitespace-pre-line">
                    {action.description}
                  </TableCellDetail>
                ) : null}
              </TableCell>
              <TableCell>
                <AppActionEffect effect={action.effect} />
              </TableCell>
              <TableCell stacked="full" className="min-w-44" data-unavailable={action.unavailable}>
                <AppActionTarget action={action} />
                <TableCellDetail>
                  {action.unavailable
                    ? t(appActionUnavailableKeys[action.unavailable])
                    : t(appActionTargetKeys[action.kind])}
                </TableCellDetail>
              </TableCell>
              <TableCell stacked={tests ? undefined : "full"}>
                <div className="flex flex-wrap items-center gap-1.5 whitespace-nowrap">
                  {action.target ? <TargetBadge target={action.target} /> : null}
                  <AppActionOutcomeBadge action={action} safeMode={read.view === "draft"} />
                </div>
                {liveOnce && appActionLiveOnceOffered(action, read.view, rights) ? (
                  <div className="mt-2 grid grid-cols-1 gap-1">
                    <RunLiveOnce
                      state={
                        action.target === "live"
                          ? "on"
                          : liveOnce.switching === action.name
                            ? "busy"
                            : "off"
                      }
                      label={t("apps.liveOnceOf", { name: action.name })}
                      onText={t("apps.liveOnceOn")}
                      onSwitchOn={() => liveOnce.switchOn(action)}
                    />
                    {liveOnce.failed?.action === action.name ? (
                      <InlineError>{liveOnce.failed.message}</InlineError>
                    ) : null}
                  </div>
                ) : null}
              </TableCell>
              {tests ? (
                <TableCell className="text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={t("apps.actionTestOf", { name: action.name })}
                    onClick={() => onTest(action)}
                  >
                    {t("apps.actionTest")}
                  </Button>
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ActionsPage>
  );
}

/**
 * The Actions side scrolls on its own under the head of the draft. `intro` says in one line
 * what the list is, over the list and over the room it loads into.
 */
function ActionsPage({ intro = false, children }: { intro?: boolean; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <Page width="default">
        {intro ? (
          <p
            className="mb-4 max-w-prose px-3 text-body text-muted-foreground"
            data-app-actions-intro
          >
            {t("apps.actionsIntro")}
          </p>
        ) : null}
        {children}
      </Page>
    </div>
  );
}
