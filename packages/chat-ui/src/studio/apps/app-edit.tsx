import { History, Trash2 } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import type { ConfigAssetRevision } from "@work-shape/catalyst-api-client";
import {
  Banner,
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DropdownMenuItem,
  DropdownMenuSeparator,
  InlineError,
  KeyValue,
  KeyValueList,
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
import {
  narrativeHolds,
  PublishDetails,
  PublishNarrativeReadLead,
  type PublishNarrativeRead
} from "../../shared/publish-narrative";
import { PreviewPane } from "../pages/preview-pane";
import { workspaceRoutePath } from "../../shared/routes";
import { AppDraftActions } from "./actions-view";
import {
  useApp,
  useAppPublishData,
  useAppPublishNarrative,
  useAppWrites,
  type AppAudience,
  type AppAudienceOffer,
  type AppPublishDataRead
} from "./app-data";
import { AppDraftFiles } from "./app-draft-files";
import { AppDeleteDialog, AppFrame, AppHeader, AppStateBadge, NameList } from "./app-header";
import {
  APP_RIGHT_NAMES,
  appDescription,
  appDraftRevision,
  appDraftShown,
  appManifestSummary,
  appReadsStoredData,
  appRefusalText,
  appRightsOn,
  appTitle,
  type AppManifestSummary,
  type AppRights
} from "./app-model";
import { HeadAgentAction } from "../head-agent-action";
import { useAppEditWithAgent } from "./app-edit-with-agent";
import { AppPreview, AppPreviewNotice } from "./app-preview";
import { AppPublishDataView, AppStoredDataFact } from "./app-publish-data";
import {
  AppAudienceChange,
  AppAudienceQuestion,
  appPublishBody,
  appPublishMaySend,
  useAppPublishSend,
  useSharePublishQuestion
} from "./app-publish-question";
import { useAppsHost, type AppsWorkspace } from "./apps-host";
import { RevisionsDrawer } from "./revisions-drawer";

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

/** The revision a publish names, with what its manifest reaches. */
interface PublishAsk {
  revision: number;
  /** The live revision, where one is: publishing it again may change only its audience. */
  live?: number | undefined;
  summary: AppManifestSummary;
  /** Its manifest has a reading `sql` action: the question names who sees which stored data. */
  readsStoredData: boolean;
}

/** What the config of the revision a publish names asks the question to say. */
function askToPublish(revision: number, live: number | undefined, config: unknown): PublishAsk {
  return {
    revision,
    live,
    summary: appManifestSummary(config),
    readsStoredData: appReadsStoredData(config)
  };
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
  const [turn, setTurn] = useState(0);
  const [view, setView] = useState<AppDraftView>("preview");
  const [detailsOpen, setDetailsOpen] = useState(readStoredDetailsOpen);
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
        <AskedPublishDialog
          app={app}
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
  const ahead = appDraftIsAhead(draftRevision, publishedRevision);
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
                // A draft that is what is published says so, as the list and the App do.
                publishedRevision !== undefined && !ahead ? (
                  <AppStateBadge
                    state={{ kind: "published", revision: publishedRevision, draftAhead: false }}
                  />
                ) : (
                  <Badge tone={ahead ? "warning" : "neutral"} size="sm" dot>
                    {publishedRevision === undefined
                      ? t("apps.draftNotPublished")
                      : t("apps.draftRevision", { number: draftRevision })}
                  </Badge>
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
                  {editWithAgent.action === undefined ? null : (
                    <HeadAgentAction action={editWithAgent.action} />
                  )}
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

/** A dialog asked without the instance's sentence, as in a sample. */
const NO_NARRATIVE: PublishNarrativeRead = { status: "none" };

type PublishDialogProps = {
  name: string;
  workspace: AppsWorkspace;
  ask: PublishAsk;
  loading: boolean;
  error: string | undefined;
  onConfirm(): void;
  onClose(): void;
};

/** "For whom?" as the dialog holds it: the instance's offer and the choice shown. */
interface PublishAudienceAsk {
  /** Absent while the first answer loads, and where the instance offers no choice. */
  offer: AppAudienceOffer | undefined;
  selected: AppAudience | undefined;
  onChange(audience: AppAudience): void;
}

/**
 * The Publish dialog for the revision it asks about, which sends the publish itself with the
 * audience chosen in "For whom?" (SHARE-1). The sentence and the lines on who sees which stored
 * data are read for that revision's number and that audience, whether it is the draft, the
 * first publish or an older revision from the revisions drawer. A publish held for approval
 * says so in the dialog, and Close leaves it.
 */
function AskedPublishDialog({ app, ...props }: PublishDialogProps & { app: string }) {
  const [chosen, setChosen] = useState<AppAudience>();
  const question = useAppPublishNarrative(props.workspace.id, app, props.ask.revision, chosen);
  const publishing = useAppPublishSend(props.workspace.id, app);
  // What is sent is what is shown: the choice, or the audience the instance proposed.
  const selected = chosen ?? question.audience?.selected;
  const shared = {
    ...props,
    loading: publishing.busy,
    error: publishing.error,
    waits: publishing.waits,
    narrative: question.narrative,
    audience: {
      offer: question.audience,
      selected,
      onChange: setChosen
    },
    onConfirm: () => {
      publishing
        .send(props.ask.revision, question.audience === undefined ? undefined : selected)
        .then((outcome) => {
          // A held publish stays in the dialog, which says it waits; Close leaves it.
          if (outcome === "published") props.onClose();
        })
        .catch(() => undefined);
    }
  };
  return props.ask.readsStoredData ? (
    <PublishDialogWithData app={app} {...shared} />
  ) : (
    <PublishDialog {...shared} />
  );
}

function PublishDialogWithData({
  app,
  ...props
}: Parameters<typeof PublishDialog>[0] & { app: string }) {
  return <PublishDialog {...props} storedData={useAppPublishData(app, props.ask.revision)} />;
}

/**
 * Publish of an App's draft from outside its page, as "Share" on the line a save leaves in the
 * conversation: the same dialog, once the draft is read, for a reader who may publish. It also
 * asks where the draft is what is live, so only who it is for can change.
 */
export function SharePublishDialog({ app, onClose }: { app: string; onClose(): void }) {
  const share = useSharePublishQuestion(app, onClose);
  return share ? (
    <AskedPublishDialog
      app={app}
      {...share}
      loading={false}
      error={undefined}
      onConfirm={() => undefined}
      onClose={onClose}
    />
  ) : null;
}

/**
 * Asks once before a revision becomes what its audience is served. It opens with "For whom?"
 * (SHARE-1) where the instance offers the choice, then says what that revision reaches for the
 * audience chosen: the instance's sentence, the Connections it uses, the hosts outside the
 * instance it calls and, where it reads stored data, who sees which (DS-13b). Publish waits
 * until those lines are there for the choice shown: the question is not asked without them.
 */
export function PublishDialog({
  name,
  workspace,
  ask,
  loading,
  error,
  storedData,
  narrative = NO_NARRATIVE,
  audience,
  waits = false,
  onConfirm,
  onClose
}: PublishDialogProps & {
  /** The lines on stored data, read for `ask.revision`. Absent where it reads none. */
  storedData?: AppPublishDataRead;
  /** The instance's sentence on the publish, read for `ask.revision` and the audience shown. */
  narrative?: PublishNarrativeRead;
  /** "For whom?". Absent, as in a sample, the dialog asks as before SHARE-1. */
  audience?: PublishAudienceAsk;
  /** The publish was sent and waits for an approver. */
  waits?: boolean;
}) {
  const { t } = useTranslation();
  const offer = audience?.offer;
  const selected = audience?.selected;
  // The offer names the people of the audience it was read for; for another choice it waits.
  const audienceLabel = offer && offer.selected === selected ? offer.label : undefined;
  const waitsForData =
    (storedData !== undefined && storedData.status !== "ready") ||
    narrativeHolds(narrative) ||
    (offer !== undefined && audienceLabel === undefined);
  // The live revision for its own audience again changes nothing: Publish waits for a change.
  const changes = appPublishMaySend(ask, offer, selected);
  const body = appPublishBody(offer ? selected : undefined, ask.revision, workspace.name, t);
  const lists = (
    <KeyValueList>
      <KeyValue label={t("apps.publishConnections")}>
        <NameList names={ask.summary.connections} />
      </KeyValue>
      <KeyValue label={t("apps.publishHosts")}>
        <NameList names={ask.summary.hosts} />
      </KeyValue>
      {storedData ? (
        <AppPublishDataView
          read={storedData}
          audienceLabel={audienceLabel}
          audiencePeople={selected === "self" ? undefined : offer?.people}
          audiencePending={offer !== undefined && audienceLabel === undefined}
        />
      ) : null}
    </KeyValueList>
  );
  return (
    <Dialog
      open
      size="sm"
      title={t("apps.publishTitle", { name })}
      {...(narrative.status === "none" && offer === undefined ? { description: body } : {})}
      onClose={onClose}
      footer={
        waits ? (
          <Button variant="outline" onClick={onClose}>
            {t("close")}
          </Button>
        ) : (
          <>
            <Button variant="outline" disabled={loading} onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button loading={loading} disabled={waitsForData || !changes} onClick={onConfirm}>
              {t("apps.publish")}
            </Button>
          </>
        )
      }
    >
      <div className="grid gap-4">
        {offer && selected !== undefined ? (
          <AppAudienceQuestion
            offer={offer}
            selected={selected}
            workspaceName={workspace.name}
            disabled={loading || waits}
            onChange={(next) => audience?.onChange(next)}
          />
        ) : null}
        <AppAudienceChange offer={offer} selected={selected} workspaceName={workspace.name} />
        <div className="grid gap-3">
          <PublishNarrativeReadLead read={narrative} />
          {narrative.status === "none" && offer === undefined ? (
            lists
          ) : (
            // The sentence leads; which revision goes live for whom is a detail of it.
            <PublishDetails>
              <p className="text-body text-muted-foreground" data-testid="app-publish-body">
                {body}
              </p>
              {lists}
            </PublishDetails>
          )}
          {waits ? <Banner data-testid="app-publish-waits">{t("apps.publishWaits")}</Banner> : null}
          {error ? <InlineError>{error}</InlineError> : null}
        </div>
      </div>
    </Dialog>
  );
}
