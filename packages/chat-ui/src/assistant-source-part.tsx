import type { SourceMessagePartProps } from "@assistant-ui/react";
import { ExternalLink, FileText } from "lucide-react";

export function AssistantSourcePart(part: SourceMessagePartProps) {
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
