import { MoreHorizontal, Pencil } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import type { AppPreviewResponse } from "@vivd-catalyst/api-client";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton
} from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import { workspaceRouteFromPath, workspaceRoutePath } from "../routes";
import { useApp } from "./app-data";
import { AppDetailsDialog, AppFrame, AppHeader, appLink, AppStateBadge } from "./app-header";
import {
  APP_START_ROUTE,
  appReadRevision,
  appTitle,
  NO_APP_RIGHTS,
  type AppRights
} from "./app-model";
import { AppPreview } from "./app-preview";
import { CopiedNotice } from "./apps-page";
import { useAppsHost, type AppsWorkspace } from "./apps-host";

/**
 * One App as its users are served it, across the full width (layout 2). The frame shows the
 * published revision; the address carries the App's own route, so a link into the App opens
 * where it points and a reload stays there. The record of the App is read at the draft for
 * whoever may write or publish it and at the published revision for everybody else; a reader
 * the instance gives no record sees the App under its id.
 */
export function AppView({ app, appPath }: { app: string; appPath?: string }) {
  const { t } = useTranslation();
  const host = useAppsHost();
  const workspace = host?.workspace;
  const rights = host?.rights;
  const record = useApp(
    workspace?.id ?? "",
    app,
    Boolean(workspace && rights),
    appReadRevision(rights ?? NO_APP_RIGHTS)
  );
  const [shown, setShown] = useState<AppPreviewResponse>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copied, setCopied] = useState(0);
  const showRoute = host?.showRoute;
  const workspaceId = workspace?.id;

  const onShown = useCallback(
    (preview: AppPreviewResponse) => {
      setShown(preview);
      // The App belongs to one workspace. An address that names another is put right.
      const home = workspaceRouteFromPath(preview.interfacePath);
      if (
        home?.kind === "app" &&
        workspaceId !== undefined &&
        home.collaborationWorkspaceId !== workspaceId
      ) {
        showRoute?.({ ...home, ...(appPath ? { appPath } : {}) }, { replace: true });
      }
    },
    [appPath, showRoute, workspaceId]
  );
  const onNavigate = useCallback(
    (path: string) => {
      if (workspaceId === undefined) {
        return;
      }
      // The App's route replaces the address: Back leaves the App, as it does a page.
      showRoute?.(
        {
          kind: "app",
          collaborationWorkspaceId: workspaceId,
          app,
          ...(path === APP_START_ROUTE ? {} : { appPath: path })
        },
        { replace: true }
      );
    },
    [app, showRoute, workspaceId]
  );

  if (!host || !workspace || !rights) {
    return null;
  }
  const name = appTitle(record.app, app);
  const published = shown?.revision ?? record.app?.publishedRevision;
  const address = { collaborationWorkspaceId: workspace.id, app };
  return (
    <>
      <AppViewFrame
        name={name}
        workspace={workspace}
        rights={rights}
        publishedRevision={published}
        onBack={() => host.showRoute({ kind: "apps", collaborationWorkspaceId: workspace.id })}
        onEdit={() => host.showRoute({ kind: "app-edit", ...address })}
        onDetails={() => setDetailsOpen(true)}
        onCopyLink={() => {
          navigator.clipboard.writeText(appLink(workspace.id, app, window.location.origin)).then(
            () => setCopied((count) => count + 1),
            () => undefined
          );
        }}
      >
        <AppPreview
          app={app}
          mode="published"
          name={name}
          appPath={appPath}
          stoppedAction={
            rights.write ? (
              <Button onClick={() => host.showRoute({ kind: "app-edit", ...address })}>
                {t("apps.openDraft")}
              </Button>
            ) : undefined
          }
          onNavigate={onNavigate}
          onShown={onShown}
        />
      </AppViewFrame>
      <CopiedNotice key={copied} shown={copied > 0} />
      {detailsOpen ? (
        <AppDetailsDialog
          name={name}
          app={record.app}
          failed={record.failed || record.missing}
          onClose={() => setDetailsOpen(false)}
        />
      ) : null}
    </>
  );
}

/** Layout 2 for given facts: the head with what this reader may do, and the App under it. */
export function AppViewFrame({
  name,
  workspace,
  rights,
  publishedRevision,
  children,
  onBack,
  onEdit,
  onDetails,
  onCopyLink
}: {
  name: string;
  workspace: AppsWorkspace;
  rights: AppRights;
  /** The number of the revision shown, once it is known. */
  publishedRevision: number | undefined;
  /** The App's frame, or what stands in its place. */
  children: ReactNode;
  onBack(): void;
  onEdit(): void;
  onDetails(): void;
  onCopyLink(): void;
}) {
  const { t } = useTranslation();
  return (
    <AppFrame
      label={name}
      testId="app-view"
      header={
        <AppHeader
          name={name}
          workspace={workspace}
          state={
            publishedRevision === undefined ? undefined : (
              <AppStateBadge
                state={{ kind: "published", revision: publishedRevision, draftAhead: false }}
              />
            )
          }
          backHref={workspaceRoutePath({ kind: "apps", collaborationWorkspaceId: workspace.id })}
          onBack={onBack}
          secondaryActions={
            rights.write ? (
              <Button variant="outline" onClick={onEdit}>
                <Pencil aria-hidden="true" />
                {t("apps.edit")}
              </Button>
            ) : undefined
          }
          overflow={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label={t("apps.moreActions")} variant="outline">
                  <MoreHorizontal aria-hidden="true" />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {rights.read ? (
                  <DropdownMenuItem onSelect={onDetails}>{t("apps.details")}</DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onSelect={onCopyLink}>{t("apps.copyLink")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
      }
    >
      {children}
    </AppFrame>
  );
}
