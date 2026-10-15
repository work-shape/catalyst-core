import { History, MoreHorizontal, Trash2 } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import type { ConfigAssetRevision } from "@vivd-catalyst/api-client";
import {
  Banner,
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  InlineError,
  KeyValue,
  KeyValueList,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger
} from "@vivd-catalyst/ui";
import { instanceSentence, PendingApprovalError } from "../build-area/build-refusals";
import { CopyIdItem } from "../copy-id-item";
import { useTranslation } from "../i18n";
import { PreviewPane } from "../pages/preview-pane";
import { workspaceRoutePath } from "../routes";
import { AppDraftActions } from "./actions-view";
import { useApp, useAppWrites } from "./app-data";
import { AppDraftFiles } from "./app-draft-files";
import { AppDeleteDialog, AppFrame, AppHeader, NameList } from "./app-header";
import {
  APP_RIGHT_NAMES,
  appDescription,
  appDraftRevision,
  appDraftShown,
  appManifestSummary,
  appRefusalText,
  appTitle,
  type AppManifestSummary,
  type AppRights
} from "./app-model";
import { AppEditWithAgentAction } from "./app-edit-with-agent";
import { AppPreview, AppPreviewNotice } from "./app-preview";
import { useAppsHost, type AppsWorkspace } from "./apps-host";
import { RevisionsDrawer } from "./revisions-drawer";

/** The sides of a draft: the App in its frame, its source files, and its named actions. */
const APP_DRAFT_VIEWS = ["preview", "files", "actions"] as const;
export type AppDraftView = (typeof APP_DRAFT_VIEWS)[number];

/** The revision a publish names, with what its manifest reaches. */
interface PublishAsk {
  revision: number;
  summary: AppManifestSummary;
}

/**
 * The draft of one App (layout 3): the draft revision in the frame, and the place it is
 * published, discarded or deleted from. The screen is the surface alone; the conversation
 * with the Build Agent beside it comes with PA-8. Whoever may not write the App gets the
 * sentence that the draft is not there for them, and no request for its record is made.
 */
