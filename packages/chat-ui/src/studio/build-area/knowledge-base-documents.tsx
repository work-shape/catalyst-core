import {
  ExternalLink,
  FolderSync,
  Link2,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload
} from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  FormNotice,
  Input,
  List,
  ListRow,
  LoadMore,
  Skeleton,
  Spinner
} from "@work-shape/catalyst-ui";
import { FileTypeIcon } from "../../chat/files/file-type-icon";
import { resolveFileType } from "../../chat/files/file-type";
import { formatMomentShort } from "../../shared/locale-format";
import { openOriginLink, safeOriginLink } from "../../shared/origin-link";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import { ReadState } from "./data-store-read-state";
import {
  addableFile,
  addFileMaxBytes,
  addFormatsMaxBytes,
  documentFailureText,
  documentsByAttention,
  knowledgeDocumentTally,
  KNOWLEDGE_ADD_LIMITS,
  KNOWLEDGE_ADD_REFUSALS,
  KNOWLEDGE_DOCUMENT_STATE_VIEWS,
  KNOWLEDGE_REMOVE_REFUSALS,
  type KnowledgeDocumentTally
} from "./knowledge-base-model";
import type {
  KnowledgeBaseSource,
  KnowledgeDocument,
  KnowledgeOpenableFile,
  KnowledgeSourceStatus
} from "./knowledge-base-source";
import type { ActionNotice } from "./build-model";
import { ReleasedSourcesContext } from "./knowledge-base-sources";
import { KnowledgeUploadSection } from "./knowledge-base-upload";
import { uploadFormatList, uploadFormats } from "./knowledge-upload-model";
import { formatFileBytes } from "./skill-form-model";

/** How a format is named on the page. */
const FORMAT_NAMES: Record<string, string> = {
  txt: "TXT",
  markdown: "Markdown",
  pdf: "PDF",
  docx: "DOCX",
  xlsx: "XLSX",
  pptx: "PPTX"
};

/**
 * What the line over the documents says: how many of them can be searched, and under it, only
 * where something needs the reader, how many failed or are still being read.
 */
function tallyWords(
  tally: KnowledgeDocumentTally,
  canWrite: boolean,
  synced: boolean,
  { locale, t }: Pick<TranslationContextValue, "locale" | "t">
): { headline: string; detail?: string } {
  const number = (count: number) => new Intl.NumberFormat(locale).format(count);
  if (!tally.exact) {
    const count = tally.total === undefined ? undefined : number(tally.total);
    return {
      headline:
        count === undefined
          ? t("knowledge.documentsTitle")
          : tally.state === "indexed"
            ? t("knowledge.tallyAll", { count })
            : t("knowledge.tallyCount", { count }),
      ...(tally.state === "failed"
        ? { detail: t("knowledge.tallySomeFailed") }
        : tally.state === "pending"
          ? { detail: t("knowledge.tallySomePending") }
          : {})
    };
  }
  if (tally.total === 0) {
    return {
      headline: t("knowledge.tallyNone"),
      detail: t(
        synced
          ? "knowledge.tallyNoneHintSynced"
          : canWrite
            ? "knowledge.tallyNoneHint"
            : "knowledge.tallyNoneHintReadOnly"
      )
    };
  }
  const headline =
    tally.searchable === tally.total
      ? tally.total === 1
        ? t("knowledge.tallyOne")
        : t("knowledge.tallyAll", { count: number(tally.total) })
      : tally.total === 1
        ? t("knowledge.tallyOneNot")
        : t("knowledge.tallySome", {
            searchable: number(tally.searchable),
            count: number(tally.total)
          });
  // What failed needs the reader; what is still being read only needs time.
  const detail =
    tally.failed > 0
      ? tally.failed === 1
        ? t("knowledge.tallyFailedOne")
        : t("knowledge.tallyFailedMany", { count: number(tally.failed) })
      : tally.pending > 0
        ? tally.pending === 1
          ? t("knowledge.tallyPendingOne")
          : t("knowledge.tallyPendingMany", { count: number(tally.pending) })
        : undefined;
  return { headline, ...(detail === undefined ? {} : { detail }) };
}

/** A source a Connection syncs, as the state of the sources names it: not one a Workflow fills. */
type SyncedSource = Extract<KnowledgeSourceStatus, { connection: string }>;

