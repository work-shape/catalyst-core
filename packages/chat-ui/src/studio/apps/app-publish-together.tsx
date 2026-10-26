import {
  Badge,
  Button,
  InlineError,
  KeyValue,
  KeyValueList,
  Skeleton
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { tellRefusal } from "../../shared/i18n/refusals";
import { RunStateBadge } from "../workflows/workflows-frame";
import type {
  AppPublishNamed,
  AppPublishTogetherRead,
  AppPublishTogetherStore,
  AppPublishTogetherWorkflow
} from "./app-data";

// "Published with it" in an App's Publish question (DP-3, GOLIVE-1): the Workflows with
// changes their live revision does not have, children first, and then the Data Stores whose
// draft is not published, which the one Publish makes live with the App. Each Workflow says
// whether it is new, who changed it last and how its last test run ended; each store how many
// changes to its tables it applies. Both say what would refuse their publish now.

/** The stores and Workflows the publish names: each with the revision the person was shown. */
export function appPublishTogetherNamed(read: AppPublishTogetherRead): AppPublishNamed {
  const named = ({ name, draftRevision }: { name: string; draftRevision: number }) => ({
    name,
    revision: draftRevision
  });
  return { workflows: read.workflows.map(named), dataStores: read.dataStores.map(named) };
}

/** Whether the question may be sent: all is read and nothing would be refused. */
export function appPublishTogetherReady(read: AppPublishTogetherRead): boolean {
  return (
    read.status === "ready" &&
    [...read.workflows, ...read.dataStores].every((member) => member.refusals.length === 0)
  );
}

/** The line of the question; nothing where the publish makes nothing live with the App. */
export function AppPublishTogetherView({ read }: { read: AppPublishTogetherRead }) {
  if (read.status === "ready" && read.workflows.length === 0 && read.dataStores.length === 0) {
    return null;
  }
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
          {read.dataStores.map((store) => (
            <TogetherStore key={store.name} store={store} />
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
        <InlineError key={`${refusal.reason}:${refusal.message}`}>
          {/* The review names the Workflow by its row and a missing right as `right`. */}
          {tellRefusal(
            {
              reason: refusal.reason,
              workflow: workflow.name,
              ...(refusal.right === undefined ? {} : { right: refusal.right })
            },
            t
          )?.message ?? refusal.message}
        </InlineError>
      ))}
    </li>
  );
}

/** A Data Store published with the App: new or changed, and the changes to its tables. */
function TogetherStore({ store }: { store: AppPublishTogetherStore }) {
  const { locale, t } = useTranslation();
  const isNew = store.publishedRevision === undefined;
  const count = store.pendingMigrations.length;
  return (
    <li className="grid min-w-0 gap-1" data-data-store={store.name}>
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="wrap-anywhere">
          {t("apps.publishTogetherDataStore", { title: store.title })}
        </span>
        <Badge tone={isNew ? "accent" : "neutral"} size="sm">
          {t(isNew ? "apps.publishTogetherNew" : "apps.publishTogetherChanged")}
        </Badge>
      </span>
      {count > 0 || store.lastChangedBy ? (
        <span className="flex min-w-0 flex-wrap items-center gap-2 text-caption text-muted-foreground">
          {count > 0 ? (
            <span>
              {t(
                count === 1 ? "apps.publishTogetherMigrationOne" : "apps.publishTogetherMigrations",
                { count: new Intl.NumberFormat(locale).format(count) }
              )}
            </span>
          ) : null}
          {store.lastChangedBy ? (
            <span>{t("apps.publishTogetherChangedBy", { name: store.lastChangedBy })}</span>
          ) : null}
        </span>
      ) : null}
      {store.refusals.map((refusal) => (
        <InlineError key={`${refusal.reason}:${refusal.message}`}>
          {refusal.reason === "data_store_draft_below_min_schema"
            ? t("apps.publishDataStoreDraftBelowMinSchema", { title: store.title })
            : refusal.message}
        </InlineError>
      ))}
    </li>
  );
}
