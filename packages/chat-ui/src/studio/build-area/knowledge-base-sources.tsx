import {
  Folder,
  FolderOpen,
  FolderSync,
  Globe,
  Play,
  Plug,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
  X
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from "react";
import {
  Badge,
  Banner,
  Button,
  Chip,
  Dialog,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  EmptyState,
  Field,
  FormNotice,
  IconButton,
  IconTile,
  KeyValue,
  KeyValueList,
  List,
  Picker,
  PickerButton,
  ServiceMark,
  Spinner,
  TextLink,
  Textarea
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { formatElapsed, formatMomentShort } from "../../shared/locale-format";
import type {
  KnowledgeBaseSource,
  KnowledgeChoice,
  KnowledgeRead,
  KnowledgeSourceFailureCode,
  KnowledgeSourceStatus
} from "./knowledge-base-source";
import {
  sourceDraftChange,
  sourceFailureText,
  sourceItemCounts,
  sourceLiveLine,
  sourceStateView
} from "./knowledge-source-status";
import {
  newKnowledgeSource,
  sourceFolderIds,
  WEB_SOURCE_CONNECTOR_TYPE,
  type KnowledgeSourceForm
} from "./knowledge-sources-model";
import {
  KnowledgeSourceExcludedFolders,
  KnowledgeSourceExcludedSuffix,
  KnowledgeSourceFolderPicker
} from "./knowledge-source-folder-picker";
import {
  intervalWords,
  KnowledgeSourceSchedule,
  scheduleDefaults,
  sourceScheduleSentence,
  type SourceScheduleDefaults
} from "./knowledge-source-schedule";
import { scheduleInWords } from "../workflows/schedule-words";
import type { ActionNotice } from "./build-model";
import { useOptionalBuildNavigation } from "../../shared/build-route";
import { requestBuildCreateDialog } from "./build-create-request";
import { CONNECTIONS_BUILD_PATH } from "./connection-tools";
import { offerText } from "./connection-typed-model";
import { markArt } from "./my-connections-model";
import type { PagedItems } from "./paged-items";
import { DataFlowRow, type DataFlowPage } from "./data-flows";
import type { DataFlowRef } from "./data-flows-model";
import { formatEmbeddingCost, formatStoreBytes } from "./knowledge-cost";

// The synced sources of a Knowledge Base of documents (SRC-2): each reads the folders it names
// through a Connection whose type is a document source. The list is part of the draft: a source
// added, narrowed or removed takes effect at publish, where the question names who finds what.
// Once published, each shows how far its sync is, why items failed, and for who may change the
// Knowledge Base, Sync now and Try again. Its card says in one line what the published source
// does right now: the sync that runs and how far it is, or when it last synced and when it syncs
// next. Where the draft sets a source otherwise than the published revision, which is the one
// that syncs, the card says the change is not active yet, with Publish for who may.
// A Workflow that calls `ingest` is a source of its own (KBW-1): it is never authored in the
// draft, so it is listed from the published state alone, with its Workflow, its last run and
// how fresh that makes it. Its Workflow's runs decide what it holds, so it has no Sync now and
// no Try again here. A document a person removed by hand stays out of every later run; only
// who may publish the Knowledge Base lets it back in, with Allow again (KBW-2b).

/**
 * The ids of the synced sources whose documents keep no copy of their file here, as the list
 * of documents read them: such a source says once where the originals are.
 */
export const ReleasedSourcesContext = createContext<ReadonlySet<string>>(new Set());

/** The search of the Connection chooser before the reader types. */
const NO_SEARCH = "";

/** How often a card says anew how long ago its source synced and when it syncs next. */
const LIVE_CLOCK_MS = 30_000;

/** The time, counted again every half minute while `ticking`. Nothing is read for it. */
function useLiveClock(ticking: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!ticking) return undefined;
    setNow(new Date());
    const interval = window.setInterval(() => setNow(new Date()), LIVE_CLOCK_MS);
    return () => window.clearInterval(interval);
  }, [ticking]);
  return now;
}

