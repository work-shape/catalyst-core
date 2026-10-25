import { RotateCw } from "lucide-react";
import { useState } from "react";
import {
  Banner,
  Button,
  ConfirmDialog,
  FormNotice,
  KeyValue,
  KeyValueList,
  Progress,
  SkeletonList
} from "@work-shape/catalyst-ui";
import type { LocaleCode } from "@work-shape/catalyst-api-client";
import { useTranslation } from "../../shared/i18n";
import { formatEmbeddingCost } from "./knowledge-cost";
import type {
  KnowledgeBaseSource,
  KnowledgeEmbeddingState,
  KnowledgeReindexAnswer
} from "./knowledge-base-source";

type Statement = NonNullable<KnowledgeReindexAnswer["statement"]>;

/**
 * The embedding of a Knowledge Base that searches by meaning: the model search answers with,
 * what it is set to where that differs, a re-index under way, and the way to start one for who
 * may publish it. The old index answers until the new one is complete. One with searchable
 * documents and no index, as one published before semantic search embedded what was there,
 * is offered to embed them.
 */
export function KnowledgeEmbedding({
  embedding,
  source,
  knowledgeBase,
  canReindex
}: {
  embedding: KnowledgeEmbeddingState;
  source: KnowledgeBaseSource;
  knowledgeBase: string;
  canReindex: boolean;
}) {
  const { locale, t } = useTranslation();
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const { state, active, target, progress } = embedding;
  const mayStart = canReindex && source.reindex !== undefined && target !== undefined;
  // Nothing embedded yet: worth offering only where a document is searchable, so has passages.
  const first = state === "none";
  const documents = source.useDocuments(knowledgeBase, mayStart && first);
  const unembedded =
    first &&
    documents.status === "ready" &&
    documents.data.documents.some((document) => document.state === "indexed");
  const offered =
    mayStart && (state === "reindex_needed" || state === "reindex_available" || unembedded);
  // With no index answering by meaning yet, as after turning it on, the first one is built.
  const building = t(active ? "knowledge.reindexing" : "knowledge.embeddingFirst", {
    model: target?.model ?? ""
  });
  return (
    <div className="grid min-w-0 gap-3" data-knowledge-embedding={state}>
      <KeyValueList>
        <KeyValue label={t("knowledge.embeddingModel")}>
          {active?.model ?? t("knowledge.embeddingModelNone")}
        </KeyValue>
      </KeyValueList>
      {state === "reindex_needed" ? (
        <Banner tone="warning" title={t("knowledge.embeddingNeededTitle")}>
          {t("knowledge.embeddingNeeded")}
        </Banner>
      ) : state === "reindex_available" && active && target ? (
        <Banner tone="info">
          {t("knowledge.embeddingAvailable", { target: target.model, active: active.model })}
        </Banner>
      ) : state === "reindexing" && progress ? (
        <div className="grid min-w-0 gap-1.5" data-knowledge-reindexing="">
          <p className="text-label">{building}</p>
          <Progress
            label={building}
            value={progress.embedded}
            max={Math.max(progress.total, 1)}
            tone="info"
            valueLabel={t("knowledge.reindexProgress", {
              embedded: number(progress.embedded),
              total: number(progress.total)
            })}
          />
          <p className="text-label text-muted-foreground">
            {t(active ? "knowledge.reindexingNote" : "knowledge.embeddingFirstNote")}
          </p>
        </div>
      ) : unembedded ? (
        <p className="text-label text-muted-foreground">{t("knowledge.embeddingNone")}</p>
      ) : null}
      {offered && source.reindex ? (
        <ReindexAction
          reindex={(confirm) => source.reindex?.(knowledgeBase, confirm)}
          locale={locale}
          first={first}
        />
      ) : null}
    </div>
  );
}

/**
 * The Re-index button and its question: the statement is read first, and only its own
 * confirmation starts the re-index. A statement that changed meanwhile is shown again.
 */
function ReindexAction({
  reindex,
  locale,
  first
}: {
  reindex: (
    confirm?: string
  ) => ReturnType<NonNullable<KnowledgeBaseSource["reindex"]>> | undefined;
  locale: LocaleCode;
  /** Nothing is embedded yet: the passages are embedded, not embedded again. */
  first: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [statement, setStatement] = useState<Statement>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const close = () => {
    setOpen(false);
    setStatement(undefined);
    setNotice(undefined);
  };
  const ask = async () => {
    setOpen(true);
    setBusy(true);
    const answer = await reindex();
    setBusy(false);
    if (!answer?.ok) {
      setNotice(answer?.message ?? t("knowledge.reindexFailed"));
      return;
    }
    // Nothing to re-index any more, or one under way: the page's state says which.
    if (!answer.data.statement) return close();
    setStatement(answer.data.statement);
  };
  const confirm = async () => {
    if (!statement) return;
    setBusy(true);
    const answer = await reindex(statement.confirmation);
    setBusy(false);
    if (!answer?.ok) {
      setNotice(answer?.message ?? t("knowledge.reindexFailed"));
      return;
    }
    if (answer.data.started || !answer.data.statement) return close();
    setStatement(answer.data.statement);
    setNotice(t("knowledge.reindexChanged"));
  };
  return (
    <>
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            ask().catch(() => undefined);
          }}
          data-knowledge-reindex=""
        >
          <RotateCw aria-hidden="true" />
          {t(first ? "knowledge.embedAction" : "knowledge.reindexAction")}
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        tone="primary"
        title={t(first ? "knowledge.embedTitle" : "knowledge.reindexTitle")}
        confirmLabel={t(first ? "knowledge.embedConfirm" : "knowledge.reindexConfirm")}
        loading={busy && statement !== undefined}
        confirmDisabled={statement === undefined || !statement.room || busy}
        onConfirm={() => {
          confirm().catch(() => undefined);
        }}
        onClose={close}
      >
        {statement ? (
          <ReindexStatement statement={statement} locale={locale} first={first} />
        ) : busy ? (
          <SkeletonList rows={2} />
        ) : null}
        {notice ? (
          <FormNotice tone="error" className="mt-3">
            {notice}
          </FormNotice>
        ) : null}
      </ConfirmDialog>
    </>
  );
}

/** What a re-index embeds, what it costs and whether the store has room, in the reader's words. */
function ReindexStatement({
  statement,
  locale,
  first
}: {
  statement: Statement;
  locale: LocaleCode;
  first: boolean;
}) {
  const { t } = useTranslation();
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const megabytes = (bytes: number) =>
    new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "megabyte",
      maximumFractionDigits: 1
    }).format(bytes / 1_000_000);
  return (
    <div className="grid gap-2" data-knowledge-reindex-statement="">
      <p>
        {t(first ? "knowledge.embedStatement" : "knowledge.reindexStatement", {
          model: statement.model,
          chunks: number(statement.chunks),
          tokens: number(statement.tokens)
        })}
      </p>
      <p>
        {statement.cost
          ? t("knowledge.reindexCost", {
              cost: formatEmbeddingCost(statement.cost.amount, statement.cost.currency, locale)
            })
          : t("knowledge.reindexNoPrice")}
      </p>
      <p>{t(first ? "knowledge.embeddingFirstNote" : "knowledge.reindexKeeps")}</p>
      {statement.room ? null : (
        <FormNotice tone="error">
          {t("knowledge.reindexNoRoom", {
            used: megabytes(statement.storeBytes),
            added: megabytes(statement.addedBytes),
            limit: megabytes(statement.limitBytes ?? 0)
          })}
        </FormNotice>
      )}
    </div>
  );
}
