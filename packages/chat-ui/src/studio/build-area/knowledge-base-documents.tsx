import { FileText, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
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
  KNOWLEDGE_DOCUMENT_STATE_VIEWS
} from "./knowledge-base-model";
import type {
  KnowledgeBaseSource,
  KnowledgeDocument,
  KnowledgeOpenableFile
} from "./knowledge-base-source";
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
 * documents, retries a failed one and removes one; whoever may use it sees the list.
 */
export function KnowledgeDocuments({
  source,
  knowledgeBase,
  canWrite
}: {
  source: KnowledgeBaseSource;
  knowledgeBase: string;
  canWrite: boolean;
}) {
  const { t } = useTranslation();
  const read = source.useDocuments(knowledgeBase);
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
    setRemoveFailure(
      answer.refused ? t("knowledge.retryRefused") : (answer.message ?? t("knowledge.removeFailed"))
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
      <ReadState
        read={read}
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
                      canWrite
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
                <div>
                  <Button variant="ghost" size="sm" loading={more.loading} onClick={more.load}>
                    {t("knowledge.documentsMore")}
                  </Button>
                </div>
              ) : null}
            </>
          )
        }
      </ReadState>
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

/** One document: its name, format and size, when it was added, and its state. */
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
  /** Present where the reader may remove the document: whoever may change. */
  onRemove: (() => void) | undefined;
}) {
  const { locale, t } = useTranslation();
  const view = KNOWLEDGE_DOCUMENT_STATE_VIEWS[document.state];
  const title = document.title || document.fileName;
  const facts = `${FORMAT_NAMES[document.format] ?? document.format} · ${formatFileBytes(document.bytes, locale)}`;
  return (
    <ListRow
      data-knowledge-document={document.id}
      data-knowledge-document-state={document.state}
      leading={<FileText aria-hidden="true" />}
      title={title}
      description={document.state === "failed" ? t(documentFailureText(document)) : facts}
      descriptionWraps={document.state === "failed"}
      chips={
        <Badge
          tone={view.tone}
          dot={document.state !== "pending"}
          leading={document.state === "pending" ? <Spinner size="sm" /> : undefined}
        >
          {t(view.label)}
        </Badge>
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
 * Adds files the reader can open: those uploaded in the conversations of their workspace. It
 * says the limits of one add and keeps to them: at most so many files, none over the size
 * limit, and only formats a Knowledge Base reads.
 */
export function KnowledgeAddDialog({
  source,
  knowledgeBase,
  onClose,
  onAdded
}: {
  source: KnowledgeBaseSource;
  knowledgeBase: string;
  onClose(): void;
  onAdded(count: number): void;
}) {
  const { locale, t } = useTranslation();
  const [search, setSearch] = useState("");
  const read = source.useOpenableFiles(search.trim(), true);
  const [chosen, setChosen] = useState<ReadonlyMap<string, KnowledgeOpenableFile>>(new Map());
  const [adding, setAdding] = useState(false);
  const [failure, setFailure] = useState<string>();
  const full = chosen.size >= KNOWLEDGE_ADD_LIMITS.files;
  const size = formatFileBytes(KNOWLEDGE_ADD_LIMITS.bytes, locale);
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
      onAdded(answer.data.count);
      return;
    }
    const known = answer.reason === undefined ? undefined : KNOWLEDGE_ADD_REFUSALS[answer.reason];
    setFailure(
      answer.refused
        ? t("knowledge.addRefused")
        : known
          ? t(known, { size })
          : (answer.message ?? t("knowledge.addFailed"))
    );
  };
  return (
    <Dialog
      open
      size="md"
      title={t("knowledge.addDocuments")}
      description={t("knowledge.addDescription")}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
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
        <Field
          label={t("knowledge.addSearch")}
          hint={t("knowledge.addLimits", {
            count: String(KNOWLEDGE_ADD_LIMITS.files),
            size
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
          {(files) =>
            files.length === 0 ? (
              <EmptyState layout="inline">
                {search.trim() ? t("knowledge.addNoMatch") : t("knowledge.addNoFiles")}
              </EmptyState>
            ) : (
              <ul aria-label={t("knowledge.addFiles")} className="grid gap-3">
                {files.map((file) => {
                  const fit = addableFile(file);
                  const on = chosen.has(fileKey(file));
                  return (
                    <li key={fileKey(file)} data-knowledge-add-file={file.name}>
                      <Checkbox
                        label={file.name}
                        description={
                          fit.addable
                            ? `${file.conversationTitle} · ${formatFileBytes(file.bytes, locale)}`
                            : t(fit.reason, { size })
                        }
                        checked={on}
                        disabled={!fit.addable || (full && !on)}
                        onCheckedChange={(next) => toggle(file, next)}
                      />
                    </li>
                  );
                })}
              </ul>
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
