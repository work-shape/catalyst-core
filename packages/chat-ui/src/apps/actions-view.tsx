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
import { appActionTestable, appActionUnavailableKeys } from "./app-actions-model";
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
      <ActionsPage>
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
  // The column of the test is there only where a row has one: no room is kept for nothing.
  const tests = read.actions.some((action) => appActionTestable(action, read.view, rights));
  return (
    <ActionsPage>
      <Table data-app-actions="ready">
        <TableHeader>
          <TableRow>
            <TableHead>{t("apps.actionName")}</TableHead>
            <TableHead>{t("apps.actionEffect")}</TableHead>
            <TableHead>{t("apps.actionCalls")}</TableHead>
            <TableHead>{t("apps.actionForYou")}</TableHead>
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
              {/* The cells keep a width a name fits in: a narrow surface scrolls the table. */}
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
              <TableCell className="min-w-44" data-unavailable={action.unavailable}>
                <AppActionTarget action={action} />
                <TableCellDetail>
                  {action.unavailable
                    ? t(appActionUnavailableKeys[action.unavailable])
                    : t("apps.actionKindConnection")}
                </TableCellDetail>
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <AppActionOutcomeBadge action={action} safeMode={read.view === "draft"} />
              </TableCell>
              {tests ? (
                <TableCell className="text-right">
                  {appActionTestable(action, read.view, rights) ? (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={t("apps.actionTestOf", { name: action.name })}
                      onClick={() => onTest(action)}
                    >
                      {t("apps.actionTest")}
                    </Button>
                  ) : null}
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ActionsPage>
  );
}

/** The Actions side scrolls on its own under the head of the draft. */
function ActionsPage({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <Page width="default">{children}</Page>
    </div>
  );
}
