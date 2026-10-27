import { History, Trash2 } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import type { AppPreviewResponse, ConfigAssetRevision } from "@work-shape/catalyst-api-client";
import {
  Banner,
  Badge,
  Button,
  ConfirmDialog,
  DropdownMenuItem,
  DropdownMenuSeparator,
  InlineError,
  LoadError,
  Tabs,
  TabsContent,
  TabsDisclosure,
  TabsList,
  TabsTrigger
} from "@work-shape/catalyst-ui";
import { instanceSentence, PendingApprovalError } from "../build-area/build-refusals";
import { CopyIdItem } from "../copy-id-item";
import { useTranslation } from "../../shared/i18n";
import { DraftHostsNotice } from "../pages/draft-hosts-notice";
import { PreviewPane } from "../pages/preview-pane";
import { workspaceRoutePath } from "../../shared/routes";
import { AppDraftActions } from "./actions-view";
import { useApp, useAppDataSources, useAppWrites } from "./app-data";
import { AppDraftFiles } from "./app-draft-files";
import {
  AppDataSourcesButton,
  AppDeleteDialog,
  AppFrame,
  AppHeader,
  AppStateBadge,
  type AppLiveVersion
} from "./app-header";
import {
  APP_RIGHT_NAMES,
  appDescription,
  appDraftRevision,
  appDraftShown,
  appPublishRefusal,
  appRightsOn,
  appTitle,
  type AppRights
} from "./app-model";
import { useAppEditWithAgent } from "./app-edit-with-agent";
import { AppPreview, AppPreviewNotice } from "./app-preview";
import { AskedPublishDialog, askToPublish, type PublishAsk } from "./app-publish-dialog";
import { AppStoredDataFact } from "./app-publish-data";
import { useAppsHost, type AppsWorkspace } from "./apps-host";
import { RevisionsDrawer } from "./revisions-drawer";
import { RefusalNotice } from "../refusal-notice";
import type { ToldRefusal } from "../../shared/i18n/refusals";
import { personName } from "../../shared/person-name";

/** The sides of a draft: the App in its frame, its source files, and its named actions. */
const APP_DRAFT_VIEWS = ["preview", "files", "actions"] as const;
export type AppDraftView = (typeof APP_DRAFT_VIEWS)[number];

const DETAILS_STORAGE_KEY = "vivd-catalyst:app-technical-details";

/**
 * Whether the reader last opened the technical details of a draft, its Files and Actions, in
 * this browser. They start folded: most who shape an App never read its source.
 */
function readStoredDetailsOpen(): boolean {
  try {
    return window.localStorage.getItem(DETAILS_STORAGE_KEY) === "open";
  } catch {
    return false;
  }
}

function storeDetailsOpen(open: boolean): void {
  try {
    window.localStorage.setItem(DETAILS_STORAGE_KEY, open ? "open" : "folded");
  } catch {
    // A browser that refuses storage shows the next draft folded.
  }
}

/**
 * The draft of one App (layout 3): the draft revision in the frame, and the place it is
 * published, discarded or deleted from. The screen is the surface alone; the conversation
 * with the Build Agent beside it comes with PA-8. What the reader may do is what the instance
 * says with the App's record; whoever may not write the App gets the sentence that the draft
 * is not there for them.
 */
