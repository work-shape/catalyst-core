import type { SourceMessagePartProps } from "@assistant-ui/react";
import { ExternalLink, FileText } from "lucide-react";
import {
  readKnowledgeCitationSources,
  type KnowledgeCitationSource
} from "@work-shape/catalyst-core";
import { useAttachmentContentContext } from "../files/attachment-content";
import { KnowledgeCitationChip, KnowledgeSources } from "./knowledge-citation-chip";

/** The Knowledge Base passage a source part of an answer cites, if it cites one. */
export function knowledgeCitationOfPart(part: {
  type: string;
  sourceType?: string;
  providerMetadata?: { vivdCatalyst?: { knowledge?: unknown } } | undefined;
}): KnowledgeCitationSource | undefined {
  return part.type === "source" && part.sourceType === "document"
    ? readKnowledgeCitationSources([part.providerMetadata?.vivdCatalyst?.knowledge])[0]
    : undefined;
}

export function AssistantSourcePart(part: SourceMessagePartProps) {
  const conversation = useConversationOfCitation();
  const knowledge = knowledgeCitationOfPart(part);
  if (knowledge) {
    return <KnowledgeCitationChip citation={knowledge} {...conversation} />;
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

/**
 * The conversation a citation stands in: its workspace is where the reader may use the
 * Knowledge Base through availability.
 */
function useConversationOfCitation(): { conversationId?: string } {
  const conversationId = useAttachmentContentContext()?.selectedConversationId;
  return conversationId ? { conversationId } : {};
}

/** The row of the Knowledge Base documents an answer cites, one chip per document. */
export function AssistantKnowledgeSources({
  citations
}: {
  citations: readonly KnowledgeCitationSource[];
}) {
  const conversation = useConversationOfCitation();
  return citations.length === 0 ? null : (
    <KnowledgeSources className="mt-2" citations={citations} {...conversation} />
  );
}
