import {
  KNOWLEDGE_SOURCE_UNREACHABLE,
  knowledgeDocumentFormatOf,
  resolveFilePreviewCapability
} from "@work-shape/catalyst-core";
import { FileText } from "lucide-react";
import { useState } from "react";
import { Chip, Spinner } from "@work-shape/catalyst-ui";
import { useOptionalWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { useTranslation } from "../../shared/i18n";
import { apiErrorCode, apiErrorReason, apiErrorStatus } from "../../shared/workspace-utils";
import { saveBlobAsFile } from "../files/conversation-file-content";
import { rasterImageType, viewerObjectUrl, type FileViewer } from "../files/viewer-object-url";

/** How long an opened source's address stays valid, for its tab to load it. */
const OPENED_SOURCE_URL_MS = 60_000;

/** The document and page a passage or a value cites, by the Knowledge Base's name. */
export interface KnowledgeCitation {
  knowledgeBase: string;
  documentId: string;
  fileName: string;
  page?: number;
  /** The name of the sheet a spreadsheet's passage is on. */
  sheet?: string;
  /** The date the document states of its version, such as the "Stand" of a web page (KB-WEB). */
  statedAt?: string;
  /** When the platform fetched the synced document. */
  retrievedAt?: string;
}

/**
 * "Stand 01.11.2026" for the date the document states of itself, else "abgerufen 10.11.2026"
 * for when it was fetched, in the reader's language. Any other date of the source is never
 * shown as its "Stand".
 */
function knowledgeCitationDate(
  t: ReturnType<typeof useTranslation>["t"],
  locale: string,
  citation: Pick<KnowledgeCitation, "statedAt" | "retrievedAt">
): string | undefined {
  const day = (value: string | undefined) => {
    const at = value === undefined ? undefined : new Date(value);
    if (at === undefined || Number.isNaN(at.getTime())) return undefined;
    return new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: "UTC"
    }).format(at);
  };
  const stated = day(citation.statedAt);
  if (stated !== undefined) return t("knowledge.citationAsOf", { date: stated });
  const retrieved = day(citation.retrievedAt);
  return retrieved === undefined
    ? undefined
    : t("knowledge.citationRetrieved", { date: retrieved });
}

/**
 * Where in an office file a passage is, as the file counts it: a spreadsheet's sheet, by its name
 * where the passage knows it, or a slide. Nothing for a file of pages, which the caller says its
 * own way.
 */
export function knowledgeOfficePlace(
  t: ReturnType<typeof useTranslation>["t"],
  citation: Pick<KnowledgeCitation, "fileName" | "page" | "sheet">
): string | undefined {
  const format = knowledgeDocumentFormatOf({ filename: citation.fileName });
  if (format === "xlsx" && citation.sheet) return citation.sheet;
  if ((format !== "xlsx" && format !== "pptx") || citation.page === undefined) return undefined;
  const page = String(citation.page);
  return t(format === "xlsx" ? "knowledge.citationSheet" : "knowledge.citationSlide", { page });
}

/**
 * The chip of a cited Knowledge Base passage, "file name, p. 4", in a spreadsheet "file name,
 * sheet name" and in a deck "file name, slide 4". A click reads the file through
 * the API, with the reader's own session or token, and opens it at the page in a new tab; a
 * blocked tab, or a file no viewer of ours shows, saves it instead. A removed source says so and
 * opens nothing. A synced document whose source cannot be reached says so ("Quelle nicht
 * erreichbar") and can be tried again; the passage the answer cites stays readable beside it
 * (KB-13). An answer in a conversation names it, as its workspace is where the reader may use
 * the Knowledge Base.
 */
export function KnowledgeCitationChip({
  citation,
  conversationId,
  className
}: {
  citation: KnowledgeCitation;
  conversationId?: string;
  className?: string;
}) {
  const { locale, t } = useTranslation();
  const api = useOptionalWorkspaceApiClient();
  const [state, setState] = useState<"idle" | "opening" | "removed" | "unreachable" | "failed">(
    "idle"
  );
  const place =
    knowledgeOfficePlace(t, citation) ??
    (citation.page === undefined
      ? undefined
      : t("knowledge.citationPage", { page: String(citation.page) }));
  const asOf = knowledgeCitationDate(t, locale, citation);
  const label = [citation.fileName, place, asOf].filter((part) => part !== undefined).join(", ");
  const open = async () => {
    if (!api) return;
    setState("opening");
    try {
      const blob = await api.client.knowledge_bases.open_document({
        params: { knowledgeBase: citation.knowledgeBase, documentId: citation.documentId },
        ...(conversationId ? { query: { conversationId } } : {})
      });
      const viewer = citationViewer(citation.fileName, blob.type);
      if (!viewer) {
        saveBlobAsFile(blob, citation.fileName);
        setState("idle");
        return;
      }
      const url = viewerObjectUrl(blob, viewer);
      const tab = window.open(
        citation.page === undefined ? url : `${url}#page=${citation.page}`,
        "_blank"
      );
      if (tab) {
        tab.opener = null;
        window.setTimeout(() => URL.revokeObjectURL(url), OPENED_SOURCE_URL_MS);
      } else {
        URL.revokeObjectURL(url);
        saveBlobAsFile(blob, citation.fileName);
      }
      setState("idle");
    } catch (error) {
      // The instance answers 404 for a removed or withdrawn document, and names the source of a
      // synced one that it cannot reach.
      setState(
        apiErrorReason(error) === KNOWLEDGE_SOURCE_UNREACHABLE
          ? "unreachable"
          : apiErrorCode(error) === "NOT_FOUND" || apiErrorStatus(error) === 404
            ? "removed"
            : "failed"
      );
    }
  };
  return (
    <Chip
      {...(className ? { className } : {})}
      leading={state === "opening" ? <Spinner size="sm" /> : <FileText aria-hidden="true" />}
      {...(api && state !== "removed" && state !== "opening"
        ? {
            onClick: () => {
              open().catch(() => undefined);
            }
          }
        : {})}
    >
      <span data-knowledge-source={citation.documentId} data-knowledge-source-state={state}>
        {state === "removed"
          ? t("knowledge.citationRemoved", { name: label })
          : state === "unreachable"
            ? t("knowledge.citationUnreachable", { name: label })
            : state === "failed"
              ? t("knowledge.citationFailed", { name: label })
              : label}
      </span>
    </Chip>
  );
}

/** The viewer a cited file opens in, by its name and the type it was fetched with; an SVG has none. */
function citationViewer(fileName: string, mimeType: string): FileViewer | undefined {
  const capability = resolveFilePreviewCapability({ filename: fileName, mimeType });
  return capability === "native_pdf"
    ? "pdf"
    : capability === "native_image" && rasterImageType(mimeType)
      ? "image"
      : capability === "markdown" || capability === "text"
        ? "text"
        : undefined;
}
