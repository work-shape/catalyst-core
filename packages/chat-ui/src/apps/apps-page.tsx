import { LayoutGrid, MoreHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AssetSummary, LocaleCode } from "@vivd-catalyst/api-client";
import {
  Avatar,
  Badge,
  Button,
  Chip,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  InlineError,
  List,
  ListRow,
  Page,
  PageHeader,
  SkeletonList
} from "@vivd-catalyst/ui";
import { instanceSentence } from "../build-area/build-refusals";
import { formatUpdated } from "../build-area/build-model";
import { formatDateTime } from "../control-plane/locale-format";
import { useTranslation } from "../i18n";
import { workspaceRoutePath } from "../routes";
import type { WorkspaceRoute } from "../workspace/workspace-route";
import { useApp, useAppList, useAppWrites, type AppList } from "./app-data";
import {
  AppDeleteDialog,
  AppDetailsDialog,
  AppStateBadge,
  CopyAppLinkItem,
  opensHere
} from "./app-header";
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
 * Where a row leads: the App as its users are served it, or its draft for a writer while
 * nothing is published. A reader who can open neither gets a row without a link.
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
 * The Apps of the open workspace: the list, what a row offers, and the two dialogs a row
 * opens. The list is read page by page; the record of one App is read only when its details
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
  // The ages are counted from when the list last arrived.
  const rows = list.rows;
  const now = useMemo(() => new Date(), [rows]);

  if (!host || !workspace || !rights) {
    return null;
  }
  const show = (route: WorkspaceRoute) => host.showRoute(route);
  const act = (action: AppRowAction, app: AssetSummary) => {
    const address = { collaborationWorkspaceId: workspace.id, app: app.name };
    switch (action) {
      case "open":
        show({ kind: "app", ...address });
        break;
      case "edit":
        show({ kind: "app-edit", ...address });
        break;
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

/** The Apps list as it stands for a given list and a given reader. */
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
  onAction(action: AppRowAction, app: AssetSummary): void;
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
        className="chat-scrollbar min-h-0 min-w-0 overflow-x-hidden overflow-y-auto [container-type:size] max-md:[--layout-page-inset:var(--layout-header)]"
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
            <div className="grid min-w-0 gap-3">
              <List aria-label={t("apps.title")}>
                {rows.map((app) => (
                  <AppRow
                    key={app.name}
                    app={app}
                    workspace={workspace}
                    rights={rights}
                    now={now}
                    locale={locale}
                    onOpenRoute={onOpenRoute}
                    onAction={onAction}
                  />
                ))}
              </List>
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

const ROW_ACTION_LABELS = {
  open: "apps.open",
  edit: "apps.edit",
  details: "apps.details",
  copy_link: "apps.copyLink",
  delete: "apps.delete"
} as const;

function AppRow({
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
  onAction(action: AppRowAction, app: AssetSummary): void;
}) {
  const { t } = useTranslation();
  const name = appDisplayName(app);
  const state = appState(app);
  const route = appRowRoute(workspace.id, app, state, rights);
  const actions = appRowActions(rights, state, appDraftShown(app));
  const builder = appBuilder(rights);
  // Whoever uses Apps is shown the App: the number of its revision and its id are a builder's.
  // That nothing is published yet is said to everybody, since such a row opens nothing.
  const stateChips =
    builder || state.kind === "draft_only" ? (
      <>
        <AppStateBadge state={state} />
        {rights.write && state.kind === "published" && state.draftAhead ? (
          <Badge tone="warning" size="sm">
            {t("apps.unpublishedChanges")}
          </Badge>
        ) : null}
      </>
    ) : undefined;
  const about =
    app.description?.trim() ||
    (builder ? <code className="font-mono">{app.name}</code> : undefined);
  return (
    <ListRow
      leading={<Avatar kind="app" name={name} />}
      title={name}
      // A phone gives the first line to the name: the state stands under it, where a wider
      // window has the description or the id. The list is the one of the open workspace, so
      // no row names it.
      description={
        stateChips ? (
          <>
            <span className="flex flex-wrap gap-1.5 py-0.5 sm:hidden">{stateChips}</span>
            <span className="max-sm:hidden">{about}</span>
          </>
        ) : (
          about
        )
      }
      descriptionWraps
      chips={stateChips ? <span className="hidden sm:contents">{stateChips}</span> : undefined}
      time={
        <time
          className="hidden sm:inline"
          dateTime={app.updatedAt}
          title={formatDateTime(app.updatedAt, locale)}
        >
          {formatUpdated(app.updatedAt, now, locale)}
        </time>
      }
      link={
        route ? (
          <a
            href={workspaceRoutePath(route)}
            onClick={(event) => {
              if (opensHere(event)) {
                event.preventDefault();
                onOpenRoute(route);
              }
            }}
          />
        ) : undefined
      }
      actions={
        actions.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label={t("apps.actionsOf", { name })}>
                <MoreHorizontal aria-hidden="true" />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {actions.map((action) =>
                action === "delete" ? (
                  <DeleteItem
                    key={action}
                    separated={actions.length > 1}
                    onSelect={() => onAction(action, app)}
                  />
                ) : action === "copy_link" ? (
                  <CopyAppLinkItem key={action} workspaceId={workspace.id} app={app.name} />
                ) : (
                  <DropdownMenuItem key={action} onSelect={() => onAction(action, app)}>
                    {t(ROW_ACTION_LABELS[action])}
                  </DropdownMenuItem>
                )
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : undefined
      }
    />
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