/**
 * How documents come into a published Knowledge Base of documents, which decides its main
 * action. `synced`: a Connection syncs them and nobody added one by hand, so the action is Sync
 * now, and files added by hand, which would never sync, wait in the head's menu. `uploads`: no
 * source syncs, so it is Add documents. `both`: Add documents stays, with Sync now beside it.
 * Only the documents read so far are looked at. Where the reader cannot sync, it is `uploads`.
 */
export interface KnowledgeIntake {
  /** `pending` until the sources are read: no action shows, so none is swapped for another. */
  way: "pending" | "uploads" | "synced" | "both";
  /** The published sources a Connection syncs. */
  synced: readonly SyncedSource[];
}

/** A hook: how documents come into the Knowledge Base, read with what the page reads anyway. */
export function useKnowledgeIntake(
  source: KnowledgeBaseSource,
  knowledgeBase: string,
  /** Absent, nothing is read and the way is `uploads`. */
  publishedRevision: number | undefined
): KnowledgeIntake {
  const state = source.useState(knowledgeBase, publishedRevision, true);
  const storeReady =
    publishedRevision !== undefined &&
    state.status === "ready" &&
    state.data.status !== "preparing" &&
    state.data.status !== "unchecked";
  const documents = source.useDocuments(knowledgeBase, storeReady);
  const sources = source.useSources?.(knowledgeBase, publishedRevision);
  const synced =
    source.syncSource !== undefined && sources?.status === "ready"
      ? sources.data.sources.filter((entry): entry is SyncedSource => "connection" in entry)
      : [];
  const uploaded =
    documents.status === "ready" &&
    documents.data.documents.some((document) => document.sourceId === undefined);
  if (source.syncSource !== undefined && sources?.status === "loading") {
    return { way: publishedRevision === undefined ? "uploads" : "pending", synced };
  }
  return { way: synced.length === 0 ? "uploads" : uploaded ? "both" : "synced", synced };
}

/**
 * The documents of a published Knowledge Base that keeps documents: one line that says how many
 * of them can be searched, with its main action, and under it the list. The main action is the
 * one way to add more, or Sync now where every document comes from a synced source. Those that
 * failed stand first, each with its reason and Retry, then those still being read; a searchable
 * one says nothing of its state. Only the documents read so far are ordered so: the instance
 * pages them newest first. Whoever may change the Knowledge Base adds documents, retries a
 * failed one and removes one they added; a document synced from a source leaves only when the
 * source withdraws it. Whoever may use the Knowledge Base sees the line and the list, and a
 * notice while no worker takes its documents.
 */
