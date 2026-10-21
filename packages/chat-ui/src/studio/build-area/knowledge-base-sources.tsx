import { FolderSync, Plug, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  Badge,
  Button,
  Chip,
  EmptyState,
  Field,
  FormNotice,
  KeyValue,
  KeyValueList,
  Picker,
  PickerButton,
  Textarea
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { formatMomentShort } from "../../shared/locale-format";
import type {
  KnowledgeBaseSource,
  KnowledgeSourceFailureCode,
  KnowledgeSourceStatus
} from "./knowledge-base-source";
import { sourceFailureText, sourceItemCounts, sourceStateView } from "./knowledge-source-status";
import { newKnowledgeSource, type KnowledgeSourceForm } from "./knowledge-sources-model";

// The synced sources of a Knowledge Base of documents (SRC-2): each reads the folders it names
// through a Connection whose type is a document source. The list is part of the draft: a source
// added, narrowed or removed takes effect at publish, where the question names who finds what.
// Once published, each shows how far its sync is, why items failed, and for who may change the
// Knowledge Base, Sync now and Try again.

/** The search of the Connection chooser before the reader types. */
const NO_SEARCH = "";

export function KnowledgeSourcesSection({
  source,
  knowledgeBase,
  published,
  owner,
  sources,
  canWrite,
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
  onChange(sources: KnowledgeSourceForm[]): void;
}) {
  const { t } = useTranslation();
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
  const change = (id: string, patch: Partial<KnowledgeSourceForm>) =>
    onChange(sources.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  return (
    <div className="grid gap-4" data-knowledge-sources="">
      {sources.length === 0 ? (
        <EmptyState layout="inline">
          {t(canWrite ? "knowledgeSources.empty" : "knowledgeSources.emptyReadOnly")}
        </EmptyState>
      ) : (
        <ul aria-label={t("knowledgeSources.title")} className="grid gap-3">
          {sources.map((entry) => (
            <SourceItem
              key={entry.id}
              entry={entry}
              canWrite={canWrite}
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
                />
              )}
            </SourceItem>
          ))}
        </ul>
      )}
      {canWrite ? (
        <>
          <AddSource
            source={source}
            owner={owner}
            onAdd={(connection) => onChange([...sources, newKnowledgeSource(connection, sources)])}
          />
          <p className="text-caption text-muted-foreground">{t("knowledgeSources.draftNote")}</p>
        </>
      ) : null}
    </div>
  );
}

/** One source of the draft: its Connection, its folders and its patterns. */
function SourceItem({
  entry,
  canWrite,
  onChange,
  onRemove,
  children
}: {
  entry: KnowledgeSourceForm;
  canWrite: boolean;
  onChange(patch: Partial<KnowledgeSourceForm>): void;
  onRemove(): void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <li className="grid min-w-0 gap-3 rounded-md border p-4" data-knowledge-source={entry.id}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <KeyValueList layout="stacked">
          <KeyValue label={t("knowledgeSources.connection")}>
            <span className="flex min-w-0 items-center gap-1.5">
              <Plug aria-hidden="true" className="size-4 shrink-0" />
              <code className="min-w-0 break-all font-mono text-code">{entry.connection}</code>
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
      <Field
        label={t("knowledgeSources.folders")}
        hint={t("knowledgeSources.foldersHint")}
        required
      >
        <Textarea
          rows={2}
          required
          spellCheck={false}
          value={entry.folders}
          readOnly={!canWrite}
          data-knowledge-source-field="folders"
          onChange={(event) => onChange({ folders: event.target.value })}
        />
      </Field>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <Field
          label={t("knowledgeSources.include")}
          hint={t("knowledgeSources.includeHint")}
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
          hint={t("knowledgeSources.excludeHint")}
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
      {children}
    </li>
  );
}

/** How far the sync of one published source is, and what failed in it. */
function SourceStatus({
  source,
  knowledgeBase,
  sourceId,
  status,
  canWrite
}: {
  source: KnowledgeBaseSource;
  knowledgeBase: string;
  sourceId: string;
  /** Absent while it is read, and for a source the instance does not name yet. */
  status: KnowledgeSourceStatus | undefined;
  canWrite: boolean;
}) {
  const { locale, t } = useTranslation();
  const [busy, setBusy] = useState<"sync" | KnowledgeSourceFailureCode>();
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string }>();
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
            text: t("knowledgeSources.retried", { count: number(queuedOf(answer.data)) })
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
      <KeyValueList layout="stacked">
        {status.running?.estimatedEndAt ? (
          <KeyValue label={t("knowledgeSources.estimatedEnd")}>
            {formatMomentShort(status.running.estimatedEndAt, locale)}
          </KeyValue>
        ) : null}
        {status.last?.endedAt ? (
          <KeyValue label={t("knowledgeSources.lastSync")}>
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
              {canWrite && source.retrySource ? (
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
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {notice ? <FormNotice tone={notice.tone}>{notice.text}</FormNotice> : null}
      {canWrite && source.syncSource ? (
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

/** How many items a retry queued, as the instance answered it. */
function queuedOf(answer: unknown): number {
  const queued =
    answer !== null && typeof answer === "object" && "queued" in answer ? answer.queued : undefined;
  return typeof queued === "number" ? queued : 0;
}

/** The chooser of a Connection a new source reads through. */
function AddSource({
  source,
  owner,
  onAdd
}: {
  source: KnowledgeBaseSource;
  owner: string | undefined;
  onAdd(connection: string): void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState(NO_SEARCH);
  const read = source.useSourceConnections?.(search, owner);
  if (read === undefined) return null;
  const connections = read.status === "ready" ? read.data.items : [];
  const more = read.status === "ready" ? read.data.more : undefined;
  const error =
    read.status === "failed" || read.status === "refused"
      ? t("knowledgeSources.connectionsFailed")
      : read.status === "ready" && connections.length === 0 && search === NO_SEARCH
        ? t("knowledgeSources.noConnections")
        : undefined;
  return (
    <Field label={t("knowledgeSources.add")} error={error}>
      <Picker
        search
        label={t("knowledgeSources.chooseConnection")}
        onSearchChange={(text) => setSearch(text.trim())}
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
