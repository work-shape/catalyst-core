import { FileText } from "lucide-react";
import { useState } from "react";
import { Chip, Spinner } from "@work-shape/catalyst-ui";
import { useOptionalWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { useTranslation } from "../../shared/i18n";
import { apiErrorCode, apiErrorStatus } from "../../shared/workspace-utils";
import { saveBlobAsFile } from "../files/conversation-file-content";

/** How long an opened source's address stays valid, for its tab to load it. */
const OPENED_SOURCE_URL_MS = 60_000;

/** The document and page a passage or a value cites, by the Knowledge Base's name. */
export interface KnowledgeCitation {
  knowledgeBase: string;
  documentId: string;
  fileName: string;
  page?: number;
}

/**
 * The chip of a cited Knowledge Base passage, "file name, p. 4". A click reads the file through
 * the API, with the reader's own session or token, and opens it at the page in a new tab; a
 * blocked tab saves it instead. A removed source says so and opens nothing. An answer in a
 * conversation names it, as its workspace is where the reader may use the Knowledge Base.
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
  const { t } = useTranslation();
  const api = useOptionalWorkspaceApiClient();
  const [state, setState] = useState<"idle" | "opening" | "removed" | "failed">("idle");
  const label =
    citation.page === undefined
      ? citation.fileName
      : `${citation.fileName}, ${t("knowledge.citationPage", { page: String(citation.page) })}`;
  const open = async () => {
    if (!api) return;
    setState("opening");
    try {
      const blob = await api.client.knowledge_bases.open_document({
        params: { knowledgeBase: citation.knowledgeBase, documentId: citation.documentId },
        ...(conversationId ? { query: { conversationId } } : {})
      });
      const url = URL.createObjectURL(blob);
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
      // The instance answers 404 for a removed, withdrawn or no longer reachable document.
      setState(
        apiErrorCode(error) === "NOT_FOUND" || apiErrorStatus(error) === 404 ? "removed" : "failed"
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
          : state === "failed"
            ? t("knowledge.citationFailed", { name: label })
            : label}
      </span>
    </Chip>
  );
}