export function KnowledgeDocuments({
  source,
  knowledgeBase,
  publishedRevision,
  canWrite,
  sources,
  onConnect,
  adding: addingGiven,
  onAdding
}: {
  source: KnowledgeBaseSource;
  knowledgeBase: string;
  publishedRevision: number;
  canWrite: boolean;
  /** The synced sources, as the first rows of the list. */
  sources?: ReactNode;
  /** Connects a folder, where the instance offers synced sources: Add then offers both ways. */
  onConnect?: () => void;
  /** Whether the Add dialog is open, where the page opens it from elsewhere too, such as a menu. */
  adding?: boolean;
  onAdding?(adding: boolean): void;
}) {
  const translation = useTranslation();
  const { t } = translation;
  // Watched while the section is open, with or without documents: a sync from a source can be
  // queued before any document exists, and waits just the same when no worker takes it.
  const state = source.useState(knowledgeBase, publishedRevision, true);
  // Right after a publish the store is still being made and has no documents table yet. The
  // documents are read only once the watched state says the store stands; until then the
  // section says it is being made, and a state that could not be read says so instead.
  const preparing =
    state.status === "ready" &&
    (state.data.status === "preparing" || state.data.status === "unchecked");
  const storeReady = state.status === "ready" && !preparing;
  const read = source.useDocuments(knowledgeBase, storeReady);
  // The sources whose documents keep no copy here: their rows say so once, for all of them.
  const documentsRead = read.status === "ready" ? read.data.documents : undefined;
  const releasedSources = useMemo(
    () =>
      new Set(
        (documentsRead ?? []).flatMap((document) =>
          document.sourceId !== undefined && document.originalStatus === "released"
            ? [document.sourceId]
            : []
        )
      ),
    [documentsRead]
  );
  const [addingHere, setAddingHere] = useState(false);
  const adding = addingGiven ?? addingHere;
  const setAdding = onAdding ?? setAddingHere;
  const intake = useKnowledgeIntake(source, knowledgeBase, publishedRevision);
  const [syncing, setSyncing] = useState(false);
  const [syncNotice, setSyncNotice] = useState<ActionNotice>();
  // Every synced source at once: the same call as Sync now of each one's own row.
  const syncAll = async () => {
    const { syncSource } = source;
    if (!syncSource) return;
    setSyncing(true);
    setSyncNotice(undefined);
    const answers = await Promise.all(
      intake.synced.map((entry) => syncSource(knowledgeBase, entry.id))
    );
    setSyncing(false);
    const refused = answers.find((answer) => !answer.ok);
    setSyncNotice(
      refused === undefined
        ? { tone: "success", text: t("knowledgeSources.syncStarted") }
        : {
            tone: "error",
            text: refused.refused
              ? t("knowledgeSources.refused")
              : (refused.message ?? t("knowledgeSources.syncFailed"))
          }
    );
  };
  const [added, setAdded] = useState<number>();
  const [retrying, setRetrying] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const [removing, setRemoving] = useState<KnowledgeDocument>();
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeFailure, setRemoveFailure] = useState<string>();
  const [removed, setRemoved] = useState<string>();
  const [linking, setLinking] = useState<KnowledgeDocument>();
  const [linked, setLinked] = useState<{ name: string; cleared: boolean }>();
  const nameOf = (document: KnowledgeDocument) => document.title || document.fileName;
  const remove = async (document: KnowledgeDocument) => {
    setRemoveBusy(true);
    setRemoveFailure(undefined);
    const answer = await source.remove(knowledgeBase, [document.id]);
    setRemoveBusy(false);
    if (answer.ok) {
      setRemoving(undefined);
      setAdded(undefined);
      setRemoved(nameOf(document));
      return;
    }
    const known =
      answer.reason === undefined ? undefined : KNOWLEDGE_REMOVE_REFUSALS[answer.reason];
    setRemoveFailure(
      answer.refused
        ? t("knowledge.retryRefused")
        : known
          ? t(known)
          : (answer.message ?? t("knowledge.removeFailed"))
    );
  };
  const retry = async (document: KnowledgeDocument) => {
    setRetrying(document.id);
    setFailure(undefined);
    const answer = await source.retry(knowledgeBase, [document.id]);
    setRetrying(undefined);
    if (!answer.ok) {
      setFailure(
        answer.refused
          ? t("knowledge.retryRefused")
          : (answer.message ?? t("knowledge.retryFailed"))
      );
    }
  };
  const openAdd = () => {
    setAdded(undefined);
    setRemoved(undefined);
    setAdding(true);
  };
  const words =
    preparing || state.status === "failed" || state.status === "refused"
      ? preparing
        ? { headline: t("knowledge.statusPreparing"), detail: t("knowledge.documentsPreparing") }
        : { headline: t("knowledge.documentsTitle") }
      : read.status === "ready" && storeReady
        ? tallyWords(
            knowledgeDocumentTally(
              read.data.documents,
              read.data.more === undefined,
              read.data.summary
            ),
            canWrite,
            intake.way === "synced",
            translation
          )
        : read.status === "loading" || !storeReady
          ? undefined
          : { headline: t("knowledge.documentsTitle") };
  const addLabel = (
    <>
      <Plus aria-hidden="true" />
      {t("knowledge.addDocuments")}
    </>
  );
  return (
    <div className="grid min-w-0 gap-4" data-knowledge-documents="">
      <div
        className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-md border bg-muted/50 px-4 py-3"
        data-knowledge-tally=""
      >
        <div className="grid min-w-0 gap-0.5" role="status">
          {words === undefined ? (
            <Skeleton className="my-1 h-4 w-56 max-w-full" />
          ) : (
            <>
              <p className="text-title-sm">{words.headline}</p>
              {words.detail === undefined ? null : (
                <p
                  className="text-caption text-muted-foreground"
                  {...(preparing ? { "data-knowledge-documents-preparing": "" } : {})}
                >
                  {words.detail}
                </p>
              )}
            </>
          )}
        </div>
        {!canWrite || intake.way === "pending" ? null : (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {intake.way === "uploads" ? null : (
              <Button
                variant={intake.way === "synced" ? "primary" : "outline"}
                loading={syncing}
                disabled={syncing || intake.synced.every((entry) => entry.running !== undefined)}
                data-knowledge-sync=""
                onClick={() => {
                  syncAll().catch(() => setSyncing(false));
                }}
              >
                <RefreshCw aria-hidden="true" />
                {t("knowledgeSources.syncNow")}
              </Button>
            )}
            {intake.way === "synced" ? null : onConnect ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button data-knowledge-add="">{addLabel}</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem icon={<Upload aria-hidden="true" />} onSelect={openAdd}>
                    <span data-knowledge-add-files="">{t("knowledge.addUpload")}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem icon={<FolderSync aria-hidden="true" />} onSelect={onConnect}>
                    <span data-knowledge-add-folder="">{t("knowledge.addConnect")}</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button onClick={openAdd} data-knowledge-add="">
                {addLabel}
              </Button>
            )}
          </div>
        )}
      </div>
      {syncNotice ? (
        <FormNotice tone={syncNotice.tone} data-knowledge-sync-notice="">
          {syncNotice.text}
        </FormNotice>
      ) : null}
      {added === undefined ? null : (
        <FormNotice tone="success">
          {added === 1
            ? t("knowledge.addedOne")
            : t("knowledge.addedMany", { count: String(added) })}
        </FormNotice>
      )}
      {removed === undefined ? null : (
        <FormNotice tone="success">{t("knowledge.removed", { name: removed })}</FormNotice>
      )}
      {linked === undefined ? null : (
        <FormNotice tone="success">
          {t(linked.cleared ? "knowledge.originLinkCleared" : "knowledge.originLinkSaved", {
            name: linked.name
          })}
        </FormNotice>
      )}
      {failure ? <FormNotice tone="error">{failure}</FormNotice> : null}
      {state.status === "ready" && state.data.processingWaiting ? (
        <FormNotice tone="error" data-knowledge-processing-waiting="">
          {t("knowledge.processingWaiting")}
        </FormNotice>
      ) : null}
      {/* The sources and the documents are one list, in one frame; with neither there is none. */}
      <div className="min-w-0 overflow-hidden rounded-md border empty:hidden">
        <ReleasedSourcesContext.Provider value={releasedSources}>
          {sources}
        </ReleasedSourcesContext.Provider>
        {preparing ? null : (
          <ReadState
            read={
              storeReady
                ? read
                : state.status === "failed"
                  ? { status: "failed", message: undefined, retry: state.retry }
                  : state.status === "refused"
                    ? state
                    : { status: "loading" }
            }
            failedText={t("knowledge.documentsFailed")}
            refusedText={t("knowledge.documentsRefused")}
            rows={3}
          >
            {({ documents, more }) =>
              documents.length === 0 ? null : (
                <>
                  <List aria-label={t("knowledge.documentsTitle")} className="p-1">
                    {documentsByAttention(documents).map((document) => (
                      <DocumentRow
                        key={document.id}
                        document={document}
                        retrying={retrying === document.id}
                        onRetry={
                          canWrite && document.state === "failed"
                            ? () => {
                                retry(document).catch(() => undefined);
                              }
                            : undefined
                        }
                        onRemove={
                          // A connector-synced document leaves when its source withdraws it, not
                          // by hand; a Workflow-fed one is removed here and held out (KBW-2b).
                          canWrite &&
                          (document.sourceId === undefined || isWorkflowSource(document.sourceId))
                            ? () => {
                                setRemoved(undefined);
                                setRemoveFailure(undefined);
                                setRemoving(document);
                              }
                            : undefined
                        }
                        onLink={
                          // A document of a source or a Workflow keeps the link they give it.
                          canWrite && source.setOriginLink && document.sourceId === undefined
                            ? () => {
                                setLinked(undefined);
                                setLinking(document);
                              }
                            : undefined
                        }
                      />
                    ))}
                  </List>
                  {more ? (
                    <LoadMore
                      className="border-t p-1"
                      loading={more.loading}
                      onLoad={more.load}
                      label={t("knowledge.documentsMore")}
                    />
                  ) : null}
                </>
              )
            }
          </ReadState>
        )}
      </div>
      <ConfirmDialog
        open={removing !== undefined}
        title={t("knowledge.removeTitle", { name: removing ? nameOf(removing) : "" })}
        confirmLabel={t("knowledge.remove")}
        loading={removeBusy}
        onConfirm={() => {
          if (removing) remove(removing).catch(() => undefined);
        }}
        onClose={() => {
          if (!removeBusy) setRemoving(undefined);
        }}
      >
        <div className="grid gap-3" data-knowledge-remove-dialog="">
          <p>
            {t(
              removing?.sourceId !== undefined && isWorkflowSource(removing.sourceId)
                ? "knowledge.removeWorkflowDescription"
                : "knowledge.removeDescription"
            )}
          </p>
          {removeFailure ? <FormNotice tone="error">{removeFailure}</FormNotice> : null}
        </div>
      </ConfirmDialog>
      {linking ? (
        <OriginLinkDialog
          document={linking}
          name={nameOf(linking)}
          save={(link) =>
            source.setOriginLink
              ? source.setOriginLink(knowledgeBase, linking.id, link)
              : Promise.resolve({ ok: false, refused: false, message: undefined })
          }
          onClose={() => setLinking(undefined)}
          onSaved={(cleared) => {
            setLinked({ name: nameOf(linking), cleared });
            setLinking(undefined);
          }}
        />
      ) : null}
      {adding ? (
        <KnowledgeAddDialog
          source={source}
          knowledgeBase={knowledgeBase}
          formats={uploadFormats(state.status === "ready" ? state.data.documentFormats : undefined)}
          {...(state.status === "ready" && state.data.maxFileBytes !== undefined
            ? { maxBytes: state.data.maxFileBytes }
            : {})}
          onClose={() => setAdding(false)}
          onAdded={(count) => {
            setAdding(false);
            setRemoved(undefined);
            setAdded(count);
          }}
        />
      ) : null}
    </div>
  );
}

