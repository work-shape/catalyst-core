import { createContext, useContext, type ReactNode } from "react";
import type { ApiClient } from "@vivd-catalyst/api-client";

interface AttachmentContentContextValue {
  client: ApiClient;
  selectedConversationId: string | undefined;
}

const AttachmentContentContext = createContext<AttachmentContentContextValue | undefined>(undefined);

export function AttachmentContentProvider({
  client,
  selectedConversationId,
  children
}: AttachmentContentContextValue & {
  children: ReactNode;
}) {
  return (
    <AttachmentContentContext.Provider value={{ client, selectedConversationId }}>
      {children}
    </AttachmentContentContext.Provider>
  );
}

export function useAttachmentContentContext(): AttachmentContentContextValue | undefined {
  return useContext(AttachmentContentContext);
}

export function managedFileIdFromUrl(url: string | undefined): string | undefined {
  if (!url?.startsWith("vivd-document://")) {
    return undefined;
  }
  const rawFileId = url.slice("vivd-document://".length);
  return rawFileId ? decodeURIComponent(rawFileId) : undefined;
}