export function AppEdit({ app }: { app: string }) {
  const { t } = useTranslation();
  const host = useAppsHost();
  const workspace = host?.workspace;
  const rights = host?.rights;
  const mayWrite = Boolean(workspace && rights?.write);
  const record = useApp(workspace?.id ?? "", app, mayWrite);
  const writes = useAppWrites(workspace?.id);
  const [turn, setTurn] = useState(0);
  const [view, setView] = useState<AppDraftView>("preview");
  const [publishAsk, setPublishAsk] = useState<PublishAsk>();
  const [discardOpen, setDiscardOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The outside hosts the shown draft lists that its frame may not call before a publish.
  const [heldBackHosts, setHeldBackHosts] = useState<readonly string[]>([]);
  // The publish was sent and waits for an approver: the live revision stays until then.
  const [publishWaits, setPublishWaits] = useState(false);
  // Each save of the draft, also the agent's from the dock, is another revision: the frame asks
  // for its address anew. The first read of the record is the revision the frame starts with.
  const draftNow = record.app ? appDraftRevision(record.app) : undefined;
  const [framedDraft, setFramedDraft] = useState(draftNow);
  if (draftNow !== framedDraft) {
    setFramedDraft(draftNow);
    if (framedDraft !== undefined) {
      setTurn((count) => count + 1);
    }
  }

  if (!host || !workspace || !rights) {
    return null;
  }
  const backToList = () => host.showRoute({ kind: "apps", collaborationWorkspaceId: workspace.id });
  const asset = record.app;
  const name = appTitle(asset, app);

  // An answer that names no draft is the published view: the draft is not this reader's.
  if (!rights.write || record.missing || (asset !== undefined && !appDraftShown(asset))) {
    return (
      <AppEditFrame name={name} workspace={workspace} rights={rights} onBack={backToList}>
        <AppPreviewNotice
          state="stopped"
          mode="draft"
          name={name}
          problem="unavailable"
          onRetry={() => undefined}
        />
      </AppEditFrame>
    );
  }

  const draft = asset ? appDraftRevision(asset) : undefined;
  const published = asset?.publishedRevision;
  const run = async (failure: "publish" | "discard" | "delete", change: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await change();
      return true;
    } catch (caught) {
      if (caught instanceof PendingApprovalError && failure === "publish") {
        setPublishWaits(true);
        return true;
      }
      const refusal = appRefusalText(caught);
      setError(
        caught instanceof PendingApprovalError
          ? t("apps.publishPending")
          : refusal
            ? t(refusal)
            : (instanceSentence(caught) ??
              t(
                failure === "publish"
                  ? "apps.publishFailed"
                  : failure === "discard"
                    ? "apps.discardFailed"
                    : "apps.deleteFailed"
              ))
      );
      return false;
    } finally {
      setBusy(false);
    }
  };
  const closeDialogs = () => {
    setPublishAsk(undefined);
    setDiscardOpen(false);
    setDeleteOpen(false);
    setError(undefined);
  };

  return (
    <>
      <AppEditFrame
        name={name}
        description={appDescription(asset?.config)}
        app={app}
        workspace={workspace}
        rights={rights}
        draftRevision={draft}
        publishedRevision={published}
        view={view}
        onViewChange={setView}
        onBack={backToList}
        onPublish={
          asset && draft !== undefined
            ? () => {
                setError(undefined);
                setPublishAsk({ revision: draft, summary: appManifestSummary(asset.config) });
              }
            : undefined
        }
        onDiscard={() => {
          setError(undefined);
          setDiscardOpen(true);
        }}
        onRevisions={() => setRevisionsOpen(true)}
        onDelete={() => {
          setError(undefined);
          setDeleteOpen(true);
        }}
      >
        {publishWaits ? (
          <Banner layout="page" className="shrink-0" data-testid="app-publish-waits">
            {t("apps.publishWaits")}
          </Banner>
        ) : null}
        {/* The preview stays mounted under the other sides, so the App keeps its state. */}
        <div className="size-full" hidden={view !== "preview"}>
          {record.failed ? (
            <PreviewPane
              source={undefined}
              state="failed"
              title={t("apps.previewOf", { name })}
              message={t("apps.failed")}
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    record.reload().catch(() => undefined);
                  }}
                >
                  {t("tryAgain")}
                </Button>
              }
            />
          ) : (
            <div className="flex size-full flex-col">
              {heldBackHosts.length > 0 ? (
                <Banner layout="page" className="shrink-0">
                  {t("apps.heldBackHosts", { hosts: heldBackHosts.join(", ") })}
                </Banner>
              ) : null}
              <div className="min-h-0 flex-1">
                <AppPreview
                  app={app}
                  mode="draft"
                  name={name}
                  turn={turn}
                  onShown={(shown) => setHeldBackHosts(shown.heldBackHosts)}
                />
              </div>
            </div>
          )}
        </div>
        {view === "files" && draft !== undefined ? (
          <AppDraftFiles
            workspaceId={workspace.id}
            app={app}
            revision={draft}
            publishedRevision={published}
          />
        ) : null}
        {view === "actions" ? <AppDraftActions app={app} rights={rights} writes={writes} /> : null}
      </AppEditFrame>
      {publishAsk ? (
        <PublishDialog
          name={name}
          workspace={workspace}
          ask={publishAsk}
          loading={busy}
          error={error}
          onConfirm={() => {
            run("publish", () => writes.publish(app, publishAsk.revision))
              .then((done) => {
                if (done) {
                  closeDialogs();
                }
              })
              .catch(() => undefined);
          }}
          onClose={closeDialogs}
        />
      ) : null}
      {discardOpen && draft !== undefined && published !== undefined ? (
        <ConfirmDialog
          open
          tone="danger"
          title={t("apps.discardTitle", { name })}
          confirmLabel={t("apps.discard")}
          loading={busy}
          onConfirm={() => {
            run("discard", () => writes.discardDraft(app, draft))
              .then((done) => {
                if (done) {
                  closeDialogs();
                  // The draft is another revision now: its frame loads what is published.
                  setTurn((count) => count + 1);
                }
              })
              .catch(() => undefined);
          }}
          onClose={closeDialogs}
        >
          {t("apps.discardBody", { number: published })}
          {error ? <InlineError className="mt-3">{error}</InlineError> : null}
        </ConfirmDialog>
      ) : null}
      {deleteOpen && asset ? (
        <AppDeleteDialog
          name={name}
          loading={busy}
          error={error}
          onConfirm={() => {
            run("delete", () => writes.remove(app, asset.revision))
              .then((done) => {
                if (done) {
                  backToList();
                }
              })
              .catch(() => undefined);
          }}
          onClose={closeDialogs}
        />
      ) : null}
      {draft !== undefined ? (
        <RevisionsDrawer
          open={revisionsOpen}
          name={name}
          draftRevision={draft}
          publishedRevision={published}
          load={(cursor) => writes.revisions(app, cursor)}
          onPublish={
            rights.publish
              ? (revision: ConfigAssetRevision) => {
                  setError(undefined);
                  setPublishAsk({
                    revision: revision.revision,
                    summary: appManifestSummary(revision.config)
                  });
                }
              : undefined
          }
          onClose={() => setRevisionsOpen(false)}
        />
      ) : null}
    </>
  );
}

