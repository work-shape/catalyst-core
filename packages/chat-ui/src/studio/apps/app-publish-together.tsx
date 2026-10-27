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
import { RefusalNotice } from "../refusal-notice";
import { RunStateBadge } from "../workflows/workflows-frame";
import type {
  AppPublishNamed,
  AppPublishTogetherRead,
  AppPublishTogetherStore,
  AppPublishTogetherWorkflow
} from "./app-data";
import { useAppsHost } from "./apps-host";

// "Published with it" in an App's Publish question (DP-3, GOLIVE-1): the Workflows with
// changes their live revision does not have, children first, and then the Data Stores whose
// draft is not published, which the one Publish makes live with the App, and those live and
// still being updated, which it waits for. Each Workflow says
// whether it is new, who changed it last and how its last test run ended; each store how many
// changes to its tables it applies. Both say what would refuse their publish now.

/** The stores and Workflows the publish names: each with the revision the person was shown. */
export function appPublishTogetherNamed(read: AppPublishTogetherRead): AppPublishNamed {
  const named = ({ name, draftRevision }: { name: string; draftRevision: number }) => ({
    name,
    revision: draftRevision
  });
  // A store that is live and still updating is waited for, not published again.
  return {
    workflows: read.workflows.map(named),
    dataStores: read.dataStores.filter(({ pending }) => pending).map(named)
  };
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
  // Stacked: each store and Workflow, with what would refuse it, takes the dialog's width.
  return (
    <KeyValueList layout="stacked">
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
        <ul className="grid w-full min-w-0 gap-2" data-testid="app-publish-together">
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

/**
 * A Data Store published with the App: new or changed, and the changes to its tables. One that
 * is live and still being updated, which the Publish waits for, says so.
 */
function TogetherStore({ store }: { store: AppPublishTogetherStore }) {
  const { locale, t } = useTranslation();
  const host = useAppsHost();
  const isNew = store.publishedRevision === undefined;
  const badge = !store.pending
    ? "apps.publishTogetherUpdating"
    : isNew
      ? "apps.publishTogetherNew"
      : "apps.publishTogetherChanged";
  const count = store.pendingMigrations.length;
  return (
    <li className="grid min-w-0 gap-1" data-data-store={store.name}>
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="wrap-anywhere">
          {t("apps.publishTogetherDataStore", { title: store.title })}
        </span>
        <Badge tone={isNew && store.pending ? "accent" : "neutral"} size="sm">
          {t(badge)}
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
      {store.refusals.map((refusal) => {
        // The review names the store by its row; a reason the table does not know keeps the
        // instance's sentence. The way to the store is offered where the reader can open it.
        const told = tellRefusal(
          {
            reason: refusal.reason,
            dataStore: store.name,
            title: store.title,
            ...(refusal.right === undefined ? {} : { right: refusal.right })
          },
          t,
          {
            ...(host?.workspace ? { workspaceId: host.workspace.id } : {}),
            ...(host?.canOpen ? { canOpen: host.canOpen } : {})
          }
        );
        return (
          <RefusalNotice
            key={`${refusal.reason}:${refusal.message}`}
            message={told?.message ?? refusal.message}
            action={told?.action}
            onOpen={host?.showRoute}
          />
        );
      })}
    </li>
  );
}