export function KnowledgeSourcesSection({
  source,
  knowledgeBase,
  published,
  owner,
  sources,
  canWrite,
  canPublish = false,
  workflows,
  workflowPage,
  adding = true,
  layout = "cards",
  live,
  publish,
  onChange
}: {
  source: KnowledgeBaseSource;
  /** The Knowledge Base's id, once it is created. */
  knowledgeBase: string | undefined;
  /** The published revision, whose sources sync. */
  published: number | undefined;
  /** The workspace that owns the Knowledge Base, absent for one of the instance. */
  owner: string | undefined;
  sources: readonly KnowledgeSourceForm[];
  canWrite: boolean;
  /** Who may publish lifts the hold on Workflow-fed documents removed by hand. */
  canPublish?: boolean;
  /** The Workflows that fill the Knowledge Base, by which a Workflow-fed source is titled. */
  workflows?: readonly DataFlowRef[];
  workflowPage?: DataFlowPage;
  /**
   * Whether the section offers to add a source. The page of a new Knowledge Base adds its
   * source with the choice of where its documents come from instead.
   */
  adding?: boolean;
  /**
   * `cards` frames each source and says so where none is listed; `rows` puts them as the first
   * rows of the list they stand in, and shows nothing where none is listed.
   */
  layout?: "cards" | "rows";
  /**
   * The sources as the published revision names them, which is the one that syncs. A source the
   * draft sets otherwise says its change is not active yet. Absent until they are known.
   */
  live?: readonly KnowledgeSourceForm[];
  /**
   * The page's publish of the saved draft, for a reader who may publish it: offered beside a
   * change that is not active yet.
   */
  publish?: { open(): void; unsaved: boolean };
  onChange(sources: KnowledgeSourceForm[]): void;
}) {
  const { t } = useTranslation();
  // The sources the page opened with: one added since unfolds, as its folders are chosen next.
  const [opened] = useState(() => new Set(sources.map((entry) => entry.id)));
  const rows = layout === "rows";
  // The published revision's sources: one the draft adds is not among them before its publish.
  const status = source.useSources?.(
    knowledgeBase ?? "",
    knowledgeBase === undefined ? undefined : published
  );
  const statusOf = (id: string): KnowledgeSourceStatus | undefined =>
    status?.status === "ready"
      ? status.data.sources.find(
          (entry): entry is KnowledgeSourceStatus => "id" in entry && entry.id === id
        )
      : undefined;
  const now = useLiveClock(status?.status === "ready");
  const fedByWorkflows =
    status?.status === "ready" && knowledgeBase !== undefined && published !== undefined
      ? status.data.sources.filter((entry): entry is WorkflowSourceStatus => "workflowId" in entry)
      : [];
  // As rows of the documents, one synced source alone has its Sync now as the main action over
  // the list; several each keep their own.
  const syncInRow =
    !rows ||
    (status?.status === "ready" &&
      status.data.sources.filter((entry) => !("workflowId" in entry)).length > 1);
  const change = (id: string, patch: Partial<KnowledgeSourceForm>) =>
    onChange(sources.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  const [search, setSearch] = useState(NO_SEARCH);
  const read = source.useSourceConnections?.(search, owner);
  // What each source's Connection is, whatever the reader searches for in the chooser.
  const known = source.useSourceConnections?.(NO_SEARCH, owner);
  const choiceOf = (connection: string): KnowledgeChoice | undefined =>
    known?.status === "ready"
      ? known.data.items.find((choice) => choice.name === connection)
      : undefined;
  // The folder chooser of one source. A new source whose folders can be chosen by name opens
  // it at once: choosing its folders is the next step.
  const [picking, setPicking] = useState<string>();
  // Each source is looked at once: one that has folders, as every saved one does, is left alone.
  const seen = useRef(new Set<string>());
  useEffect(() => {
    // Until the Connections are read, nobody knows which sources can choose folders by name.
    if (known?.status !== "ready") return;
    for (const entry of sources) {
      if (seen.current.has(entry.id)) continue;
      seen.current.add(entry.id);
      if (canWrite && entry.folders.trim() === "" && choiceOf(entry.connection)?.browsesFolders) {
        setPicking(entry.id);
      }
    }
  });
  const pickingEntry = sources.find((entry) => entry.id === picking);
  const pickingChoice = pickingEntry && choiceOf(pickingEntry.connection);
  // Where no Connection can be chosen at all, one neutral line says what to connect first,
  // instead of an empty list, an empty chooser and its error.
  const noneToChoose =
    canWrite && read?.status === "ready" && read.data.items.length === 0 && search === NO_SEARCH;
  if (rows && sources.length === 0 && fedByWorkflows.length === 0) return null;
  return (
    <div className={rows ? "grid min-w-0" : "grid gap-4"} data-knowledge-sources="">
      {fedByWorkflows.length > 0 ? (
        <ul
          aria-label={t("knowledgeSources.workflowSources")}
          className={rows ? "grid min-w-0" : "grid gap-3"}
        >
          {fedByWorkflows.map((entry) => (
            <WorkflowSourceItem
              key={entry.id}
              source={source}
              knowledgeBase={knowledgeBase ?? ""}
              status={entry}
              workflow={workflows?.find((flow) => flow.name === entry.workflowId)}
              page={workflowPage?.(entry.workflowId)}
              canPublish={canPublish}
              rows={rows}
            />
          ))}
        </ul>
      ) : null}
      {(rows || noneToChoose || fedByWorkflows.length > 0) &&
      sources.length === 0 ? null : sources.length === 0 ? (
        <EmptyState layout="inline">
          {t(canWrite ? "knowledgeSources.empty" : "knowledgeSources.emptyReadOnly")}
        </EmptyState>
      ) : (
        <ul
          aria-label={t("knowledgeSources.title")}
          className={rows ? "grid min-w-0" : "grid gap-3"}
        >
          {sources.map((entry) => (
            <SourceItem
              key={entry.id}
              source={source}
              entry={entry}
              rows={rows}
              status={
                knowledgeBase === undefined || published === undefined
                  ? undefined
                  : statusOf(entry.id)
              }
              now={now}
              draftChange={
                knowledgeBase === undefined || published === undefined
                  ? undefined
                  : sourceDraftChange(entry, live)
              }
              publish={publish}
              startsOpen={knowledgeBase === undefined || !opened.has(entry.id)}
              choice={choiceOf(entry.connection)}
              defaults={scheduleDefaults(statusOf(entry.id)?.schedule, choiceOf(entry.connection))}
              canWrite={canWrite}
              onPick={() => setPicking(entry.id)}
              onChange={(patch) => change(entry.id, patch)}
              onRemove={() => onChange(sources.filter((other) => other.id !== entry.id))}
            >
              {knowledgeBase === undefined ||
              published === undefined ||
              (status?.status === "ready" && statusOf(entry.id) === undefined) ? (
                <p className="text-caption text-muted-foreground">
                  {t("knowledgeSources.notPublished")}
                </p>
              ) : status?.status === "failed" || status?.status === "refused" ? (
                <p className="text-caption text-muted-foreground">
                  {t(
                    status.status === "refused"
                      ? "knowledgeSources.statusRefused"
                      : "knowledgeSources.statusFailed"
                  )}
                </p>
              ) : (
                <SourceStatus
                  source={source}
                  knowledgeBase={knowledgeBase}
                  sourceId={entry.id}
                  status={statusOf(entry.id)}
                  canWrite={canWrite}
                  canConfirm={canPublish}
                  syncShown={syncInRow}
                  // The rows above say how it syncs; the published way is named only where a
                  // change to them waits for its publish, and where it does not sync by itself.
                  scheduleShown={!publishedAsSet(entry.schedule, statusOf(entry.id)?.schedule)}
                />
              )}
            </SourceItem>
          ))}
        </ul>
      )}
      {pickingEntry && pickingChoice ? (
        <KnowledgeSourceFolderPicker
          source={source}
          connection={pickingEntry.connection}
          connectionTitle={pickingChoice.title || pickingChoice.name}
          chosen={sourceFolderIds(pickingEntry.folders)}
          exclude={pickingEntry.exclude}
          onClose={() => setPicking(undefined)}
          onChoose={(folders, exclude) => {
            change(pickingEntry.id, { folders: folders.join("\n"), exclude });
            setPicking(undefined);
          }}
        />
      ) : null}
      {!adding ? null : noneToChoose ? (
        <NoSourceConnection source={source} />
      ) : canWrite && read !== undefined ? (
        <>
          <AddSource
            read={read}
            onSearchChange={setSearch}
            onAdd={(connection) =>
              onChange([
                ...sources,
                newKnowledgeSource(connection, sources, choiceOf(connection)?.connectorType)
              ])
            }
          />
          <p className="text-caption text-muted-foreground">{t("knowledgeSources.draftNote")}</p>
        </>
      ) : null}
    </div>
  );
}

/**
 * One source of the draft: its Connection, its folders and its patterns. Where the Connection
 * lets the reader choose folders by name, the folders stand by their paths with a button to
 * choose them; their ids and the patterns wait under Advanced settings.
 */
function SourceItem({
  source,
  entry,
  choice,
  defaults,
  canWrite,
  rows,
  status,
  now,
  draftChange,
  publish,
  startsOpen,
  onPick,
  onChange,
  onRemove,
  children
}: {
  source: KnowledgeBaseSource;
  entry: KnowledgeSourceForm;
  /** A row of the list it stands in, not a card of its own. */
  rows: boolean;
  /** How its sync stands, once published and read. */
  status: KnowledgeSourceStatus | undefined;
  /** The time its line counts from. */
  now: Date;
  /** What of it the draft changed and the published revision, which syncs, does not hold yet. */
  draftChange: ReturnType<typeof sourceDraftChange>;
  /** The page's publish, for a reader who may publish the draft. */
  publish: { open(): void; unsaved: boolean } | undefined;
  /** Unfolded from the start: a source the page did not open with, or of a new Knowledge Base. */
  startsOpen: boolean;
  /** The Connection as the list names it, once read. */
  choice: KnowledgeChoice | undefined;
  /** What the source takes where it sets nothing, as far as it is known. */
  defaults: SourceScheduleDefaults;
  canWrite: boolean;
  /** Opens the folder chooser of this source. */
  onPick(): void;
  onChange(patch: Partial<KnowledgeSourceForm>): void;
  onRemove(): void;
  children: ReactNode;
}) {
  const translation = useTranslation();
  const { locale, t } = translation;
  // A source of public web pages names addresses instead of folders (KB-WEB).
  const web = entry.web === true || choice?.connectorType === WEB_SOURCE_CONNECTOR_TYPE;
  const browses = !web && choice?.browsesFolders === true;
  const folders = sourceFolderIds(entry.folders);
  // Folded until the reader asks, unless something in it needs a person.
  const [open, setOpen] = useState<boolean>();
  // Only a confirmation waits for the reader here. Failed documents stand first in the list
  // with their fix, so the row counts them and stays folded; its toggle then says it leads to the
  // failures, since a fetch failure has no document row and its fix lives in here.
  const needsPerson = status?.confirmation !== undefined;
  const failed = status === undefined ? 0 : sourceItemCounts(status.items).failed;
  const released = useContext(ReleasedSourcesContext).has(entry.id);
  const unfolded = open ?? (startsOpen || needsPerson);
  const view = status === undefined ? undefined : sourceStateView(status);
  // What the published source does right now. The line names a sync that runs, so the badge
  // beside the name says only what the line does not.
  const liveLine = status === undefined ? undefined : sourceLiveLine(status, now, translation);
  const runs = status?.running !== undefined && liveLine !== undefined;
  const connectionTitle = choice?.title || entry.connection;
  const titleId = useId();
  const searchable = status === undefined ? undefined : sourceItemCounts(status.items).searchable;
  // The service the folders come from, where the Connection was installed for one: its mark
  // and name lead the row, and the Connection stands under it.
  const service = web ? undefined : choice?.service;
  const navigation = useOptionalBuildNavigation();
  const connectionPage =
    !web && choice?.opens === true && navigation
      ? { kindPath: CONNECTIONS_BUILD_PATH, name: entry.connection }
      : undefined;
  const facts = [
    ...(searchable === undefined
      ? []
      : [
          searchable === 1
            ? t("knowledgeSources.rowDocument")
            : t("knowledgeSources.rowDocuments", {
                count: new Intl.NumberFormat(locale).format(searchable)
              })
        ]),
    ...(released
      ? [t("knowledgeSources.rowOriginals", { connection: service?.title ?? connectionTitle })]
      : [])
  ].join(" · ");
  const addressField = (key: "pages" | "prefixes" | "sitemaps") => (
    <Field label={t(`knowledgeSources.${key}`)} hint={t(`knowledgeSources.${key}Hint`)} optional>
      <Textarea
        rows={key === "sitemaps" ? 1 : 2}
        spellCheck={false}
        placeholder={t("knowledgeSources.addressPlaceholder")}
        value={entry[key] ?? ""}
        readOnly={!canWrite}
        data-knowledge-source-field={key}
        onChange={(event) => onChange({ web: true, [key]: event.target.value })}
      />
    </Field>
  );
  const idsField = (
    <Field
      label={t("knowledgeSources.folders")}
      hint={t("knowledgeSources.foldersHint")}
      required={!browses}
    >
      <Textarea
        rows={2}
        required={!browses}
        spellCheck={false}
        value={entry.folders}
        readOnly={!canWrite}
        data-knowledge-source-field="folders"
        onChange={(event) => onChange({ folders: event.target.value })}
      />
    </Field>
  );
  const patternFields = (
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <Field
        label={t(web ? "knowledgeSources.includeWeb" : "knowledgeSources.include")}
        hint={t(web ? "knowledgeSources.includeWebHint" : "knowledgeSources.includeHint")}
        optional
      >
        <Textarea
          rows={2}
          spellCheck={false}
          value={entry.include}
          readOnly={!canWrite}
          data-knowledge-source-field="include"
          onChange={(event) => onChange({ include: event.target.value })}
        />
      </Field>
      <Field
        label={t("knowledgeSources.exclude")}
        hint={t(web ? "knowledgeSources.excludeWebHint" : "knowledgeSources.excludeHint")}
        optional
      >
        <Textarea
          rows={2}
          spellCheck={false}
          value={entry.exclude}
          readOnly={!canWrite}
          data-knowledge-source-field="exclude"
          onChange={(event) => onChange({ exclude: event.target.value })}
        />
      </Field>
    </div>
  );
  return (
    <li
      className={
        rows ? "min-w-0 border-b bg-muted/50 px-3 py-3" : "min-w-0 rounded-md border px-4 py-3"
      }
      data-knowledge-source={entry.id}
      // A field the browser refuses while the source is folded is shown, then named again.
      onInvalidCapture={(event) => {
        if (unfolded) return;
        setOpen(true);
        const form = event.currentTarget.closest("form");
        requestAnimationFrame(() => form?.reportValidity());
      }}
    >
      <Disclosure open={unfolded} onOpenChange={setOpen}>
        <div className="flex min-w-0 items-start gap-3">
          {service ? (
            <ServiceMark
              name={service.title}
              size="lg"
              showName={false}
              {...markArt(service.mark)}
            />
          ) : (
            <IconTile>
              {web ? <Globe aria-hidden="true" /> : <Folder aria-hidden="true" />}
            </IconTile>
          )}
          <div className="grid min-w-0 flex-1 gap-0.5" data-knowledge-source-origin="">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span id={titleId} className="min-w-0 text-body font-medium wrap-anywhere">
                {service?.title ?? connectionTitle}
              </span>
              {view === undefined || view.state === "current" || runs ? null : (
                <Badge tone={view.tone} dot>
                  {t(view.label)}
                </Badge>
              )}
              {failed > 0 ? (
                <Badge tone="danger" dot data-knowledge-source-failed="">
                  {t("knowledgeSources.failedCount", {
                    count: new Intl.NumberFormat(locale).format(failed)
                  })}
                </Badge>
              ) : null}
            </div>
            {/* The Connection the folders are read through: named under a service, and a link
                to its page for who may open it. */}
            {service || connectionPage ? (
              <span
                className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-caption text-muted-foreground"
                data-knowledge-source-connection={entry.connection}
              >
                <Plug aria-hidden="true" className="size-3.5 shrink-0" />
                {connectionPage && navigation ? (
                  <TextLink
                    className="min-w-0 underline decoration-muted-foreground wrap-anywhere"
                    href={navigation.href(connectionPage)}
                    onClick={(event) => {
                      if (!opensHere(event)) return;
                      event.preventDefault();
                      navigation.open(connectionPage);
                    }}
                  >
                    {service
                      ? t("knowledgeSources.viaConnection", { connection: connectionTitle })
                      : t("knowledgeSources.openConnection")}
                  </TextLink>
                ) : (
                  <span className="min-w-0 wrap-anywhere">
                    {t("knowledgeSources.viaConnection", { connection: connectionTitle })}
                  </span>
                )}
              </span>
            ) : null}
            {folders.length === 0 ? null : !browses ? (
              <span
                className="flex min-w-0 items-center gap-1 text-caption text-foreground"
                data-knowledge-source-paths=""
              >
                <Folder aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                {folders.length === 1
                  ? t("knowledgeSources.pickCountOne")
                  : t("knowledgeSources.pickCount", {
                      count: new Intl.NumberFormat(locale).format(folders.length)
                    })}
              </span>
            ) : (
              <ul
                className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-caption text-foreground"
                aria-label={t("knowledgeSources.chosenFolders")}
                data-knowledge-source-paths=""
              >
                {folders.map((folder, index) => (
                  <li key={folder} className="flex min-w-0 items-center gap-1">
                    <Folder
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 wrap-anywhere">
                      <FolderName source={source} connection={entry.connection} folder={folder} />
                      {index === folders.length - 1 ? (
                        <KnowledgeSourceExcludedSuffix exclude={entry.exclude} />
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {facts === "" ? null : (
              <span className="text-caption text-muted-foreground">{facts}</span>
            )}
            {liveLine === undefined ? null : (
              <p
                className="flex min-w-0 items-center gap-1.5 text-caption text-foreground"
                data-knowledge-source-live={runs ? "running" : "idle"}
              >
                {runs ? <Spinner size="xs" aria-hidden="true" /> : null}
                <span className="min-w-0">{liveLine}</span>
              </p>
            )}
            <p className="text-caption text-muted-foreground" data-knowledge-source-sentence="">
              {sourceScheduleSentence(entry.schedule, defaults, web, translation)}
            </p>
          </div>
          <DisclosureTrigger
            className="shrink-0 text-caption"
            // Each row's toggle is told apart by the folder or Connection it adjusts.
            aria-describedby={titleId}
            data-knowledge-source-adjust=""
          >
            {t(
              failed > 0
                ? "knowledgeSources.reviewFailures"
                : canWrite
                  ? "knowledgeSources.adjust"
                  : "knowledgeSources.details"
            )}
          </DisclosureTrigger>
        </div>
        {draftChange === undefined ? null : (
          <Banner
            tone="warning"
            className="mt-3"
            data-knowledge-source-draft={draftChange}
            action={
              publish ? (
                <Button
                  size="sm"
                  disabled={publish.unsaved}
                  title={publish.unsaved ? t("build.publishSaveFirst") : undefined}
                  data-knowledge-source-publish=""
                  onClick={publish.open}
                >
                  <Send aria-hidden="true" />
                  {t("build.publish")}
                </Button>
              ) : undefined
            }
          >
            {t(
              draftChange === "folders"
                ? "knowledgeSources.draftFolders"
                : draftChange === "addresses"
                  ? "knowledgeSources.draftAddresses"
                  : "knowledgeSources.draftSettings"
            )}
          </Banner>
        )}
        {/* Kept in the page while folded: its fields are part of the form. */}
        <DisclosureContent keepMounted>
          <div className="grid min-w-0 gap-3 pt-3">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <KeyValueList layout="stacked">
                <KeyValue label={t("knowledgeSources.connection")}>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Plug aria-hidden="true" className="size-4 shrink-0" />
                    {choice?.title ? (
                      <span className="min-w-0 break-words">{choice.title}</span>
                    ) : (
                      <code className="min-w-0 break-all font-mono text-code">
                        {entry.connection}
                      </code>
                    )}
                  </span>
                </KeyValue>
              </KeyValueList>
              {canWrite ? (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t("knowledgeSources.removeLabel", { id: entry.id })}
                  data-knowledge-source-remove=""
                  onClick={onRemove}
                >
                  <Trash2 aria-hidden="true" />
                  {t("knowledgeSources.remove")}
                </Button>
              ) : null}
            </div>
            {web ? (
              <div className="grid min-w-0 gap-3" data-knowledge-source-web="">
                {addressField("pages")}
                {addressField("prefixes")}
              </div>
            ) : browses ? (
              <Field label={t("knowledgeSources.chosenFolders")} required>
                <div className="grid min-w-0 gap-2" data-knowledge-source-folders="">
                  {folders.length === 0 ? (
                    <p className="text-caption text-muted-foreground">
                      {t("knowledgeSources.noFolderChosen")}
                    </p>
                  ) : (
                    <ul className="grid min-w-0 gap-1">
                      {folders.map((folder) => (
                        <li key={folder} className="flex min-w-0 items-center gap-2">
                          <Folder
                            aria-hidden="true"
                            className="size-4 shrink-0 text-muted-foreground"
                          />
                          <FolderPath
                            source={source}
                            connection={entry.connection}
                            folder={folder}
                          />
                          {canWrite ? (
                            <IconButton
                              variant="ghost"
                              size="sm"
                              label={t("knowledgeSources.removeFolder")}
                              onClick={() =>
                                onChange({
                                  folders: folders.filter((other) => other !== folder).join("\n")
                                })
                              }
                            >
                              <X aria-hidden="true" />
                            </IconButton>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                  <KnowledgeSourceExcludedFolders
                    exclude={entry.exclude}
                    canWrite={canWrite}
                    onChange={(exclude) => onChange({ exclude })}
                  />
                  {canWrite ? (
                    <div>
                      <Button
                        variant="outline"
                        size="sm"
                        data-knowledge-source-pick=""
                        onClick={onPick}
                      >
                        <FolderOpen aria-hidden="true" />
                        {t("knowledgeSources.pickFolders")}
                      </Button>
                    </div>
                  ) : null}
                </div>
              </Field>
            ) : (
              idsField
            )}
            <KnowledgeSourceSchedule
              schedule={entry.schedule}
              defaults={defaults}
              web={web}
              readOnly={!canWrite}
              onChange={(schedule) => onChange({ schedule })}
            />
            <Disclosure data-knowledge-source-advanced="">
              <DisclosureTrigger className="text-caption">
                {t("knowledgeSources.advanced")}
              </DisclosureTrigger>
              <DisclosureContent>
                <div className="grid min-w-0 gap-3 pt-2">
                  {browses ? idsField : null}
                  {web ? addressField("sitemaps") : null}
                  {patternFields}
                </div>
              </DisclosureContent>
            </Disclosure>
            {children}
          </div>
        </DisclosureContent>
      </Disclosure>
    </li>
  );
}

/** A chosen folder as the row names it: its path at the source, or its id until that is read. */
function FolderName({
  source,
  connection,
  folder
}: {
  source: KnowledgeBaseSource;
  connection: string;
  folder: string;
}) {
  const read = source.useSourceFolders?.(connection, folder, true);
  return <>{read?.status === "ready" ? read.data.folder.path : folder}</>;
}

/** A chosen folder by its path at the source, or by its id until that is read. */
function FolderPath({
  source,
  connection,
  folder
}: {
  source: KnowledgeBaseSource;
  connection: string;
  folder: string;
}) {
  const read = source.useSourceFolders?.(connection, folder, true);
  return (
    <span
      className="min-w-0 flex-1 truncate text-body"
      title={folder}
      data-knowledge-source-folder={folder}
    >
      {read?.status === "ready" ? read.data.folder.path : folder}
    </span>
  );
}

/** How far the sync of one published source is, and what failed in it. */
function SourceStatus({
  source,
  knowledgeBase,
  sourceId,
  status,
  canWrite,
  fedByWorkflow = false,
  canRelease = false,
  canConfirm = false,
  scheduleShown = true,
  syncShown = true
}: {
  source: KnowledgeBaseSource;
  knowledgeBase: string;
  sourceId: string;
  /** Absent while it is read, and for a source the instance does not name yet. */
  status: KnowledgeSourceStatus | undefined;
  canWrite: boolean;
  /** A Workflow-fed source: its runs decide what it holds, so it has no Sync now or Try again. */
  fedByWorkflow?: boolean;
  /** The reader may let a Workflow bring back the items a person removed by hand. */
  canRelease?: boolean;
  /** The reader may let a first import that waits at 10,000 items go on (KB-ISO-1b). */
  canConfirm?: boolean;
  /** `false` leaves out how the published source syncs by itself, where the page says it above. */
  scheduleShown?: boolean;
  /** `false` leaves out Sync now, where the page offers it for this source elsewhere. */
  syncShown?: boolean;
}) {
  const { locale, t } = useTranslation();
  const [busy, setBusy] = useState<"sync" | "confirm" | KnowledgeSourceFailureCode>();
  const [notice, setNotice] = useState<ActionNotice>();
  if (status === undefined) return null;
  const view = sourceStateView(status);
  const counts = sourceItemCounts(status.items);
  const number = (count: number) => new Intl.NumberFormat(locale).format(count);
  const sync = async () => {
    if (!source.syncSource) return;
    setBusy("sync");
    setNotice(undefined);
    const answer = await source.syncSource(knowledgeBase, sourceId);
    setBusy(undefined);
    setNotice(
      answer.ok
        ? { tone: "success", text: t("knowledgeSources.syncStarted") }
        : {
            tone: "error",
            text: answer.refused
              ? t("knowledgeSources.refused")
              : (answer.message ?? t("knowledgeSources.syncFailed"))
          }
    );
  };
  const confirm = async () => {
    if (!source.confirmSource) return;
    setBusy("confirm");
    setNotice(undefined);
    const answer = await source.confirmSource(knowledgeBase, sourceId);
    setBusy(undefined);
    setNotice(
      answer.ok
        ? { tone: "success", text: t("knowledgeSources.confirmed") }
        : {
            tone: "error",
            text: answer.refused
              ? t("knowledgeSources.confirmRefused")
              : (answer.message ?? t("knowledgeSources.confirmFailed"))
          }
    );
  };
  const retry = async (code: KnowledgeSourceFailureCode) => {
    if (!source.retrySource) return;
    setBusy(code);
    setNotice(undefined);
    const answer = await source.retrySource(knowledgeBase, sourceId, code);
    setBusy(undefined);
    setNotice(
      answer.ok
        ? {
            tone: "success",
            text: fedByWorkflow
              ? t("knowledgeSources.released", { count: number(releasedOf(answer.data)) })
              : t("knowledgeSources.retried", { count: number(queuedOf(answer.data)) })
          }
        : {
            tone: "error",
            text: answer.refused
              ? t("knowledgeSources.refused")
              : (answer.message ?? t("knowledgeSources.retryFailed"))
          }
    );
  };
  return (
    <div className="grid min-w-0 gap-3 border-t pt-3" data-knowledge-source-status={view.state}>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Badge tone={view.tone} dot>
          {t(view.label)}
        </Badge>
        <Chip size="sm" data-knowledge-source-count="found">
          {t("knowledgeSources.found", { count: number(counts.found) })}
        </Chip>
        <Chip size="sm" data-knowledge-source-count="searchable">
          {t("knowledgeSources.searchable", { count: number(counts.searchable) })}
        </Chip>
        {counts.failed > 0 ? (
          <Chip size="sm" data-knowledge-source-count="failed">
            {t("knowledgeSources.failedCount", { count: number(counts.failed) })}
          </Chip>
        ) : null}
      </div>
      {status.confirmation ? (
        <FirstImportConfirmation
          confirmation={status.confirmation}
          action={
            canConfirm && source.confirmSource ? (
              <Button
                size="sm"
                loading={busy === "confirm"}
                disabled={busy !== undefined}
                data-knowledge-source-confirm=""
                onClick={() => {
                  confirm().catch(() => setBusy(undefined));
                }}
              >
                <Play aria-hidden="true" />
                {t("knowledgeSources.confirm")}
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {fedByWorkflow && status.last?.endedAt ? (
        <p className="text-caption text-muted-foreground" data-knowledge-source-freshness="">
          {t("knowledgeSources.workflowFreshness", {
            elapsed: formatElapsed(status.last.endedAt, new Date(), locale)
          })}
        </p>
      ) : null}
      {status.schedule && scheduleShown ? <ScheduleLine schedule={status.schedule} /> : null}
      <KeyValueList layout="stacked">
        {status.running?.estimatedEndAt ? (
          <KeyValue label={t("knowledgeSources.estimatedEnd")}>
            {formatMomentShort(status.running.estimatedEndAt, locale)}
          </KeyValue>
        ) : null}
        {status.last?.endedAt ? (
          <KeyValue
            label={t(fedByWorkflow ? "knowledgeSources.lastRun" : "knowledgeSources.lastSync")}
          >
            {formatMomentShort(status.last.endedAt, locale)}
          </KeyValue>
        ) : null}
        {status.lastChangeAt ? (
          <KeyValue label={t("knowledgeSources.lastChange")}>
            {formatMomentShort(status.lastChangeAt, locale)}
          </KeyValue>
        ) : null}
        {status.oldestOpenChangeAt ? (
          <KeyValue label={t("knowledgeSources.oldestOpen")}>
            {formatMomentShort(status.oldestOpenChangeAt, locale)}
          </KeyValue>
        ) : null}
      </KeyValueList>
      {status.failures.length > 0 ? (
        <ul
          aria-label={t("knowledgeSources.failures")}
          className="grid gap-2"
          data-knowledge-source-failures=""
        >
          {status.failures.map((failure) => (
            <li
              key={failure.code}
              className="flex min-w-0 flex-wrap items-center justify-between gap-2"
              data-knowledge-source-failure={failure.code}
            >
              <span className="min-w-0 text-body">
                {t(sourceFailureText(failure.code))}{" "}
                <span className="text-muted-foreground">
                  (
                  {failure.count === 1
                    ? t("knowledgeSources.failureItem")
                    : t("knowledgeSources.failureItems", { count: number(failure.count) })}
                  )
                </span>
              </span>
              {canWrite && !fedByWorkflow && source.retrySource ? (
                <Button
                  variant="outline"
                  size="sm"
                  title={t("knowledgeSources.retryLabel")}
                  loading={busy === failure.code}
                  disabled={busy !== undefined}
                  onClick={() => {
                    retry(failure.code).catch(() => setBusy(undefined));
                  }}
                >
                  <RotateCcw aria-hidden="true" />
                  {t("knowledgeSources.retry")}
                </Button>
              ) : canRelease &&
                fedByWorkflow &&
                failure.code === "knowledge_item_removed" &&
                source.retrySource ? (
                <Button
                  variant="outline"
                  size="sm"
                  title={t("knowledgeSources.releaseLabel")}
                  loading={busy === failure.code}
                  disabled={busy !== undefined}
                  data-knowledge-source-release=""
                  onClick={() => {
                    retry(failure.code).catch(() => setBusy(undefined));
                  }}
                >
                  <RotateCcw aria-hidden="true" />
                  {t("knowledgeSources.release")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {notice ? <FormNotice tone={notice.tone}>{notice.text}</FormNotice> : null}
      {canWrite && !fedByWorkflow && syncShown && source.syncSource ? (
        <div>
          <Button
            variant="outline"
            size="sm"
            loading={busy === "sync"}
            disabled={busy !== undefined || status.running !== undefined}
            data-knowledge-source-sync=""
            onClick={() => {
              sync().catch(() => setBusy(undefined));
            }}
          >
            <RefreshCw aria-hidden="true" />
            {t("knowledgeSources.syncNow")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Whether the published source syncs by itself exactly as the draft sets it: then its settings
 * say it already. One that does not sync by itself is never the same: its note says what follows.
 */
function publishedAsSet(
  set: KnowledgeSourceForm["schedule"],
  published: KnowledgeSourceStatus["schedule"]
): boolean {
  if (published === undefined) return false;
  if (published.changes === "off" && published.full === "off") return false;
  return (
    (set?.changes ?? published.defaultChanges) === published.changes &&
    (set?.full ?? published.defaultFull) === published.full
  );
}

/**
 * How the published source syncs by itself: how often it fetches changes and when it runs a
 * full sync, or that it syncs only by hand.
 */
function ScheduleLine({ schedule }: { schedule: NonNullable<KnowledgeSourceStatus["schedule"]> }) {
  const translation = useTranslation();
  const { t } = translation;
  if (schedule.changes === "off" && schedule.full === "off")
    return (
      <p className="text-caption text-muted-foreground" data-knowledge-source-sync-state="off">
        <span className="font-medium text-foreground">{t("knowledgeSources.syncOff")}.</span>{" "}
        {t("knowledgeSources.syncOffNote")}
      </p>
    );
  return (
    <KeyValueList layout="stacked" data-knowledge-source-sync-state="on">
      <KeyValue label={t("knowledgeSources.syncChangesEvery")}>
        {schedule.changes === "off"
          ? t("knowledgeSources.syncModeOff")
          : intervalWords(schedule.changes, t)}
      </KeyValue>
      <KeyValue label={t("knowledgeSources.syncFullAt")}>
        {schedule.full === "off"
          ? t("knowledgeSources.syncModeOff")
          : (scheduleInWords(schedule.full, translation) ?? t("workflows.schedule.custom"))}
      </KeyValue>
    </KeyValueList>
  );
}

type FirstPassConfirmation = NonNullable<KnowledgeSourceStatus["confirmation"]>;

/**
 * A first import that stopped at 10,000 items (KB-ISO-1b): what the whole source holds and what
 * embedding it would cost, estimated from the listed sizes, and for who may publish, one button
 * that lets it go on. Who may only read sees the same without the button.
 */
function FirstImportConfirmation({
  confirmation,
  action
}: {
  confirmation: FirstPassConfirmation;
  action: ReactNode;
}) {
  const { locale, t } = useTranslation();
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const range = (min: string, max: string) =>
    min === max ? min : t("knowledgeSources.confirmRange", { min, max });
  const counts = {
    items: number(confirmation.items),
    size: formatStoreBytes(confirmation.bytes, locale)
  };
  // A Knowledge Base that does not search by meaning embeds nothing: count and size alone.
  const { cost, passages, tokens, room, addedBytes } = confirmation;
  const statement =
    confirmation.model === undefined
      ? t("knowledgeSources.confirmNoEmbedding", counts)
      : cost
        ? t("knowledgeSources.confirmStatement", {
            ...counts,
            cost: range(
              formatEmbeddingCost(cost.min, cost.currency, locale),
              formatEmbeddingCost(cost.max, cost.currency, locale)
            )
          })
        : t("knowledgeSources.confirmNoPrice", counts);
  return (
    <Banner
      tone="warning"
      title={t("knowledgeSources.confirmTitle")}
      action={action}
      data-knowledge-source-confirmation=""
    >
      <div className="grid min-w-0 gap-2">
        <p>{statement}</p>
        <p>{t("knowledgeSources.confirmStopped", { stop: number(confirmation.stop) })}</p>
        {passages && tokens ? (
          <KeyValueList layout="stacked">
            <KeyValue label={t("knowledgeSources.confirmPassages")}>
              {range(number(passages.min), number(passages.max))}
            </KeyValue>
            <KeyValue label={t("knowledgeSources.confirmTokens")}>
              {range(number(tokens.min), number(tokens.max))}
            </KeyValue>
          </KeyValueList>
        ) : null}
        {room === false && addedBytes !== undefined ? (
          <p>
            {t("knowledgeSources.confirmNoRoom", {
              used: formatStoreBytes(confirmation.storeBytes, locale),
              added: formatStoreBytes(addedBytes, locale),
              limit: formatStoreBytes(confirmation.limitBytes ?? 0, locale)
            })}
          </p>
        ) : null}
      </div>
    </Banner>
  );
}

type WorkflowSourceStatus = Extract<KnowledgeSourceStatus, { workflowId: string }>;

/**
 * A source a Workflow fills through `ingest`: the Workflow, a link to its page where the reader
 * has one, and how far its last run brought the source.
 */
function WorkflowSourceItem({
  source,
  knowledgeBase,
  status,
  workflow,
  page,
  canPublish,
  rows
}: {
  source: KnowledgeBaseSource;
  knowledgeBase: string;
  status: WorkflowSourceStatus;
  canPublish: boolean;
  /** A row of the list it stands in, not a card of its own. */
  rows: boolean;
  /** The Workflow as the state names it; absent where the reader may not read it. */
  workflow: DataFlowRef | undefined;
  page: ReturnType<DataFlowPage> | undefined;
}) {
  const { t } = useTranslation();
  return (
    <li
      className={
        rows
          ? "grid min-w-0 gap-3 border-b bg-muted/50 px-3 py-3"
          : "grid min-w-0 gap-3 rounded-md border p-4"
      }
      data-knowledge-source={status.id}
      data-knowledge-source-kind="workflow"
    >
      <List aria-label={t("knowledgeSources.workflow")}>
        <DataFlowRow
          flow={workflow ?? { id: status.id, name: status.workflowId, title: status.workflowId }}
          role="fills"
          page={workflow === undefined ? undefined : page}
        />
      </List>
      <SourceStatus
        source={source}
        knowledgeBase={knowledgeBase}
        sourceId={status.id}
        status={status}
        canWrite={false}
        fedByWorkflow
        canRelease={canPublish}
        canConfirm={canPublish}
      />
      <p className="text-caption text-muted-foreground">{t("knowledgeSources.workflowNote")}</p>
    </li>
  );
}

/** How many items a retry queued, as the instance answered it. */
function queuedOf(answer: unknown): number {
  const queued =
    answer !== null && typeof answer === "object" && "queued" in answer ? answer.queued : undefined;
  return typeof queued === "number" ? queued : 0;
}

/** How many removed items a Workflow may bring back again, as the instance answered it. */
function releasedOf(answer: unknown): number {
  const released =
    answer !== null && typeof answer === "object" && "released" in answer
      ? answer.released
      : undefined;
  return typeof released === "number" ? released : 0;
}

/**
 * Where no Connection can sync folders yet: the types the instance can connect, and the New
 * connection dialog for a person who may create one.
 */
function NoSourceConnection({ source }: { source: KnowledgeBaseSource }) {
  const { locale, t } = useTranslation();
  const types = source.useSourceTypes?.();
  return (
    <EmptyState
      layout="inline"
      data-knowledge-sources-none=""
      action={types !== undefined && types.length > 0 ? <NewSourceConnection /> : undefined}
    >
      {types === undefined
        ? t("knowledgeSources.noConnections")
        : types.length === 0
          ? t("knowledgeSources.noDocumentTypes")
          : t("knowledgeSources.noConnectionsFor", {
              types: new Intl.ListFormat(locale, { type: "disjunction" }).format(
                types.map((type) => offerText(type.title, locale))
              )
            })}
    </EmptyState>
  );
}

/** Opens the New connection dialog on the Connections page, where Studio can open it. */
export function NewSourceConnection() {
  const { t } = useTranslation();
  const navigation = useOptionalBuildNavigation();
  if (!navigation) return null;
  const connections = { kindPath: CONNECTIONS_BUILD_PATH };
  return (
    <Button asChild variant="outline" size="sm">
      <a
        href={navigation.href(connections)}
        data-knowledge-source-connect=""
        onClick={(event) => {
          if (!opensHere(event)) return;
          event.preventDefault();
          navigation.open(connections);
          requestBuildCreateDialog(CONNECTIONS_BUILD_PATH);
        }}
      >
        <Plug aria-hidden="true" />
        {t("connections.new")}
      </a>
    </Button>
  );
}

/**
 * Connects a folder: the chooser of the Connection a new source reads through, or what to
 * connect first where none can. The source it adds is part of the draft, as every source is.
 */
export function KnowledgeSourceConnectDialog({
  source,
  owner,
  onClose,
  onAdd
}: {
  source: KnowledgeBaseSource;
  /** The workspace that owns the Knowledge Base, absent for one of the instance. */
  owner: string | undefined;
  onClose(): void;
  /** The Connection chosen, with its Connector type where the list names it. */
  onAdd(connection: string, connectorType: string | undefined): void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState(NO_SEARCH);
  const read = source.useSourceConnections?.(search, owner);
  const none = read?.status === "ready" && read.data.items.length === 0 && search === NO_SEARCH;
  return (
    <Dialog
      open
      size="md"
      title={t("knowledgeSources.connectTitle")}
      description={t("knowledgeSources.description")}
      onClose={onClose}
      footer={
        <Button variant="outline" onClick={onClose}>
          {t("cancel")}
        </Button>
      }
    >
      <div className="grid min-w-0 gap-3" data-knowledge-source-connect-dialog="">
        {none || read === undefined ? (
          <NoSourceConnection source={source} />
        ) : (
          <>
            <AddSource
              read={read}
              onSearchChange={setSearch}
              onAdd={(connection) =>
                onAdd(
                  connection,
                  read.status === "ready"
                    ? read.data.items.find((choice) => choice.name === connection)?.connectorType
                    : undefined
                )
              }
            />
            <p className="text-caption text-muted-foreground">{t("knowledgeSources.draftNote")}</p>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** Whether a click opens the link in this tab, not in a new one. */
function opensHere(event: ReactMouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** The chooser of a Connection a new source reads through. */
function AddSource({
  read,
  onSearchChange,
  onAdd
}: {
  read: KnowledgeRead<PagedItems<KnowledgeChoice>>;
  onSearchChange(search: string): void;
  onAdd(connection: string): void;
}) {
  const { t } = useTranslation();
  const connections = read.status === "ready" ? read.data.items : [];
  const more = read.status === "ready" ? read.data.more : undefined;
  const error =
    read.status === "failed" || read.status === "refused"
      ? t("knowledgeSources.connectionsFailed")
      : undefined;
  return (
    <Field label={t("knowledgeSources.add")} error={error}>
      <Picker
        search
        label={t("knowledgeSources.chooseConnection")}
        onSearchChange={(text) => onSearchChange(text.trim())}
        more={more && { loading: more.loading, onLoad: more.load }}
        options={connections.map((connection) => ({
          value: connection.name,
          label: connection.title || connection.name,
          description: connection.description,
          keywords: connection.name,
          leading: <FolderSync aria-hidden="true" />
        }))}
        value={undefined}
        onValueChange={onAdd}
      >
        <PickerButton
          label={t("knowledgeSources.add")}
          placeholder={t("knowledgeSources.chooseConnection")}
          value={undefined}
          data-knowledge-source-add=""
        />
      </Picker>
    </Field>
  );
}
