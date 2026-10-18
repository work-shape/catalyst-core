import { FileText, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  FormNotice,
  Input,
  List,
  ListRow,
  LoadMore,
  Spinner
} from "@work-shape/catalyst-ui";
import { formatMomentShort } from "../../shared/locale-format";
import { useTranslation } from "../../shared/i18n";
import { ReadState } from "./data-store-read-state";
import {
  addableFile,
  documentFailureText,
  KNOWLEDGE_ADD_LIMITS,
  KNOWLEDGE_ADD_REFUSALS,
  KNOWLEDGE_DOCUMENT_STATE_VIEWS,
  KNOWLEDGE_REMOVE_REFUSALS
} from "./knowledge-base-model";
import type {
  KnowledgeBaseSource,
  KnowledgeDocument,
  KnowledgeOpenableFile
} from "./knowledge-base-source";
import { KnowledgeUploadSection } from "./knowledge-base-upload";
import { uploadFormatList, uploadFormats } from "./knowledge-upload-model";
import { formatFileBytes } from "./skill-form-model";

/** How a format is named on the page. */
const FORMAT_NAMES: Record<string, string> = {
  txt: "TXT",
  markdown: "Markdown",
  pdf: "PDF",
  docx: "DOCX"
};

/**
 * The documents of a published Knowledge Base that keeps documents, each with its state: being
 * indexed, searchable, or failed with the reason. Whoever may change the Knowledge Base adds
 * documents, retries a failed one and removes one they added; a document synced from a source
 * leaves only when the source withdraws it. Whoever may use the Knowledge Base sees the list,
 * and a notice while no worker takes its documents.
 */
export function KnowledgeDocuments({
  source,
  knowledgeBase,
  publishedRevision,
  canWrite
}: {
  source: KnowledgeBaseSource;
  knowledgeBase: string;
  publishedRevision: number;
  canWrite: boolean;
}) {
  const { t } = useTranslation();
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
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<number>();
  const [retrying, setRetrying] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const [removing, setRemoving] = useState<KnowledgeDocument>();
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeFailure, setRemoveFailure] = useState<string>();
  const [removed, setRemoved] = useState<string>();
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
  return (
    <div className="grid gap-3" data-knowledge-documents="">
      {canWrite ? (
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setAdded(undefined);
              setRemoved(undefined);
              setAdding(true);
            }}
            data-knowledge-add=""
          >
            <Plus aria-hidden="true" />
            {t("knowledge.addDocuments")}
          </Button>
        </div>
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
      {failure ? <FormNotice tone="error">{failure}</FormNotice> : null}
      {state.status === "ready" && state.data.processingWaiting ? (
        <FormNotice tone="error" data-knowledge-processing-waiting="">
          {t("knowledge.processingWaiting")}
        </FormNotice>
      ) : null}
      {preparing ? (
        <EmptyState layout="inline" data-knowledge-documents-preparing="">
          {t("knowledge.documentsPreparing")}
        </EmptyState>
      ) : (
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
            documents.length === 0 ? (
              <EmptyState layout="inline">
                {canWrite ? t("knowledge.documentsEmpty") : t("knowledge.documentsEmptyReadOnly")}
              </EmptyState>
            ) : (
              <>
                <List aria-label={t("knowledge.documentsTitle")}>
                  {documents.map((document) => (
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
                        // A synced document leaves when its source withdraws it, not by hand.
                        canWrite && document.sourceId === undefined
                          ? () => {
                              setRemoved(undefined);
                              setRemoveFailure(undefined);
                              setRemoving(document);
                            }
                          : undefined
                      }
                    />
                  ))}
                </List>
                {more ? (
                  <LoadMore
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
          <p>{t("knowledge.removeDescription")}</p>
          {removeFailure ? <FormNotice tone="error">{removeFailure}</FormNotice> : null}
        </div>
      </ConfirmDialog>
      {adding ? (
        <KnowledgeAddDialog
          source={source}
          knowledgeBase={knowledgeBase}
          formats={uploadFormats(state.status === "ready" ? state.data.documentFormats : undefined)}
          onClose={() => setAdding(false)}
          onAdded={(count) => {
            setAdding(false);
            setAdded(count);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * One document: its name, format and size, when it was added, its state, whether its
 * original is stored at the source, and whether its fields wait, with the reason.
 */
function DocumentRow({
  document,
  retrying,
  onRetry,
  onRemove
}: {
  document: KnowledgeDocument;
  retrying: boolean;
  /** Present where the reader may retry the document: a failed one, for whoever may change. */
  onRetry: (() => void) | undefined;
  /** Present where the reader may remove the document: whoever may change, unless it is synced. */
  onRemove: (() => void) | undefined;
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
  // A synced document whose original stays at its source keeps no copy of the file here.
  const description = [
    summary,
    ...(document.originalStatus === "released" ? [t("knowledge.originalReleased")] : []),
    ...(fieldsPending ? [fieldsPendingText] : [])
  ].join(" · ");
  return (
    <ListRow
      data-knowledge-document={document.id}
      data-knowledge-document-state={document.state}
      leading={<FileText aria-hidden="true" />}
      title={title}
      description={description}
      data-knowledge-fields-pending={fieldsPending ? "" : undefined}
      descriptionWraps="always"
      chips={
        <>
          <Badge
            tone={view.tone}
            dot={document.state !== "pending"}
            leading={document.state === "pending" ? <Spinner size="sm" /> : undefined}
          >
            {t(view.label)}
          </Badge>
          {fieldsPending ? <Badge tone="neutral">{t("knowledge.fieldsPending")}</Badge> : null}
        </>
      }
      time={formatMomentShort(document.addedAt, locale)}
      actionsVisible
      actions={
        onRetry || onRemove ? (
          <>
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
          </>
        ) : undefined
      }
    />
  );
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
  onClose,
  onAdded
}: {
  source: KnowledgeBaseSource;
  knowledgeBase: string;
  /** The formats the instance reads, which the upload offers. */
  formats: readonly string[];
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
  const size = formatFileBytes(KNOWLEDGE_ADD_LIMITS.bytes, locale);
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
                    const fit = addableFile(file, formats);
                    const on = chosen.has(fileKey(file));
                    return (
                      <li key={fileKey(file)} data-knowledge-add-file={file.name}>
                        <Checkbox
                          label={file.name}
                          description={
                            fit.addable
                              ? `${file.conversationTitle} · ${formatFileBytes(file.bytes, locale)}`
                              : t(fit.reason, { size, formats: formatList })
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