/** A folder path as a row names it: `/Projects/North` reads `Projects / North`; the top, nothing. */
function folderWords(folder: string | undefined): string | undefined {
  const names = folder?.split("/").filter((name) => name !== "") ?? [];
  return names.length === 0 ? undefined : names.join(" / ");
}

/**
 * One document: its name, the folder it lies in at its source, its format and size, when it
 * was added, its state, and whether its fields wait, with the reason. The row is one line of
 * name and one of facts; only what needs the reader, a failure or waiting fields, takes more.
 */
function DocumentRow({
  document,
  retrying,
  onRetry,
  onRemove,
  onLink
}: {
  document: KnowledgeDocument;
  retrying: boolean;
  /** Present where the reader may retry the document: a failed one, for whoever may change. */
  onRetry: (() => void) | undefined;
  /** Present where the reader may remove the document: whoever may change, unless a connector syncs it. */
  onRemove: (() => void) | undefined;
  /** Present where the reader may enter its origin link: whoever may change one added by hand. */
  onLink: (() => void) | undefined;
}) {
  const { locale, t } = useTranslation();
  const view = KNOWLEDGE_DOCUMENT_STATE_VIEWS[document.state];
  const title = document.title || document.fileName;
  const facts = `${FORMAT_NAMES[document.format] ?? document.format} · ${formatFileBytes(document.bytes, locale)}`;
  const numbers = new Intl.NumberFormat(locale);
  const failurePages = {
    ...(document.failurePageLimit === undefined
      ? {}
      : { limit: numbers.format(document.failurePageLimit) }),
    ...(document.failurePageCount === undefined
      ? {}
      : { count: numbers.format(document.failurePageCount) })
  };
  const summary =
    document.state === "failed" ? t(documentFailureText(document), failurePages) : facts;
  // Field extraction paused: the document is searchable, its fields follow.
  const fieldsPending = document.fieldsPending === true && document.state !== "failed";
  const pendingReason = document.fieldsPendingReason;
  // Too large for the per-document limit: name the input, output reserve and limit. Otherwise the monthly budget,
  // also for an instance that sends no reason.
  const fieldsPendingText =
    pendingReason?.reason === "token_budget"
      ? t("knowledge.fieldsPendingTokenBudget", {
          estimated: numbers.format(pendingReason.estimatedTokens),
          reserve: numbers.format(pendingReason.reservedOutputTokens),
          limit: numbers.format(pendingReason.maxTokensPerDocument)
        })
      : t("knowledge.fieldsPendingMonthlyBudget");
  // Only a web address is shown as a link, so opening it never runs script.
  const origin = safeOriginLink(document.originLink);
  // Two files of one name from two folders are told apart by the folder.
  const folder = folderWords(document.folder);
  const words = [summary, ...(fieldsPending ? [fieldsPendingText] : [])].join(" · ");
  // A reason is a sentence and takes the lines it needs; the facts stay on one line.
  const sentence = document.state === "failed" || fieldsPending;
  const folderName =
    folder === undefined ? null : (
      <span className="min-w-0 truncate" title={folder} data-knowledge-document-folder="">
        {folder}
      </span>
    );
  const description = sentence ? (
    <>
      {folderName === null ? null : <span className="flex min-w-0">{folderName}</span>}
      {words}
    </>
  ) : folderName === null ? (
    words
  ) : (
    // The folder gives way first: the format and the size are never cut.
    <span className="flex min-w-0 gap-1">
      {folderName}
      <span className="shrink-0">· {words}</span>
    </span>
  );
  return (
    <ListRow
      data-knowledge-document={document.id}
      data-knowledge-document-state={document.state}
      leading={<FileTypeIcon type={resolveFileType({ filename: document.fileName })} />}
      title={title}
      description={description}
      data-knowledge-fields-pending={fieldsPending ? "" : undefined}
      descriptionWraps={sentence ? "always" : false}
      chips={
        <>
          {/* A searchable document is the rule and says nothing of it. */}
          {document.state === "indexed" ? null : (
            <Badge
              tone={view.tone}
              dot={document.state !== "pending"}
              leading={document.state === "pending" ? <Spinner size="sm" /> : undefined}
            >
              {t(view.label)}
            </Badge>
          )}
          {fieldsPending ? <Badge tone="neutral">{t("knowledge.fieldsPending")}</Badge> : null}
        </>
      }
      time={formatMomentShort(document.addedAt, locale)}
      // What a failed document needs stays in view; the rest shows with the pointer or the focus.
      actionsVisible={document.state === "failed"}
      actions={
        // Every row keeps a slot three icons wide (open, link, remove: the most a ready row has),
        // so the dates of all rows stand in one column whatever actions a row has.
        <span
          className="flex min-w-[calc(var(--spacing-control-md)*3+0.5rem)] items-center justify-end gap-1"
          data-knowledge-document-actions=""
        >
          {origin ? (
            <Button asChild variant="ghost" size="icon">
              <a
                href={origin.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t("knowledge.originLinkOpen", { name: title })}
                title={t("knowledge.originLinkOpen", { name: title })}
                onClick={(event) => {
                  event.preventDefault();
                  openOriginLink(origin.href);
                }}
                data-knowledge-origin-link={document.id}
              >
                <ExternalLink aria-hidden="true" />
              </a>
            </Button>
          ) : null}
          {onLink ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("knowledge.originLinkEditLabel", { name: title })}
              title={t("knowledge.originLinkEdit")}
              onClick={onLink}
              data-knowledge-origin-edit={document.id}
            >
              <Link2 aria-hidden="true" />
            </Button>
          ) : null}
          {onRetry ? (
            <Button variant="outline" size="sm" loading={retrying} onClick={onRetry}>
              <RotateCcw aria-hidden="true" />
              {t("knowledge.retry")}
            </Button>
          ) : null}
          {onRemove ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("knowledge.removeLabel", { name: title })}
              title={t("knowledge.remove")}
              onClick={onRemove}
              data-knowledge-remove={document.id}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          ) : null}
        </span>
      }
    />
  );
}

