import type { SourceMessagePartProps } from "@assistant-ui/react";
import { ExternalLink, FileText } from "lucide-react";
import { useState } from "react";
import {
  readKnowledgeCitationSources,
  type KnowledgeCitationSource
} from "@work-shape/catalyst-core";
import { Chip, Spinner } from "@work-shape/catalyst-ui";
import { useOptionalWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { useTranslation } from "../../shared/i18n";
import { apiErrorCode, apiErrorStatus } from "../../shared/workspace-utils";
import { saveBlobAsFile } from "../files/conversation-file-content";

export function AssistantSourcePart(part: SourceMessagePartProps) {
  const knowledge =
    part.sourceType === "document"
      ? readKnowledgeCitationSources([part.providerMetadata?.vivdCatalyst?.knowledge])[0]
      : undefined;
  if (knowledge) {
    return <KnowledgeSourceChips source={knowledge} />;
  }
  if (part.sourceType === "url") {
    const label = sourcePartLabel(part);
    const host = sourceUrlHost(part.url);
    return (
      <a
        className="chat-source-chip my-2 mr-2 inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs font-medium text-muted-foreground shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        href={part.url}
        target="_blank"
        rel="noreferrer noopener"
        title={part.title ?? part.url}
      >
        <ExternalLink size={13} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 truncate">{label}</span>
        {host && host !== label ? (
          <span className="max-w-32 shrink truncate text-muted-foreground/80">{host}</span>
        ) : null}
      </a>
    );
  }

  return (
    <div
      className="chat-source-chip my-2 mr-2 inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs font-medium text-muted-foreground shadow-xs"
      title={part.filename ?? part.title}
    >
      <FileText size={13} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 truncate">{sourcePartLabel(part)}</span>
    </div>
  );
}

function sourcePartLabel(part: SourceMessagePartProps): string {
  if (part.title?.trim()) {
    return part.title.trim();
  }
  if (part.sourceType === "document") {
    return part.filename?.trim() || part.mediaType;
  }
  return sourceUrlHost(part.url) || part.url;
}

function sourceUrlHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** How long an opened source's address stays valid, for its tab to load it. */
const OPENED_SOURCE_URL_MS = 60_000;

/**
 * The chip of a cited Knowledge Base passage, "file name, p. 4". A click reads the file through
 * the API, with the reader's own session or token, and opens it at the page in a new tab; a
 * blocked tab saves it instead. A removed source says so and opens nothing. Beside it, the
 * passage's origin link where it has one.
 */
function KnowledgeSourceChips({ source }: { source: KnowledgeCitationSource }) {
  const { t } = useTranslation();
  const api = useOptionalWorkspaceApiClient();
  const [state, setState] = useState<"idle" | "opening" | "removed" | "failed">("idle");
  const label =
    source.page === undefined
      ? source.fileName
      : `${source.fileName}, ${t("knowledge.citationPage", { page: String(source.page) })}`;
  const open = async () => {
    if (!api) return;
    setState("opening");
    try {
      const blob = await api.client.knowledge_bases.open_document({
        params: { knowledgeBase: source.knowledgeBase, documentId: source.documentId }
      });
      const url = URL.createObjectURL(blob);
      const tab = window.open(
        source.page === undefined ? url : `${url}#page=${source.page}`,
        "_blank"
      );
      if (tab) {
        tab.opener = null;
        window.setTimeout(() => URL.revokeObjectURL(url), OPENED_SOURCE_URL_MS);
      } else {
        URL.revokeObjectURL(url);
        saveBlobAsFile(blob, source.fileName);
      }
      setState("idle");
    } catch (error) {
      // The instance answers 404 for a removed, withdrawn or no longer reachable document.
      setState(
        apiErrorCode(error) === "NOT_FOUND" || apiErrorStatus(error) === 404 ? "removed" : "failed"
      );
    }
  };
  const origin = safeOriginLink(source.originLink);
  return (
    <>
      <Chip
        className="chat-source-chip"
        leading={state === "opening" ? <Spinner size="sm" /> : <FileText aria-hidden="true" />}
        {...(api && state !== "removed" && state !== "opening"
          ? {
              onClick: () => {
                open().catch(() => undefined);
              }
            }
          : {})}
      >
        <span data-knowledge-source={source.documentId} data-knowledge-source-state={state}>
          {state === "removed"
            ? t("knowledge.citationRemoved", { name: label })
            : state === "failed"
              ? t("knowledge.citationFailed", { name: label })
              : label}
        </span>
      </Chip>
      {origin ? (
        <Chip
          className="chat-source-chip"
          leading={<ExternalLink aria-hidden="true" />}
          href={origin.href}
          onClick={(event) => {
            event.preventDefault();
            window.open(origin.href, "_blank", "noopener,noreferrer");
          }}
        >
          {origin.host}
        </Chip>
      ) : null}
    </>
  );
}

/** An origin link that is a web address, with the host it names; anything else is left out. */
function safeOriginLink(link: string | undefined): { href: string; host: string } | undefined {
  if (!link) return undefined;
  try {
    const url = new URL(link);
    return url.protocol === "https:" || url.protocol === "http:"
      ? { href: url.href, host: url.host }
      : undefined;
  } catch {
    return undefined;
  }
}