export function AppEdit({ app }: { app: string }) {
  const { t } = useTranslation();
  const host = useAppsHost();
  const workspace = host?.workspace;
  const record = useApp(workspace?.id ?? "", app, workspace !== undefined);
  const rights = host && appRightsOn(host.rights, record.app);
  const writes = useAppWrites(workspace?.id);
  // Where the App's data comes from, as its page says to whoever uses it. Only a published
  // App has sources to read, and lines cached from an earlier record are not shown.
  const livePublished = record.app?.publishedRevision;
  const liveSources = useAppDataSources(app, livePublished !== undefined);
  const dataSources = livePublished === undefined ? undefined : liveSources;
  const [turn, setTurn] = useState(0);
  const [view, setView] = useState<AppDraftView>("preview");
  const [detailsOpen, setDetailsOpen] = useState(readStoredDetailsOpen);
  const [publishAsk, setPublishAsk] = useState<PublishAsk>();
  const [discardOpen, setDiscardOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The last refusal of a publish from the dialog: it stays in the head once the dialog closes,
  // with the way to what it names (REFUSE-1).
  const [refused, setRefused] = useState<ToldRefusal>();
  // The shown draft: the outside hosts its frame may not call before a publish, and whether the
  // viewer may allow them for their own preview.
  const [shown, setShown] = useState<AppPreviewResponse>();
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

  // A grant on this App alone can let a reader write it: the record says so once it arrives.
  if (!rights.write && record.loading) {
    return (
      <AppEditFrame name={name} workspace={workspace} rights={rights} onBack={backToList}>
        {null}
      </AppEditFrame>
    );
  }
  // A read that failed says nothing of what the reader may do: it is asked again.
  if (!rights.write && record.failed) {
    return (
      <AppEditFrame name={name} workspace={workspace} rights={rights} onBack={backToList}>
        <div className="p-(--layout-gutter)">
          <LoadError
            onRetry={() => {
              record.reload().catch(() => undefined);
            }}
          >
            {t("apps.failed")}
          </LoadError>
        </div>
      </AppEditFrame>
    );
  }
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
      const refusal = appPublishRefusal(caught, t);
      setError(
        caught instanceof PendingApprovalError
          ? t("apps.publishPending")
          : (refusal?.message ??
              instanceSentence(caught, t) ??
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
        liveVersion={asset?.liveVersion}
        draftChangedSinceLive={asset?.draftChangedSinceLive}
        dataSources={dataSources}
        view={view}
        onViewChange={setView}
        draftConfig={asset?.config}
        detailsOpen={detailsOpen}
        onDetailsOpenChange={(open) => {
          setDetailsOpen(open);
          storeDetailsOpen(open);
          if (!open) {
            setView("preview");
          }
        }}
        onBack={backToList}
        onPublish={
          asset && draft !== undefined
            ? () => {
                setError(undefined);
                setRefused(undefined);
                setPublishAsk(askToPublish(draft, published, asset.config));
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
        {refused && !publishAsk ? (
          <RefusalNotice
            layout="page"
            className="shrink-0"
            message={refused.message}
            action={refused.action}
            onOpen={host.showRoute}
          />
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
              <DraftHostsNotice
                fileSetId={shown?.fileSetId}
                heldBackHosts={shown?.heldBackHosts ?? []}
                draftHosts={shown?.draftHosts}
                fallback={
                  <Banner layout="page" className="shrink-0">
                    {t("apps.heldBackHosts", { hosts: shown?.heldBackHosts.join(", ") ?? "" })}
                  </Banner>
                }
                onAllowed={() => setTurn((count) => count + 1)}
              />
              <div className="min-h-0 flex-1">
                <AppPreview app={app} mode="draft" name={name} turn={turn} onShown={setShown} />
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
        <AskedPublishDialog
          app={app}
          name={name}
          workspace={workspace}
          ask={publishAsk}
          loading={busy}
          error={error}
          onRefusal={setRefused}
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
          {t("apps.discardBody")}
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
          loadPublications={(cursor) => writes.publications(app, cursor)}
          onPublish={
            rights.publish
              ? (revision: ConfigAssetRevision) => {
                  setError(undefined);
                  setRefused(undefined);
                  setPublishAsk(askToPublish(revision.revision, published, revision.config));
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
  liveVersion,
  draftChangedSinceLive,
  dataSources,
  view,
  draftConfig,
  detailsOpen = false,
  children,
  onViewChange,
  onDetailsOpenChange,
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
  /** The live version: its number, when and by whom it was published. */
  liveVersion?: (AppLiveVersion & { by?: string }) | undefined;
  /** Whether the draft is another revision than the live one, as the instance says it. */
  draftChangedSinceLive?: boolean | undefined;
  /** Where the App's data comes from, one sentence per filler, once it is known. */
  dataSources?: readonly string[] | undefined;
  /** The side that is shown. Left out, the head has no switch. */
  view?: AppDraftView;
  /**
   * The draft's config. A reading `sql` action adds the line on how the App reads stored data
   * once published, under the head, so it takes its room from the frame and not the preview,
   * while the draft is ahead of what is published.
   */
  draftConfig?: unknown;
  /** Files and Actions are among the tabs: the technical details are open. */
  detailsOpen?: boolean;
  children: ReactNode;
  onViewChange?(view: AppDraftView): void;
  onDetailsOpenChange?(open: boolean): void;
  onBack(): void;
  onPublish?: () => void;
  onDiscard?: () => void;
  onRevisions?: () => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  const missingRightId = useId();
  const known = rights.write && draftRevision !== undefined;
  const hasSources = dataSources !== undefined && dataSources.length > 0;
  const ahead = draftChangedSinceLive ?? appDraftIsAhead(draftRevision, publishedRevision);
  const missingRight = known && !rights.publish;
  const editWithAgent = useAppEditWithAgent(app, rights);
  const shownView = view ?? "preview";
  // Preview, Files and Actions are views of the one App: tabs under its head. Files and Actions
  // fold under "Technical details" until a developer role is named (UX audit ruling 3).
  const tabs =
    known &&
    view !== undefined &&
    onViewChange !== undefined &&
    onDetailsOpenChange !== undefined ? (
      <TabsList
        label={t("pages.view")}
        end={
          <TabsDisclosure open={detailsOpen} onOpenChange={onDetailsOpenChange}>
            {t("apps.technicalDetails")}
          </TabsDisclosure>
        }
      >
        <TabsTrigger value="preview">{t("pages.preview")}</TabsTrigger>
        {detailsOpen ? (
          <>
            <TabsTrigger value="files">{t("pages.files")}</TabsTrigger>
            <TabsTrigger value="actions">{t("apps.actions")}</TabsTrigger>
          </>
        ) : null}
      </TabsList>
    ) : undefined;
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
                // What is live, by its version, and whether the draft changed since.
                publishedRevision === undefined ? (
                  <Badge tone="neutral" size="sm" dot>
                    {t("apps.draftNotPublished")}
                  </Badge>
                ) : (
                  <span className="flex flex-wrap items-center gap-2">
                    <AppStateBadge
                      state={{ kind: "published", revision: publishedRevision, draftAhead: ahead }}
                      liveVersion={liveVersion}
                    />
                    {ahead && liveVersion ? (
                      <Badge tone="warning" size="sm" dot>
                        {t("apps.draftChangedSince", { number: liveVersion.number })}
                      </Badge>
                    ) : null}
                  </span>
                )
              ) : (
                <Badge size="sm">{t("apps.draft")}</Badge>
              )
            }
            // A draft nobody published says so whatever the room: it runs nowhere yet.
            keepState={known && publishedRevision === undefined}
            backHref={workspaceRoutePath({ kind: "apps", collaborationWorkspaceId: workspace.id })}
            onBack={onBack}
            secondaryActions={
              known && ahead && publishedRevision !== undefined
                ? [{ label: t("apps.discard"), onSelect: () => onDiscard?.() }]
                : undefined
            }
            tabs={tabs}
            primaryAction={
              known ? (
                <span className="flex items-center gap-2">
                  {hasSources ? <AppDataSourcesButton lines={dataSources} /> : null}
                  {/* A live App may be published again for another audience (SHARE-1): the
                    dialog then waits for a choice that differs from the live one. */}
                  <Button
                    disabled={!rights.publish || (!ahead && publishedRevision === undefined)}
                    aria-describedby={missingRight ? missingRightId : undefined}
                    onClick={onPublish}
                  >
                    {t("apps.publish")}
                  </Button>
                </span>
              ) : undefined
            }
            menu={
              known ? (
                <>
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
                </>
              ) : undefined
            }
          />
          {/* What a draft does, and what is live beside it, in one line under the head. */}
          {known ? (
            <Banner layout="page" className="shrink-0" data-testid="app-draft-line">
              {t("apps.draftSimulates")}
              {liveVersion?.by === undefined
                ? null
                : ` · ${t("apps.publishedBy", { name: personName(liveVersion.by, t) })}`}
            </Banner>
          ) : null}
          {/* The head is one row; what the reader may not do is said in a line under it. */}
          {missingRight ? (
            <Banner layout="page" className="shrink-0">
              <span id={missingRightId}>
                {t("apps.publishMissingRight", { right: APP_RIGHT_NAMES.publish })}
              </span>
            </Banner>
          ) : null}
          {/* The line speaks of what publishing does: once the draft is live, it is said. */}
          {ahead ? <AppStoredDataFact config={draftConfig} /> : null}
        </>
      }
    >
      {tabs === undefined ? (
        children
      ) : (
        <TabsContent value={shownView} className="h-full min-h-0">
          {children}
        </TabsContent>
      )}
    </AppFrame>
  );
  // The tabs hold the frame whether or not they switch: the draft's record arrives after the
  // first draw, and a frame that moved into them then would draw its head a second time.
  return (
    <Tabs
      value={shownView}
      onValueChange={(next) =>
        onViewChange?.(APP_DRAFT_VIEWS.find((candidate) => candidate === next) ?? "preview")
      }
      className="contents"
    >
      {frame}
      {editWithAgent.dialog}
    </Tabs>
  );
}
