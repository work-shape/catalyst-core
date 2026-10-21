import { Badge, Chip, type BadgeTone } from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { formatMomentShort } from "../../shared/locale-format";
import type { BuildAssetEditorProps, BuildAssetKind, BuildAssetRow } from "./build-asset-kind";
import { KnowledgeBaseEditor } from "./knowledge-base-editor";
import {
  KNOWLEDGE_STATUS_VIEWS,
  knowledgeBaseConfigToForm,
  startedKnowledgeBaseForm
} from "./knowledge-base-model";
import {
  useKnowledgeBaseSource,
  type KnowledgeBaseSource,
  type KnowledgeBaseState,
  type KnowledgeDocumentSummary
} from "./knowledge-base-source";

/** The kind's segment in an address: `/build/knowledge-bases`. */
const KNOWLEDGE_BASES_BUILD_PATH = "knowledge-bases";

/** Stands for a number or a time the row may not show: unread, refused or not sent. */
const UNKNOWN = "—";

/**
 * What a row says of a published Knowledge Base beyond its definition: one state badge where it
 * asks for something, then for one that keeps documents how many it holds and when the last
 * one was ingested. The state is one read per row, the documents one more of a single document.
 * A Knowledge Base that answers from tables has no documents and says neither. A number the
 * reader may not read, or the instance does not send, stands as a dash.
 */
function KnowledgeBaseRowFacts({
  asset,
  useSource
}: {
  asset: BuildAssetRow;
  useSource(): KnowledgeBaseSource;
}) {
  const { locale, t } = useTranslation();
  const source = useSource();
  const read = source.useState(asset.name, asset.publishedRevision);
  const state = read.status === "ready" ? read.data : undefined;
  // Only one that keeps documents names the formats it reads.
  const keepsDocuments = state?.documentFormats !== undefined;
  const documents = source.useDocumentSummary?.(asset.name, keepsDocuments);
  const summary = documents?.status === "ready" ? documents.data : null;
  const badge = rowStateBadge(state?.status, summary?.state);
  return (
    <>
      {badge === undefined ? null : (
        <Badge tone={badge.tone} dot data-knowledge-row-state={badge.state}>
          {t(badge.label)}
        </Badge>
      )}
      {!keepsDocuments || documents?.status === "loading" ? null : (
        // The facts wrap at phone width so the last ingestion stays readable.
        <span className="flex min-w-0 flex-wrap gap-1.5" data-knowledge-row-documents={asset.name}>
          <Chip size="sm">
            {summary === null
              ? t("knowledge.rowDocuments", { count: UNKNOWN })
              : t(summary.count === 1 ? "knowledge.rowDocument" : "knowledge.rowDocuments", {
                  count: new Intl.NumberFormat(locale).format(summary.count)
                })}
          </Chip>
          <Chip size="sm">
            {t("knowledge.rowLastIngestion", {
              time:
                summary === null
                  ? UNKNOWN
                  : summary.lastIngestedAt === undefined
                    ? t("knowledge.rowNeverIngested")
                    : formatMomentShort(summary.lastIngestedAt, locale)
            })}
          </Chip>
        </span>
      )}
    </>
  );
}

/**
 * The one badge of a row: the Knowledge Base's own state where it needs attention or is being
 * prepared, else its documents' where ingestion failed or runs. A ready one shows none.
 */
function rowStateBadge(
  status: KnowledgeBaseState["status"] | undefined,
  documents: KnowledgeDocumentSummary["state"] | undefined
): { state: string; tone: BadgeTone; label: TranslationKey } | undefined {
  if (status === "needs_attention" || status === "preparing") {
    return { state: status, ...KNOWLEDGE_STATUS_VIEWS[status] };
  }
  if (documents === "failed") {
    return { state: "ingestion-failed", tone: "danger", label: "knowledge.rowIngestionFailed" };
  }
  if (documents === "pending") {
    return { state: "ingesting", tone: "info", label: "knowledge.rowIngesting" };
  }
  return undefined;
}

/**
 * Knowledge Bases in Build on the answers of `useSource`: a list, and a page that writes a
 * draft of one and publishes it. A row says what the Knowledge Base holds and its state.
 */
export function knowledgeBaseKindOn(useSource: () => KnowledgeBaseSource): BuildAssetKind {
  function KnowledgeBaseAssetEditor(frame: BuildAssetEditorProps) {
    const { asset, start } = frame;
    const source = useSource();
    const availability = source.useAvailability?.(frame);
    return (
      <KnowledgeBaseEditor
        frame={frame}
        initialForm={
          asset
            ? knowledgeBaseConfigToForm(asset.config)
            : startedKnowledgeBaseForm(start ?? { name: "", title: "" })
        }
        source={source}
        {...(availability === undefined ? {} : { availability })}
      />
    );
  }
  return {
    kind: "knowledge_base",
    path: KNOWLEDGE_BASES_BUILD_PATH,
    label: "knowledge.kind",
    description: "knowledge.description",
    searchLabel: "knowledge.search",
    newLabel: "knowledge.new",
    titleLabel: "knowledge.titleLabel",
    deleteTitle: "knowledge.deleteTitle",
    deleteDescription: "knowledge.deleteDescription",
    emptyText: "knowledge.empty",
    emptyReadOnlyText: "knowledge.emptyReadOnly",
    missingText: "knowledge.missing",
    icon: "knowledge_base",
    editsWithAgent: true,
    // A synced source names who finds what in it, with which account (SRC-2).
    asksBeforePublish: true,
    rowText: (asset) => asset.description,
    badges: (asset) => <KnowledgeBaseRowFacts asset={asset} useSource={useSource} />,
    Editor: KnowledgeBaseAssetEditor
  };
}

/** Knowledge Bases in Build on the instance's own answers. */
export const knowledgeBaseKind = knowledgeBaseKindOn(useKnowledgeBaseSource);
