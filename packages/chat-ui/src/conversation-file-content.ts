import type { ApiClient } from "@vivd-catalyst/api-client";
import { useEffect, useState } from "react";

export type ConversationFileContentRef =
  { kind: "artifact"; artifactId: string } | { kind: "source_file"; fileId: string };

export type ConversationFileBlobState =
  | { status: "loading" }
  | { status: "ready"; blob: Blob; url?: string }
  | { status: "failed"; error: unknown };

export function conversationFileContentUrl(
  client: ApiClient,
  conversationId: string,
  content: ConversationFileContentRef,
  inline = false
): string {
  return content.kind === "artifact"
    ? client.urlFor("conversations.artifacts.get_content", {
        params: { conversationId, artifactId: content.artifactId },
        query: inline ? { inline: "true" } : {}
      })
    : client.urlFor("conversations.files.get_content", {
        params: { conversationId, fileId: content.fileId }
      });
}

export function loadConversationFileBlob(
  client: ApiClient,
  conversationId: string,
  content: ConversationFileContentRef,
  download = false
): Promise<Blob> {
  return content.kind === "artifact"
    ? client.conversations.artifacts.get_content({
        params: { conversationId, artifactId: content.artifactId }
      })
    : client.conversations.files.get_content({
        params: { conversationId, fileId: content.fileId },
        query: download ? { download: "true" } : {}
      });
}

export function useConversationFileBlob({
  client,
  content,
  conversationId,
  createObjectUrl = false,
  download = false,
  enabled = true
}: {
  client: ApiClient;
  content: ConversationFileContentRef;
  conversationId: string;
  createObjectUrl?: boolean;
  download?: boolean;
  enabled?: boolean;
}): ConversationFileBlobState {
  const [state, setState] = useState<ConversationFileBlobState>({ status: "loading" });
  const contentId = content.kind === "artifact" ? content.artifactId : content.fileId;

  useEffect(() => {
    if (!enabled) {
      setState({ status: "loading" });
      return undefined;
    }

    let cancelled = false;
    let objectUrl: string | undefined;
    setState({ status: "loading" });
    void loadConversationFileBlob(client, conversationId, content, download)
      .then((blob) => {
        if (cancelled) {
          return;
        }
        objectUrl = createObjectUrl ? URL.createObjectURL(blob) : undefined;
        setState({ status: "ready", blob, url: objectUrl });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ status: "failed", error });
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [client, content.kind, contentId, conversationId, createObjectUrl, download, enabled]);

  return state;
}

export function saveBlobAsFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