/**
 * Enters, changes or clears where the original of a document added by hand lives. It takes
 * only an http or https address without a user, a password or a token, as the server does,
 * and says why it refuses anything else before it sends.
 */
function OriginLinkDialog({
  document,
  name,
  save,
  onClose,
  onSaved
}: {
  document: KnowledgeDocument;
  name: string;
  save(
    link: string | null
  ): Promise<
    { ok: true } | { ok: false; refused: boolean; message: string | undefined; reason?: string }
  >;
  onClose(): void;
  onSaved(cleared: boolean): void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(document.originLink ?? "");
  const [busy, setBusy] = useState<"save" | "clear">();
  const [failure, setFailure] = useState<string>();
  const submit = async (link: string | null) => {
    if (link !== null && !acceptableOriginLink(link)) {
      setFailure(t("knowledge.originLinkInvalid"));
      return;
    }
    setBusy(link === null ? "clear" : "save");
    setFailure(undefined);
    const answer = await save(link);
    setBusy(undefined);
    if (answer.ok) {
      onSaved(link === null);
      return;
    }
    setFailure(
      answer.refused
        ? t("knowledge.retryRefused")
        : answer.reason === "knowledge_origin_link_synced"
          ? t("knowledge.originLinkSynced")
          : (answer.message ?? t("knowledge.originLinkFailed"))
    );
  };
  const trimmed = value.trim();
  return (
    <Dialog
      open
      size="md"
      title={t("knowledge.originLinkTitle", { name })}
      description={t("knowledge.originLinkDescription")}
      onClose={() => {
        if (busy === undefined) onClose();
      }}
      footer={
        <>
          {document.originLink ? (
            <Button
              variant="outline"
              loading={busy === "clear"}
              disabled={busy === "save"}
              onClick={() => {
                submit(null).catch(() => undefined);
              }}
              data-knowledge-origin-clear=""
            >
              {t("knowledge.originLinkClear")}
            </Button>
          ) : null}
          <Button variant="outline" disabled={busy !== undefined} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            disabled={trimmed === "" || trimmed === document.originLink || busy === "clear"}
            loading={busy === "save"}
            onClick={() => {
              submit(trimmed).catch(() => undefined);
            }}
            data-knowledge-origin-save=""
          >
            {t("knowledge.originLinkSave")}
          </Button>
        </>
      }
    >
      {/* No form of its own: the dialog stands inside the page's form, so Enter saves the link
          here and never submits the page. */}
      <div className="grid gap-3" data-knowledge-origin-dialog="">
        <Field label={t("knowledge.originLinkField")} hint={t("knowledge.originLinkHint")}>
          <Input
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (trimmed !== "" && busy === undefined) submit(trimmed).catch(() => undefined);
            }}
            data-knowledge-origin-input=""
          />
        </Field>
        {failure ? <FormNotice tone="error">{failure}</FormNotice> : null}
      </div>
    </Dialog>
  );
}

