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
import { CopyIdItem } from "../copy-id-item";
import { useTranslation } from "../i18n";
import { workspaceRouteFromPath, workspaceRoutePath } from "../routes";
import { useApp, useAppActions } from "./app-data";
import {
  AppDetailsDialog,
  AppFrame,
  AppHeader,
  AppStateBadge,
  CopyAppLinkButton,
  CopyAppLinkItem
} from "./app-header";
import {
  APP_START_ROUTE,
  appBuilder,
  appDescription,
  appDraftShown,
  appTitle,
  type AppRights
} from "./app-model";
import { AppPreview } from "./app-preview";
import { AppEditWithAgentAction } from "./app-edit-with-agent";
import { useAppsHost, type AppsWorkspace } from "./apps-host";

/**
 * One App open across the main area (layout 2): the published revision in the frame, and the
 * head with what this reader may do. The record is read without naming a revision: the
 * instance answers the draft to whoever may read it and the published view to everybody else
 * who may open the App. The way to the draft is offered only where the answer names one.
 */
export function AppView({ app, appPath }: { app: string; appPath?: string }) {
  const { t } = useTranslation();
  const host = useAppsHost();
  const workspace = host?.workspace;
  const rights = host?.rights;
  const record = useApp(workspace?.id ?? "", app, workspace !== undefined);
  const [shown, setShown] = useState<AppPreviewResponse>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  // The list is read by whoever reads the App's record. Everybody else is shown the names of
  // the record, and no request is made that the instance would refuse.
  const actions = useAppActions(app, detailsOpen && rights?.read === true);
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
  const draftShown = appDraftShown(record.app);
  const published = shown?.revision ?? record.app?.publishedRevision;
  const address = { collaborationWorkspaceId: workspace.id, app };
  return (
    <>
      <AppViewFrame
        name={name}
        description={appDescription(record.app?.config)}
        workspace={workspace}
        rights={rights}
        publishedRevision={published}
        onBack={() => host.showRoute({ kind: "apps", collaborationWorkspaceId: workspace.id })}
        onEdit={() => host.showRoute({ kind: "app-edit", ...address })}
        onDetails={() => setDetailsOpen(true)}
        app={app}
        draftShown={draftShown}
      >
        <AppPreview
          app={app}
          mode="published"
          name={name}
          appPath={appPath}
          stoppedAction={
            rights.write && draftShown ? (
              <Button onClick={() => host.showRoute({ kind: "app-edit", ...address })}>
                {t("apps.openDraft")}
              </Button>
            ) : undefined
          }
          onNavigate={onNavigate}
          onShown={onShown}
        />
      </AppViewFrame>
      {detailsOpen ? (
        <AppDetailsDialog
          name={name}
          app={record.app}
          actions={actions}
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
  description,
  app,
  draftShown,
  workspace,
  rights,
  publishedRevision,
  children,
  onBack,
  onEdit,
  onDetails
}: {
  name: string;
  /** What the App does, in one line after its name. */
  description?: string;
  /** The id of the App, which its link carries. */
  app: string;
  /** The instance showed this reader the draft: only then is there one to edit. */
  draftShown: boolean;
  workspace: AppsWorkspace;
  rights: AppRights;
  /** The number of the revision shown, once it is known. */
  publishedRevision: number | undefined;
  /** The App's frame, or what stands in its place. */
  children: ReactNode;
  onBack(): void;
  onEdit(): void;
  onDetails(): void;
}) {
  const { t } = useTranslation();
  return (
    <AppFrame
      label={name}
      testId="app-view"
      header={
        <AppHeader
          name={name}
          description={description}
          // The number of a revision is a builder's: whoever uses the App is shown the App.
          state={
            publishedRevision === undefined || !appBuilder(rights) ? undefined : (
              <AppStateBadge
                state={{ kind: "published", revision: publishedRevision, draftAhead: false }}
              />
            )
          }
          backHref={workspaceRoutePath({ kind: "apps", collaborationWorkspaceId: workspace.id })}
          onBack={onBack}
          secondaryActions={
            rights.write && draftShown ? (
              <>
                <AppEditWithAgentAction app={app} />
                <Button variant="outline" onClick={onEdit}>
                  <Pencil aria-hidden="true" />
                  {t("apps.edit")}
                </Button>
              </>
            ) : undefined
          }
          overflow={
            rights.read ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton label={t("apps.moreActions")} variant="outline">
                    <MoreHorizontal aria-hidden="true" />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={onDetails}>{t("apps.details")}</DropdownMenuItem>
                  <CopyAppLinkItem workspaceId={workspace.id} app={app} />
                  {/* The id is a builder's, as the number of a revision is. */}
                  {appBuilder(rights) ? <CopyIdItem id={app} /> : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <CopyAppLinkButton workspaceId={workspace.id} app={app} />
            )
          }
        />
      }
    >
      {children}
    </AppFrame>
  );
}
