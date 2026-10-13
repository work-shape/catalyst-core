import { LayoutGrid, MoreHorizontal } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { AssetSummary, LocaleCode } from "@vivd-catalyst/api-client";
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  Chip,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  InlineError,
  Page,
  PageHeader,
  SkeletonList
} from "@vivd-catalyst/ui";
import { instanceSentence } from "../build-area/build-refusals";
import { formatUpdated } from "../build-area/build-model";
import { formatDateTime } from "../control-plane/locale-format";
import { useTranslation } from "../i18n";
import { RouteLink } from "../route-link";
import type { WorkspaceRoute } from "../workspace/workspace-route";
import { useApp, useAppActions, useAppList, useAppWrites, type AppList } from "./app-data";
import { AppDeleteDialog, AppDetailsDialog, AppStateBadge, CopyAppLinkItem } from "./app-header";
import {
  appBuilder,
  appDraftShown,
  appRefusalText,
  appRowActions,
  appState,
  type AppRights,
  type AppRowAction,
  type AppState
} from "./app-model";
import { useAppsHost, type AppsWorkspace } from "./apps-host";

/** The name people read of an App, or its id while it has none. */
function appDisplayName(app: Pick<AssetSummary, "name" | "title">): string {
  return app.title.trim() || app.name;
}

/**
 * Where the main action of a card leads: the App as its users are served it, or its draft for
 * a writer while nothing is published. A reader who can open neither gets a card without one.
 */
export function appRowRoute(
  workspaceId: string,
  app: Pick<AssetSummary, "name">,
  state: AppState,
  rights: AppRights
): WorkspaceRoute | undefined {
  if (state.kind === "published") {
    return { kind: "app", collaborationWorkspaceId: workspaceId, app: app.name };
  }
  return rights.write
    ? { kind: "app-edit", collaborationWorkspaceId: workspaceId, app: app.name }
    : undefined;
}

/**
 * The Apps of the open workspace: one card each, what a card offers, and the two dialogs a
 * card opens. The list is read page by page; the record of one App is read only when its details
 * are asked for.
 */