/**
 * Whether an origin link is one the server takes: an http or https address without a user or a
 * password. The server also refuses token parameters, and says so when it does.
 */
function acceptableOriginLink(link: string): boolean {
  const origin = safeOriginLink(link);
  if (!origin) return false;
  const url = new URL(origin.href);
  return url.username === "" && url.password === "";
}

/** The key a chosen file is kept under: a file is named by its conversation and its id. */
const fileKey = (file: Pick<KnowledgeOpenableFile, "conversationId" | "fileId">) =>
  `${file.conversationId}/${file.fileId}`;

/**
 * Adds files: uploaded from the reader's device, or those the reader can open in the
 * conversations of their workspace. It says the limits of one add and keeps to them: at most
 * so many files, none over the size limit, and only formats the instance reads. Closed
 * after an upload took files, it reports them as added.
 */
export function KnowledgeAddDialog({
  source,
  knowledgeBase,
  formats,
  maxBytes = KNOWLEDGE_ADD_LIMITS.bytes,
  onClose,
  onAdded
}: {
  source: KnowledgeBaseSource;
  knowledgeBase: string;
  /** The formats the instance reads, which the upload offers. */
  formats: readonly string[];
  /** The largest file the instance takes, `KNOWLEDGE_ADD_LIMITS.bytes` unless it says. */
  maxBytes?: number;
  onClose(): void;
  onAdded(count: number): void;
}) {
  const { locale, t } = useTranslation();
  const [search, setSearch] = useState("");
  const read = source.useOpenableFiles(search.trim(), true);
  const [chosen, setChosen] = useState<ReadonlyMap<string, KnowledgeOpenableFile>>(new Map());
  const [adding, setAdding] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [uploaded, setUploaded] = useState(0);
  const countUpload = useCallback(() => setUploaded((count) => count + 1), []);
  const close = () => (uploaded > 0 ? onAdded(uploaded) : onClose());
  const full = chosen.size >= KNOWLEDGE_ADD_LIMITS.files;
  const size = formatFileBytes(addFormatsMaxBytes(formats, maxBytes), locale);
  const formatList = uploadFormatList(formats, locale);
  const toggle = (file: KnowledgeOpenableFile, on: boolean) =>
    setChosen((current) => {
      const next = new Map(current);
      if (on && next.size < KNOWLEDGE_ADD_LIMITS.files) {
        next.set(fileKey(file), file);
      } else {
        next.delete(fileKey(file));
      }
      return next;
    });
  const add = async () => {
    setAdding(true);
    setFailure(undefined);
    const answer = await source.addFiles(knowledgeBase, [...chosen.values()]);
    setAdding(false);
    if (answer.ok) {
      onAdded(answer.data.count + uploaded);
      return;
    }
    const known = answer.reason === undefined ? undefined : KNOWLEDGE_ADD_REFUSALS[answer.reason];
    setFailure(
      answer.refused
        ? t("knowledge.addRefused")
        : known
          ? t(known, { size, formats: formatList })
          : (answer.message ?? t("knowledge.addFailed"))
    );
  };
  return (
    <Dialog
      open
      size="md"
      title={t("knowledge.addDocuments")}
      description={t("knowledge.addDescription")}
      onClose={close}
      footer={
        <>
          <Button variant="outline" onClick={close} data-knowledge-add-close="">
            {uploaded > 0 ? t("close") : t("cancel")}
          </Button>
          <Button
            disabled={chosen.size === 0}
            loading={adding}
            onClick={() => {
              add().catch(() => undefined);
            }}
            data-knowledge-add-submit=""
          >
            {t("knowledge.addSubmit")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3" data-knowledge-add-dialog="">
        <KnowledgeUploadSection
          source={source}
          knowledgeBase={knowledgeBase}
          formats={formats}
          maxBytes={maxBytes}
          onAdded={countUpload}
        />
        <span className="text-label">{t("knowledge.conversationFilesTitle")}</span>
        <Field
          label={t("knowledge.addSearch")}
          hint={t("knowledge.addLimits", {
            count: String(KNOWLEDGE_ADD_LIMITS.files),
            size,
            formats: formatList
          })}
        >
          <Input type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
        </Field>
        <ReadState
          read={read}
          failedText={t("knowledge.addFilesFailed")}
          refusedText={t("knowledge.addFilesFailed")}
          rows={4}
        >
          {({ items: files, more }) =>
            files.length === 0 ? (
              <EmptyState layout="inline">
                {search.trim() ? t("knowledge.addNoMatch") : t("knowledge.addNoFiles")}
              </EmptyState>
            ) : (
              <>
                <ul aria-label={t("knowledge.addFiles")} className="grid gap-3">
                  {files.map((file) => {
                    const fit = addableFile(file, formats, maxBytes);
                    const on = chosen.has(fileKey(file));
                    return (
                      <li key={fileKey(file)} data-knowledge-add-file={file.name}>
                        <Checkbox
                          label={file.name}
                          description={
                            fit.addable
                              ? `${file.conversationTitle} · ${formatFileBytes(file.bytes, locale)}`
                              : t(fit.reason, {
                                  size: formatFileBytes(addFileMaxBytes(file, maxBytes), locale),
                                  formats: formatList
                                })
                          }
                          checked={on}
                          disabled={!fit.addable || (full && !on)}
                          onCheckedChange={(next) => toggle(file, next)}
                        />
                      </li>
                    );
                  })}
                </ul>
                {more ? (
                  <LoadMore
                    loading={more.loading}
                    onLoad={more.load}
                    label={t("knowledge.documentsMore")}
                    data-knowledge-add-more=""
                  />
                ) : null}
              </>
            )
          }
        </ReadState>
        <p
          className="text-caption text-muted-foreground"
          aria-live="polite"
          data-knowledge-chosen=""
        >
          {full
            ? t("knowledge.addFull", { max: String(KNOWLEDGE_ADD_LIMITS.files) })
            : t("knowledge.addChosen", {
                count: String(chosen.size),
                max: String(KNOWLEDGE_ADD_LIMITS.files)
              })}
        </p>
        {failure ? <FormNotice tone="error">{failure}</FormNotice> : null}
      </div>
    </Dialog>
  );
}

/** A Workflow fills the source through `ingest`; its documents are removed by hand. */
function isWorkflowSource(sourceId: string): boolean {
  return sourceId.startsWith("workflow:");
}
