import { createContext, useContext, type ReactNode } from "react";
import type { ApiClient } from "@work-shape/catalyst-api-client";

interface AttachmentContentContextValue {
  client: ApiClient;
  selectedConversationId: string | undefined;
}

const AttachmentContentContext = createContext<AttachmentContentContextValue | undefined>(
  undefined
);

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

/** The address a message part gives a managed file of the conversation. */
export function managedFileUrl(fileId: string): string {
  return `vivd-file://${encodeURIComponent(fileId)}`;
}

export function managedFileIdFromUrl(url: string | undefined): string | undefined {
  if (!url?.startsWith("vivd-file://")) {
    return undefined;
  }
  const rawFileId = url.slice("vivd-file://".length);
  return rawFileId ? decodeURIComponent(rawFileId) : undefined;
}
