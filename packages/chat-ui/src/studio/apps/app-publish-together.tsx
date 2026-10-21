import {
  Badge,
  Button,
  InlineError,
  KeyValue,
  KeyValueList,
  Skeleton
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { RunStateBadge } from "../workflows/workflows-frame";
import type { AppPublishTogetherRead, AppPublishTogetherWorkflow } from "./app-data";

// "Published with it" in an App's Publish question (DP-3): the Workflows with changes their
// live revision does not have, which the one Publish makes live with the App, children first,
// or none of them. Each says whether it is new, who changed it last, how its last test run
// ended, and what would refuse its publish now.

/** The Workflows the publish names: each with the revision the person was shown. */
export function appPublishTogetherNamed(
  read: AppPublishTogetherRead
): { name: string; revision: number }[] {
  return read.workflows.map(({ name, draftRevision }) => ({ name, revision: draftRevision }));
}

/** Whether the question may be sent: the Workflows are read and none would be refused. */
export function appPublishTogetherReady(read: AppPublishTogetherRead): boolean {
  return (
    read.status === "ready" && read.workflows.every((workflow) => workflow.refusals.length === 0)
  );
}

/** The line of the question; nothing where the publish makes no Workflow live with the App. */
export function AppPublishTogetherView({ read }: { read: AppPublishTogetherRead }) {
  if (read.status === "ready" && read.workflows.length === 0) return null;
  return (
    <KeyValueList>
      <TogetherLine read={read} />
    </KeyValueList>
  );
}

function TogetherLine({ read }: { read: AppPublishTogetherRead }) {
  const { t } = useTranslation();
  return (
    <KeyValue label={t("apps.publishTogether")} data-field="published-with">
      {read.status === "loading" ? (
        <Skeleton className="h-5 w-40" />
      ) : read.status === "failed" ? (
        <span className="flex flex-wrap items-center gap-2">
          <InlineError>{t("apps.publishTogetherFailed")}</InlineError>
          <Button variant="outline" size="sm" onClick={read.retry}>
            {t("tryAgain")}
          </Button>
        </span>
      ) : (
        <ul className="grid gap-2" data-testid="app-publish-together">
          {read.workflows.map((workflow) => (
            <TogetherItem key={workflow.name} workflow={workflow} />
          ))}
        </ul>
      )}
    </KeyValue>
  );
}

function TogetherItem({ workflow }: { workflow: AppPublishTogetherWorkflow }) {
  const { t } = useTranslation();
  const isNew = workflow.publishedRevision === undefined;
  return (
    <li className="grid min-w-0 gap-1" data-workflow={workflow.name}>
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="wrap-anywhere">
          {t("apps.publishTogetherWorkflow", { title: workflow.title })}
        </span>
        <Badge tone={isNew ? "accent" : "neutral"} size="sm">
          {t(isNew ? "apps.publishTogetherNew" : "apps.publishTogetherChanged")}
        </Badge>
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-2 text-caption text-muted-foreground">
        {workflow.lastChangedBy ? (
          <span>{t("apps.publishTogetherChangedBy", { name: workflow.lastChangedBy })}</span>
        ) : null}
        {workflow.lastTestRun ? (
          <span className="flex items-center gap-1.5">
            {t("apps.publishTogetherLastTest")}
            <RunStateBadge status={workflow.lastTestRun.status} />
          </span>
        ) : (
          <span>{t("apps.publishTogetherNotTested")}</span>
        )}
      </span>
      {workflow.refusals.map((refusal) => (
        <InlineError key={`${refusal.reason}:${refusal.message}`}>{refusal.message}</InlineError>
      ))}
    </li>
  );
}
