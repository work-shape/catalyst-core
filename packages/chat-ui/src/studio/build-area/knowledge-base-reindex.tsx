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
import type {
  KnowledgeBaseSource,
  KnowledgeEmbeddingState,
  KnowledgeReindexAnswer
} from "./knowledge-base-source";

type Statement = NonNullable<KnowledgeReindexAnswer["statement"]>;

/**
 * The embedding of a Knowledge Base that searches by meaning: the model search answers with,
 * what it is set to where that differs, a re-index under way, and the way to start one for who
 * may publish it. The old index answers until the new one is complete.
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
  const offered =
    canReindex &&
    source.reindex !== undefined &&
    target !== undefined &&
    (state === "reindex_needed" || state === "reindex_available");
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
      ) : null}
      {offered && source.reindex ? (
        <ReindexAction
          reindex={(confirm) => source.reindex?.(knowledgeBase, confirm)}
          locale={locale}
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
  locale
}: {
  reindex: (
    confirm?: string
  ) => ReturnType<NonNullable<KnowledgeBaseSource["reindex"]>> | undefined;
  locale: LocaleCode;
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
          {t("knowledge.reindexAction")}
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        tone="primary"
        title={t("knowledge.reindexTitle")}
        confirmLabel={t("knowledge.reindexConfirm")}
        loading={busy && statement !== undefined}
        confirmDisabled={statement === undefined || !statement.room || busy}
        onConfirm={() => {
          confirm().catch(() => undefined);
        }}
        onClose={close}
      >
        {statement ? (
          <ReindexStatement statement={statement} locale={locale} />
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
function ReindexStatement({ statement, locale }: { statement: Statement; locale: LocaleCode }) {
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
        {t("knowledge.reindexStatement", {
          model: statement.model,
          chunks: number(statement.chunks),
          tokens: number(statement.tokens)
        })}
      </p>
      <p>
        {statement.cost
          ? t("knowledge.reindexCost", {
              // Cents from one unit up; below it two significant digits, never a bare 0.
              cost: new Intl.NumberFormat(locale, {
                style: "currency",
                currency: statement.cost.currency,
                ...(statement.cost.amount >= 1 || statement.cost.amount === 0
                  ? {}
                  : { maximumSignificantDigits: 2 })
              }).format(statement.cost.amount)
            })
          : t("knowledge.reindexNoPrice")}
      </p>
      <p>{t("knowledge.reindexKeeps")}</p>
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
