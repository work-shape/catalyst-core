import { Check, Link } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Asset } from "@vivd-catalyst/api-client";
import {
  Badge,
  Button,
  cn,
  ConfirmDialog,
  Dialog,
  DropdownMenuCopyItem,
  InlineError,
  KeyValue,
  KeyValueList,
  PageHeader,
  PageHeaderBack,
  SkeletonList
} from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import { workspaceRoutePath } from "../routes";
import { AppActionEffect, AppActionOutcomeBadge } from "./app-action-facts";
import type { AppActionsRead } from "./app-data";
import { appDescription, appManifestSummary, type AppState } from "./app-model";

/** The address of an App for its users, as a link another person can follow. */
export function appLink(workspaceId: string, app: string, origin: string): string {
  return new URL(
    workspaceRoutePath({ kind: "app", collaborationWorkspaceId: workspaceId, app }),
    origin
  ).toString();
}

/** How long the copy item says that it copied, as the copy buttons of a conversation do. */
const LINK_COPIED_MS = 1500;

/**
 * Puts the link of an App on the clipboard, and says for a moment that it did. Whatever copies
 * answers in place, in its label and to a screen reader.
 */
function useCopyAppLink(workspaceId: string, app: string): { copied: boolean; copy(): void } {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timeout = setTimeout(() => setCopied(false), LINK_COPIED_MS);
    return () => clearTimeout(timeout);
  }, [copied]);
  return {
    copied,
    copy() {
      navigator.clipboard.writeText(appLink(workspaceId, app, window.location.origin)).then(
        () => setCopied(true),
        () => setCopied(false)
      );
    }
  };
}

/** The menu item that copies the link of an App. The menu stays open while the item answers. */
export function CopyAppLinkItem({ workspaceId, app }: { workspaceId: string; app: string }) {
  const { t } = useTranslation();
  return (
    <DropdownMenuCopyItem
      value={appLink(workspaceId, app, window.location.origin)}
      copiedLabel={t("apps.linkCopied")}
      icon={<Link aria-hidden="true" />}
    >
      {t("apps.copyLink")}
    </DropdownMenuCopyItem>
  );
}

/**
 * The button that copies the link of an App, where copying is all the reader is offered: a
 * menu of one item would hide it behind a second press.
 */
export function CopyAppLinkButton({ workspaceId, app }: { workspaceId: string; app: string }) {
  const { t } = useTranslation();
  const { copied, copy } = useCopyAppLink(workspaceId, app);
  return (
    <>
      <Button variant="outline" onClick={copy}>
        {copied ? <Check aria-hidden="true" /> : <Link aria-hidden="true" />}
        {copied ? t("apps.linkCopied") : t("apps.copyLink")}
      </Button>
      <span role="status" className="sr-only">
        {copied ? t("apps.linkCopied") : null}
      </span>
    </>
  );
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
 * The head of an open App: the way back to the list, the name and the state, then the actions
 * of the screen. The App is shown inside its workspace, so the head does not name it again. It
 * is one band of the header's height at the top edge; the App's frame takes everything under
 * it.
 */
export function AppHeader({
  name,
  description,
  state,
  keepState = false,
  secondaryActions,
  primaryAction,
  overflow,
  tabs,
  backHref,
  onBack
}: {
  name: string;
  /** What the App does, in one line after its name. */
  description?: string;
  /** The badge after the name: the published or the draft revision. */
  state?: ReactNode;
  /**
   * The state is always in view, as for a draft never published: where the head has tabs it
   * stands at the end of their row, which has room whatever the actions take.
   */
  keepState?: boolean;
  secondaryActions?: ReactNode;
  primaryAction?: ReactNode;
  overflow?: ReactNode;
  /** The views of the App, as a `TabsList`: a row under the head, whose line ends the head. */
  tabs?: ReactNode;
  backHref: string;
  onBack(): void;
}) {
  const { t } = useTranslation();
  const stateUnderHead = keepState && tabs !== undefined;
  const head = (
    <PageHeader
      variant="detail"
      className={cn("shrink-0", tabs !== undefined && "border-b-0")}
      back={
        <PageHeaderBack
          href={backHref}
          label={t("apps.backToList")}
          onClick={(event) => {
            if (opensHere(event)) {
              event.preventDefault();
              onBack();
            }
          }}
        >
          {t("apps.title")}
        </PageHeaderBack>
      }
      title={name}
      description={description}
      state={stateUnderHead ? undefined : state}
      secondaryActions={secondaryActions}
      primaryAction={primaryAction}
      overflow={overflow}
    />
  );
  return tabs === undefined ? (
    head
  ) : (
    <>
      {head}
      <div className="flex shrink-0 items-stretch px-(--layout-gutter)">
        <div className="min-w-0 flex-1">{tabs}</div>
        {stateUnderHead ? (
          <div data-slot="app-head-state" className="flex shrink-0 items-center border-b ps-3">
            {state}
          </div>
        ) : null}
      </div>
    </>
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
      className="@container/app-frame flex h-full min-h-0 min-w-0 flex-col bg-background max-md:[--layout-page-head-start:var(--layout-header-control)]"
    >
      {header}
      <div className="min-h-0 min-w-0 flex-1">{children}</div>
    </section>
  );
}

/**
 * What an App is and what it reaches: its description, and the Connections, actions
 * and external hosts its manifest names. The record is the App's newest revision, which the
 * dialog says by number. Each action is listed with its effect and what the policy makes of a
 * call of it for the reader, once the instance said so; until then, and where it could not,
 * the actions are the names of the manifest.
 */
export function AppDetailsDialog({
  name,
  app,
  actions,
  failed,
  onClose
}: {
  name: string;
  /** The record, once it arrived. */
  app: Asset | undefined;
  actions: AppActionsRead;
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
          {description ? (
            <KeyValue label={t("apps.detailsDescription")} foldable>
              {description}
            </KeyValue>
          ) : null}
          <KeyValue label={t("apps.detailsConnections")}>
            <NameList names={summary.connections} />
          </KeyValue>
          <KeyValue label={t("apps.detailsActions")}>
            {actions.status === "ready" && actions.actions.length > 0 ? (
              <ul className="grid min-w-0 gap-1.5" data-app-details-actions>
                {actions.actions.map((action) => (
                  <li
                    key={action.name}
                    data-app-action={action.name}
                    className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
                  >
                    <code className="min-w-0 font-mono text-code break-words">{action.name}</code>
                    <AppActionEffect effect={action.effect} />
                    <AppActionOutcomeBadge action={action} />
                  </li>
                ))}
              </ul>
            ) : (
              <NameList names={summary.actions} />
            )}
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
