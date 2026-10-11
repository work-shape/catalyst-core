import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import type { Asset } from "@vivd-catalyst/api-client";
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  InlineError,
  KeyValue,
  KeyValueList,
  PageHeader,
  ScopeChip,
  SkeletonList
} from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import { workspaceRoutePath } from "../routes";
import { appDescription, appManifestSummary, type AppState } from "./app-model";
import type { AppsWorkspace } from "./apps-host";

/** The address of an App for its users, as a link another person can follow. */
export function appLink(workspaceId: string, app: string, origin: string): string {
  return new URL(
    workspaceRoutePath({ kind: "app", collaborationWorkspaceId: workspaceId, app }),
    origin
  ).toString();
}

/** The chip that says which workspace an App belongs to. */
export function AppScope({ workspace }: { workspace: AppsWorkspace }) {
  return <ScopeChip scope="workspace" size="sm" name={workspace.name} emoji={workspace.emoji} />;
}

/** Where an App stands, as a list row and the header of the App say it. */
export function AppStateBadge({ state }: { state: AppState }) {
  const { t } = useTranslation();
  return state.kind === "published" ? (
    <Badge tone="success" size="sm" dot>
      {t("apps.published", { number: state.revision })}
    </Badge>
  ) : (
    <Badge tone="neutral" size="sm" dot>
      {t("apps.draftOnly")}
    </Badge>
  );
}

/**
 * The head of an open App: the way back to the list, the name, the workspace and the state,
 * then the actions of the screen. It is one band of the header's height at the top edge; the
 * App's frame takes everything under it.
 */
export function AppHeader({
  name,
  workspace,
  state,
  description,
  secondaryActions,
  primaryAction,
  overflow,
  backHref,
  onBack
}: {
  name: string;
  workspace: AppsWorkspace;
  /** The badge after the workspace: the published or the draft revision. */
  state?: ReactNode;
  description?: ReactNode;
  secondaryActions?: ReactNode;
  primaryAction?: ReactNode;
  overflow?: ReactNode;
  backHref: string;
  onBack(): void;
}) {
  const { t } = useTranslation();
  return (
    <PageHeader
      variant="detail"
      className="shrink-0"
      back={
        <Button asChild variant="ghost" size="sm">
          <a
            href={backHref}
            aria-label={t("apps.backToList")}
            onClick={(event) => {
              if (opensHere(event)) {
                event.preventDefault();
                onBack();
              }
            }}
          >
            <ArrowLeft aria-hidden="true" />
            <span className="max-sm:hidden">{t("apps.title")}</span>
          </a>
        </Button>
      }
      title={name}
      scope={<AppScope workspace={workspace} />}
      state={state}
      description={description}
      secondaryActions={secondaryActions}
      primaryAction={primaryAction}
      overflow={overflow}
    />
  );
}

/** A plain click opens here; one with a modifier or another button is the browser's. */
export function opensHere(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * The frame of an open App: the head, and under it the room the App fills up to the window's
 * edges. Below `md` the head's first row starts after the button that opens the sidebar. The
 * name takes the focus when the screen opens, as on every full page.
 */
export function AppFrame({
  label,
  header,
  children,
  testId
}: {
  /** Names the landmark. */
  label: string;
  header: ReactNode;
  children: ReactNode;
  testId: string;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const title = ref.current?.querySelector("h1");
    if (title) {
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
    }
  }, []);
  return (
    <section
      ref={ref}
      aria-label={label}
      data-testid={testId}
      className="flex h-full min-h-0 min-w-0 flex-col bg-background max-md:[--layout-page-head-start:var(--layout-header-control)]"
    >
      {header}
      <div className="min-h-0 min-w-0 flex-1">{children}</div>
    </section>
  );
}

/**
 * What an App is and what it reaches: its id, its description, and the Connections, actions
 * and external hosts its manifest names. The record is the App's newest revision, which the
 * dialog says by number.
 */
export function AppDetailsDialog({
  name,
  app,
  failed,
  onClose
}: {
  name: string;
  /** The record, once it arrived. */
  app: Asset | undefined;
  failed: boolean;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const summary = app ? appManifestSummary(app.config) : undefined;
  const description = appDescription(app?.config);
  return (
    <Dialog
      open
      size="sm"
      title={t("apps.detailsOf", { name })}
      description={
        app ? t("apps.detailsRevision", { number: app.contentRevision ?? app.revision }) : undefined
      }
      onClose={onClose}
      footer={
        <Button variant="outline" onClick={onClose}>
          {t("close")}
        </Button>
      }
    >
      {app && summary ? (
        <KeyValueList>
          <KeyValue label={t("apps.detailsId")} copyValue={app.name}>
            <code className="font-mono text-code">{app.name}</code>
          </KeyValue>
          {description ? (
            <KeyValue label={t("apps.detailsDescription")} foldable>
              {description}
            </KeyValue>
          ) : null}
          <KeyValue label={t("apps.detailsConnections")}>
            <NameList names={summary.connections} />
          </KeyValue>
          <KeyValue label={t("apps.detailsActions")}>
            <NameList names={summary.actions} />
          </KeyValue>
          <KeyValue label={t("apps.detailsHosts")}>
            <NameList names={summary.hosts} />
          </KeyValue>
        </KeyValueList>
      ) : failed ? (
        <InlineError>{t("apps.detailsFailed")}</InlineError>
      ) : (
        <SkeletonList rows={4} />
      )}
    </Dialog>
  );
}

/** Names of a manifest, one per line in code type, or the word for none. */
export function NameList({ names }: { names: readonly string[] }) {
  const { t } = useTranslation();
  if (names.length === 0) {
    return <span className="text-muted-foreground">{t("apps.detailsNone")}</span>;
  }
  return (
    <ul className="grid min-w-0 gap-0.5">
      {names.map((name) => (
        <li key={name} className="min-w-0 break-words">
          <code className="font-mono text-code">{name}</code>
        </li>
      ))}
    </ul>
  );
}

/** Asks once before an App is deleted, naming it. */
export function AppDeleteDialog({
  name,
  loading,
  error,
  onConfirm,
  onClose
}: {
  name: string;
  loading: boolean;
  error: string | undefined;
  onConfirm(): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open
      tone="danger"
      title={t("apps.deleteTitle", { name })}
      confirmLabel={t("apps.delete")}
      loading={loading}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      {t("apps.deleteBody")}
      {error ? <InlineError className="mt-3">{error}</InlineError> : null}
    </ConfirmDialog>
  );
}
