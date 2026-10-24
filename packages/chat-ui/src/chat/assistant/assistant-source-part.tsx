import type { SourceMessagePartProps } from "@assistant-ui/react";
import { ExternalLink, FileText } from "lucide-react";
import {
  readKnowledgeCitationSources,
  type KnowledgeCitationSource
} from "@work-shape/catalyst-core";
import { Chip } from "@work-shape/catalyst-ui";
import { useAttachmentContentContext } from "../files/attachment-content";
import { KnowledgeCitationChip } from "./knowledge-citation-chip";

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

/**
 * The chips of a cited Knowledge Base passage: the passage itself, and beside it its origin
 * link where it has one.
 */
function KnowledgeSourceChips({ source }: { source: KnowledgeCitationSource }) {
  // The conversation the citation stands in: its workspace is where the reader may use the
  // Knowledge Base through availability.
  const conversationId = useAttachmentContentContext()?.selectedConversationId;
  const origin = safeOriginLink(source.originLink);
  return (
    <>
      <KnowledgeCitationChip
        className="chat-source-chip"
        citation={source}
        {...(conversationId ? { conversationId } : {})}
      />
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