/** Whether the draft holds something the published revision does not. */
export function appDraftIsAhead(
  draftRevision: number | undefined,
  publishedRevision: number | undefined
): boolean {
  return draftRevision !== undefined && draftRevision !== publishedRevision;
}

/**
 * Layout 3 for given facts: the head with the draft's number and what this reader may do, and
 * the draft under it. Publish names the number the head shows. Without the publish right the
 * button is held and the head says which right is missing. Discard is there while something is
 * published that the draft can go back to and the draft is ahead of it.
 */
export function AppEditFrame({
  name,
  description,
  app,
  workspace,
  rights,
  draftRevision,
  publishedRevision,
  view,
  children,
  onViewChange,
  onBack,
  onPublish,
  onDiscard,
  onRevisions,
  onDelete
}: {
  name: string;
  /** What the App does, in one line after its name. */
  description?: string;
  /** The id of the App. With it the head offers "Edit with the agent" and "Copy ID". */
  app?: string;
  workspace: AppsWorkspace;
  rights: AppRights;
  /** The number of the draft, once the record arrived. */
  draftRevision?: number;
  publishedRevision?: number;
  /** The side that is shown. Left out, the head has no switch. */
  view?: AppDraftView;
  children: ReactNode;
  onViewChange?(view: AppDraftView): void;
  onBack(): void;
  onPublish?: () => void;
  onDiscard?: () => void;
  onRevisions?: () => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  const missingRightId = useId();
  const known = rights.write && draftRevision !== undefined;
  const ahead = appDraftIsAhead(draftRevision, publishedRevision);
  const missingRight = known && !rights.publish;
  // Preview, Files and Actions are views of the one App: tabs under its head.
  const switchable = known && view !== undefined && onViewChange !== undefined;
  const frame = (
    <AppFrame
      label={t("apps.draftArea", { name })}
      testId="app-edit"
      header={
        <>
          <AppHeader
            name={name}
            description={description}
            state={
              known ? (
                <Badge tone={ahead ? "warning" : "neutral"} size="sm" dot>
                  {publishedRevision === undefined
                    ? t("apps.draftNotPublished")
                    : t("apps.draftRevision", { number: draftRevision })}
                </Badge>
              ) : (
                <Badge size="sm">{t("apps.draft")}</Badge>
              )
            }
            // A draft nobody published says so whatever the room: it runs nowhere yet.
            keepState={known && publishedRevision === undefined}
            backHref={workspaceRoutePath({ kind: "apps", collaborationWorkspaceId: workspace.id })}
            onBack={onBack}
            secondaryActions={
              known ? (
                <>
                  {app === undefined ? null : <AppEditWithAgentAction app={app} />}
                  {ahead && publishedRevision !== undefined ? (
                    <Button variant="outline" onClick={onDiscard}>
                      {t("apps.discard")}
                    </Button>
                  ) : null}
                </>
              ) : undefined
            }
            tabs={
              switchable ? (
                <TabsList label={t("pages.view")}>
                  <TabsTrigger value="preview">{t("pages.preview")}</TabsTrigger>
                  <TabsTrigger value="files">{t("pages.files")}</TabsTrigger>
                  <TabsTrigger value="actions">{t("apps.actions")}</TabsTrigger>
                </TabsList>
              ) : undefined
            }
            primaryAction={
              known ? (
                <Button
                  disabled={!rights.publish || !ahead}
                  aria-describedby={missingRight ? missingRightId : undefined}
                  onClick={onPublish}
                >
                  {t("apps.publish")}
                </Button>
              ) : undefined
            }
            overflow={
              known ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton label={t("apps.moreActions")} variant="outline">
                      <MoreHorizontal aria-hidden="true" />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {app === undefined ? null : <CopyIdItem id={app} />}
                    <DropdownMenuItem icon={<History aria-hidden="true" />} onSelect={onRevisions}>
                      {t("apps.revisions")}
                    </DropdownMenuItem>
                    {rights.delete ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          tone="danger"
                          icon={<Trash2 aria-hidden="true" />}
                          onSelect={onDelete}
                        >
                          {t("apps.delete")}
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : undefined
            }
          />
          {/* The head is one row; what the reader may not do is said in a line under it. */}
          {missingRight ? (
            <Banner layout="page" className="shrink-0">
              <span id={missingRightId}>
                {t("apps.publishMissingRight", { right: APP_RIGHT_NAMES.publish })}
              </span>
            </Banner>
          ) : null}
        </>
      }
    >
      {switchable ? (
        <TabsContent value={view} className="h-full min-h-0">
          {children}
        </TabsContent>
      ) : (
        children
      )}
    </AppFrame>
  );
  // The tabs hold the frame whether or not they switch: the draft's record arrives after the
  // first draw, and a frame that moved into them then would draw its head a second time.
  return (
    <Tabs
      value={view ?? "preview"}
      onValueChange={(next) =>
        onViewChange?.(APP_DRAFT_VIEWS.find((candidate) => candidate === next) ?? "preview")
      }
      className="contents"
    >
      {frame}
    </Tabs>
  );
}

/**
 * Asks once before a revision becomes what the workspace is served, and says what that
 * revision reaches: the Connections it uses and the hosts outside the instance it calls.
 */
export function PublishDialog({
  name,
  workspace,
  ask,
  loading,
  error,
  onConfirm,
  onClose
}: {
  name: string;
  workspace: AppsWorkspace;
  ask: PublishAsk;
  loading: boolean;
  error: string | undefined;
  onConfirm(): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open
      size="sm"
      title={t("apps.publishTitle", { name })}
      description={t("apps.publishBody", { number: ask.revision, workspace: workspace.name })}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" disabled={loading} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button loading={loading} onClick={onConfirm}>
            {t("apps.publish")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <KeyValueList>
          <KeyValue label={t("apps.publishConnections")}>
            <NameList names={ask.summary.connections} />
          </KeyValue>
          <KeyValue label={t("apps.publishHosts")}>
            <NameList names={ask.summary.hosts} />
          </KeyValue>
        </KeyValueList>
        {error ? <InlineError>{error}</InlineError> : null}
      </div>
    </Dialog>
  );
}