export function AppsPage() {
  const { t } = useTranslation();
  const host = useAppsHost();
  const workspace = host?.workspace;
  const rights = host?.rights;
  const list = useAppList(workspace?.id);
  const writes = useAppWrites(workspace?.id);
  const [detailsOf, setDetailsOf] = useState<AssetSummary>();
  const [deleting, setDeleting] = useState<AssetSummary>();
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const details = useApp(workspace?.id ?? "", detailsOf?.name ?? "", detailsOf !== undefined);
  const detailActions = useAppActions(detailsOf?.name ?? "", detailsOf !== undefined);
  // The ages are counted from when the list last arrived.
  const rows = list.rows;
  const now = useMemo(() => new Date(), [rows]);

  if (!host || !workspace || !rights) {
    return null;
  }
  const show = (route: WorkspaceRoute) => host.showRoute(route);
  const act = (action: AppMenuAction, app: AssetSummary) => {
    switch (action) {
      case "details":
        setDetailsOf(app);
        break;
      case "copy_link":
        // The item copies by itself and answers in place.
        break;
      case "delete":
        setDeleteError(undefined);
        setDeleting(app);
        break;
    }
  };
  const remove = async (app: AssetSummary) => {
    setDeleteBusy(true);
    setDeleteError(undefined);
    try {
      await writes.remove(app.name, app.revision);
      setDeleting(undefined);
    } catch (error) {
      const refusal = appRefusalText(error);
      setDeleteError(refusal ? t(refusal) : (instanceSentence(error) ?? t("apps.deleteFailed")));
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <>
      <AppsPageView
        workspace={workspace}
        rights={rights}
        list={list}
        now={now}
        onOpenRoute={show}
        onAction={act}
        onBuildInChat={host.startChat}
      />
      {detailsOf ? (
        <AppDetailsDialog
          name={appDisplayName(detailsOf)}
          app={details.app}
          actions={detailActions}
          failed={details.failed || details.missing}
          onClose={() => setDetailsOf(undefined)}
        />
      ) : null}
      {deleting ? (
        <AppDeleteDialog
          name={appDisplayName(deleting)}
          loading={deleteBusy}
          error={deleteError}
          onConfirm={() => {
            remove(deleting).catch(() => undefined);
          }}
          onClose={() => setDeleting(undefined)}
        />
      ) : null}
    </>
  );
}

/** The Apps page as it stands for a given list and a given reader. */
export function AppsPageView({
  workspace,
  rights,
  list,
  now,
  onOpenRoute,
  onAction,
  onBuildInChat
}: {
  workspace: AppsWorkspace;
  rights: AppRights;
  list: AppList;
  now: Date;
  onOpenRoute(route: WorkspaceRoute): void;
  onAction(action: AppMenuAction, app: AssetSummary): void;
  /** Opens a new conversation with this text in its composer. */
  onBuildInChat(prompt: string): void;
}) {
  const { locale, t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = list.rows;

  // The area's title takes the focus when the area opens, as on every full page.
  useEffect(() => {
    const title = scrollRef.current?.querySelector("h1");
    if (title) {
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
    }
  }, []);

  return (
    <section
      aria-label={t("apps.title")}
      data-testid="apps-area"
      className="grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] bg-background"
    >
      <div
        ref={scrollRef}
        // Below `md` the button that opens the sidebar floats over the page, which starts below it.
        className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto [container-type:size] max-md:[--layout-page-inset:var(--layout-header)]"
      >
        <Page>
          <PageHeader title={t("apps.title")} description={t("apps.description")} />
          {list.failed ? (
            <InlineError className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <span>{t("apps.listFailed")}</span>
              <Button variant="outline" size="sm" onClick={list.retry}>
                {t("tryAgain")}
              </Button>
            </InlineError>
          ) : null}
          {rows === undefined ? (
            list.failed ? null : (
              <SkeletonList rows={4} />
            )
          ) : rows.length === 0 ? (
            rights.write ? (
              <EmptyState
                icon={<LayoutGrid aria-hidden="true" />}
                action={
                  <Button onClick={() => onBuildInChat(t("apps.promptStart"))}>
                    {t("apps.buildInChat")}
                  </Button>
                }
                presets={
                  <>
                    <Chip onClick={() => onBuildInChat(t("apps.promptForm"))}>
                      {t("apps.presetForm")}
                    </Chip>
                    <Chip onClick={() => onBuildInChat(t("apps.promptDashboard"))}>
                      {t("apps.presetDashboard")}
                    </Chip>
                  </>
                }
              >
                {t("apps.empty")}
              </EmptyState>
            ) : (
              <EmptyState icon={<LayoutGrid aria-hidden="true" />}>
                {t("apps.emptyReadOnly")}
              </EmptyState>
            )
          ) : (
            <div className="grid min-w-0 gap-4">
              <ul aria-label={t("apps.title")} className="grid grid-cols-1 gap-4 @2xl:grid-cols-2">
                {rows.map((app) => (
                  <li key={app.name} className="flex min-w-0">
                    <AppCard
                      app={app}
                      workspace={workspace}
                      rights={rights}
                      now={now}
                      locale={locale}
                      onOpenRoute={onOpenRoute}
                      onAction={onAction}
                    />
                  </li>
                ))}
              </ul>
              {list.hasMore ? (
                <Button
                  variant="outline"
                  className="justify-self-start"
                  loading={list.loadingMore}
                  onClick={list.loadMore}
                >
                  {t("apps.showMore")}
                </Button>
              ) : null}
            </div>
          )}
        </Page>
      </div>
    </section>
  );
}

/** What the menu of a card holds: what the card does not offer as a button of its own. */
type AppMenuAction = Exclude<AppRowAction, "open" | "edit">;

const MENU_ACTION_LABELS = {
  details: "apps.details",
  copy_link: "apps.copyLink",
  delete: "apps.delete"
} as const satisfies Record<AppMenuAction, string>;

function menuAction(action: AppRowAction): action is AppMenuAction {
  return action !== "open" && action !== "edit";
}

/**
 * One App: what it is called and what it is for, where it stands, when it last changed, and
 * the way into it. The main action is the first of the footer; what a builder does beside it
 * stands at the other end.
 */
function AppCard({
  app,
  workspace,
  rights,
  now,
  locale,
  onOpenRoute,
  onAction
}: {
  app: AssetSummary;
  workspace: AppsWorkspace;
  rights: AppRights;
  now: Date;
  locale: LocaleCode;
  onOpenRoute(route: WorkspaceRoute): void;
  onAction(action: AppMenuAction, app: AssetSummary): void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const name = appDisplayName(app);
  const state = appState(app);
  const route = appRowRoute(workspace.id, app, state, rights);
  const actions = appRowActions(rights, state, appDraftShown(app));
  const menu = actions.filter(menuAction);
  const builder = appBuilder(rights);
  const description = app.description?.trim();
  // A published App opens; the draft is edited beside it. An App with a draft alone has the
  // draft as its main action, so no second way leads to the same place.
  const editRoute: WorkspaceRoute | undefined =
    state.kind === "published" && actions.includes("edit")
      ? { kind: "app-edit", collaborationWorkspaceId: workspace.id, app: app.name }
      : undefined;

  return (
    <Card padding="md" className="flex w-full min-w-0 flex-col">
      <CardHeader>
        <div className="flex min-w-0 items-center gap-3">
          <Avatar kind="app" name={name} />
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <CardTitle id={titleId} className="min-w-0 break-words">
              {name}
            </CardTitle>
            {/*
              Whoever uses Apps is shown the App: the number of its revision is a builder's.
              That nothing is published yet is said to everybody, since such a card opens
              nothing.
            */}
            {builder || state.kind === "draft_only" ? <AppStateBadge state={state} /> : null}
            {rights.write && state.kind === "published" && state.draftAhead ? (
              <Badge tone="warning" size="sm">
                {t("apps.unpublishedChanges")}
              </Badge>
            ) : null}
          </div>
        </div>
        {description ? <p className="text-body text-muted-foreground">{description}</p> : null}
      </CardHeader>
      <CardContent>
        {/* The list is the one of the open workspace, so no card names it. */}
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-caption text-muted-foreground">
          {/* The id is part of the App's address: a builder's, as the revision is. */}
          {builder ? <code className="min-w-0 font-mono break-all">{app.name}</code> : null}
          <time dateTime={app.updatedAt} title={formatDateTime(app.updatedAt, locale)}>
            {t("apps.changed", { when: formatUpdated(app.updatedAt, now, locale) })}
          </time>
        </p>
      </CardContent>
      {route || editRoute || menu.length > 0 ? (
        <CardFooter>
          {route ? (
            <RouteLink route={route} variant="primary" describedBy={titleId} onOpen={onOpenRoute}>
              {t(route.kind === "app" ? "apps.open" : "apps.edit")}
            </RouteLink>
          ) : null}
          <div className="ml-auto flex items-center gap-1">
            {editRoute ? (
              <RouteLink
                route={editRoute}
                variant="link"
                describedBy={titleId}
                onOpen={onOpenRoute}
              >
                {t("apps.edit")}
              </RouteLink>
            ) : null}
            {menu.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton size="sm" label={t("apps.actionsOf", { name })}>
                    <MoreHorizontal aria-hidden="true" />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {menu.map((action) =>
                    action === "delete" ? (
                      <DeleteItem
                        key={action}
                        separated={menu.length > 1}
                        onSelect={() => onAction(action, app)}
                      />
                    ) : action === "copy_link" ? (
                      <CopyAppLinkItem key={action} workspaceId={workspace.id} app={app.name} />
                    ) : (
                      <DropdownMenuItem key={action} onSelect={() => onAction(action, app)}>
                        {t(MENU_ACTION_LABELS[action])}
                      </DropdownMenuItem>
                    )
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </CardFooter>
      ) : null}
    </Card>
  );
}

/** The destructive item: last, in the danger tone, after a line when others stand above it. */
function DeleteItem({ separated, onSelect }: { separated: boolean; onSelect(): void }) {
  const { t } = useTranslation();
  return (
    <>
      {separated ? <DropdownMenuSeparator /> : null}
      <DropdownMenuItem tone="danger" onSelect={onSelect}>
        {t("apps.delete")}
      </DropdownMenuItem>
    </>
  );
}
