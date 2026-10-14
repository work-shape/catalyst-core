import { useState, type ReactNode } from "react";
import type { AppAction } from "@vivd-catalyst/api-client";
import {
  Button,
  EmptyState,
  Page,
  SkeletonList,
  Table,
  TableBody,
  TableCell,
  TableCellDetail,
  TableHead,
  TableHeader,
  TableRow
} from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import { ActionTestDialog } from "./action-test-dialog";
import { AppActionEffect, AppActionOutcomeBadge, AppActionTarget } from "./app-action-facts";
import {
  appActionTargetKeys,
  appActionTestable,
  appActionUnavailableKeys
} from "./app-actions-model";
import { useAppActions, type AppActionsRead } from "./app-data";
import type { AppRights } from "./app-model";

/**
 * The Actions side of a draft (layout 3): the named actions of the draft, and the test of a
 * reading one. The test is a real call from the draft, made as the builder.
 */
export function AppDraftActions({ app, rights }: { app: string; rights: AppRights }) {
  const read = useAppActions(app, true);
  const [tested, setTested] = useState<AppAction>();
  return (
    <>
      <AppActionsView read={read} rights={rights} onTest={setTested} />
      {tested ? (
        <ActionTestDialog app={app} action={tested} onClose={() => setTested(undefined)} />
      ) : null}
    </>
  );
}

/**
 * The named actions of one revision for given facts: one row per action with what it is, what
 * it reaches and what a call of it would come to for the reader. A row whose call cannot
 * reach its operation says why.
 */
export function AppActionsView({
  read,
  rights,
  onTest
}: {
  read: AppActionsRead;
  rights: Pick<AppRights, "write">;
  onTest(action: AppAction): void;
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
  const testable = (action: AppAction) => appActionTestable(action, read.view, rights);
  // The column of the test is there only where a row has one: no room is kept for nothing.
  const tests = read.actions.some(testable);
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
              {/* A row without a test gives its room to what a call would come to. */}
              <TableCell
                colSpan={tests && !testable(action) ? 2 : undefined}
                stacked={testable(action) ? undefined : "full"}
                className="whitespace-nowrap"
              >
                <AppActionOutcomeBadge action={action} safeMode={read.view === "draft"} />
              </TableCell>
              {testable(action) ? (
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
