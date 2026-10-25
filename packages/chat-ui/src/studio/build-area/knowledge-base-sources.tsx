import { FolderSync, Plug, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import {
  Badge,
  Button,
  Chip,
  EmptyState,
  Field,
  FormNotice,
  KeyValue,
  KeyValueList,
  List,
  Picker,
  PickerButton,
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
import { sourceFailureText, sourceItemCounts, sourceStateView } from "./knowledge-source-status";
import { newKnowledgeSource, type KnowledgeSourceForm } from "./knowledge-sources-model";
import type { ActionNotice } from "./build-model";
import { useOptionalBuildNavigation } from "../../shared/build-route";
import { requestBuildCreateDialog } from "./build-create-request";
import { CONNECTIONS_BUILD_PATH } from "./connection-tools";
import { offerText } from "./connection-typed-model";
import type { PagedItems } from "./paged-items";
import { DataFlowRow, type DataFlowPage } from "./data-flows";
import type { DataFlowRef } from "./data-flows-model";

// The synced sources of a Knowledge Base of documents (SRC-2): each reads the folders it names
// through a Connection whose type is a document source. The list is part of the draft: a source
// added, narrowed or removed takes effect at publish, where the question names who finds what.
// Once published, each shows how far its sync is, why items failed, and for who may change the
// Knowledge Base, Sync now and Try again.
// A Workflow that calls `ingest` is a source of its own (KBW-1): it is never authored in the
// draft, so it is listed from the published state alone, with its Workflow, its last run and
// how fresh that makes it. Its Workflow's runs decide what it holds, so it has no Sync now and
// no Try again here. A document a person removed by hand stays out of every later run; only
// who may publish the Knowledge Base lets it back in, with Allow again (KBW-2b).

/** The search of the Connection chooser before the reader types. */
const NO_SEARCH = "";

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
  const fedByWorkflows =
    status?.status === "ready" && knowledgeBase !== undefined && published !== undefined
      ? status.data.sources.filter((entry): entry is WorkflowSourceStatus => "workflowId" in entry)
      : [];
  const change = (id: string, patch: Partial<KnowledgeSourceForm>) =>
    onChange(sources.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  const [search, setSearch] = useState(NO_SEARCH);
  const read = source.useSourceConnections?.(search, owner);
  // Where no Connection can be chosen at all, one neutral line says what to connect first,
  // instead of an empty list, an empty chooser and its error.
  const noneToChoose =
    canWrite && read?.status === "ready" && read.data.items.length === 0 && search === NO_SEARCH;
  return (
    <div className="grid gap-4" data-knowledge-sources="">
      {fedByWorkflows.length > 0 ? (
        <ul aria-label={t("knowledgeSources.workflowSources")} className="grid gap-3">
          {fedByWorkflows.map((entry) => (
            <WorkflowSourceItem
              key={entry.id}
              source={source}
              knowledgeBase={knowledgeBase ?? ""}
              status={entry}
              workflow={workflows?.find((flow) => flow.name === entry.workflowId)}
              page={workflowPage?.(entry.workflowId)}
              canPublish={canPublish}
            />
          ))}
        </ul>
      ) : null}
      {(noneToChoose || fedByWorkflows.length > 0) &&
      sources.length === 0 ? null : sources.length === 0 ? (
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
      {noneToChoose ? (
        <NoSourceConnection source={source} />
      ) : canWrite && read !== undefined ? (
        <>
          <AddSource
            read={read}
            onSearchChange={setSearch}
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
  canWrite,
  fedByWorkflow = false,
  canRelease = false
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
}) {
  const { locale, t } = useTranslation();
  const [busy, setBusy] = useState<"sync" | KnowledgeSourceFailureCode>();
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
      {fedByWorkflow && status.last?.endedAt ? (
        <p className="text-caption text-muted-foreground" data-knowledge-source-freshness="">
          {t("knowledgeSources.workflowFreshness", {
            elapsed: formatElapsed(status.last.endedAt, new Date(), locale)
          })}
        </p>
      ) : null}
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
      {canWrite && !fedByWorkflow && source.syncSource ? (
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
  canPublish
}: {
  source: KnowledgeBaseSource;
  knowledgeBase: string;
  status: WorkflowSourceStatus;
  canPublish: boolean;
  /** The Workflow as the state names it; absent where the reader may not read it. */
  workflow: DataFlowRef | undefined;
  page: ReturnType<DataFlowPage> | undefined;
}) {
  const { t } = useTranslation();
  return (
    <li
      className="grid min-w-0 gap-3 rounded-md border p-4"
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
  const navigation = useOptionalBuildNavigation();
  const connections = { kindPath: CONNECTIONS_BUILD_PATH };
  return (
    <EmptyState
      layout="inline"
      data-knowledge-sources-none=""
      action={
        types !== undefined && types.length > 0 && navigation ? (
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
        ) : undefined
      }
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
