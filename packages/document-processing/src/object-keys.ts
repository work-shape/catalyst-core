import { createHash } from "node:crypto";
import {
  type ClientInstanceId,
  type ConversationId,
  type ManagedFileId,
  createPlatformId
} from "@vivd-catalyst/core";

export function createChecksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createArtifactObjectKey(input: {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  kind: string;
  extension: string;
}): string {
  return createObjectKey({
    clientInstanceId: input.clientInstanceId,
    conversationId: input.conversationId,
    segment: input.kind.replaceAll(".", "-"),
    extension: input.extension
  });
}

export function createPageImageObjectKey(input: {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  fileId: ManagedFileId;
  checksum: string;
  pageNumber: number;
  dpi: number;
}): string {
  const page = input.pageNumber.toString().padStart(6, "0");
  return [
    "documents",
    input.clientInstanceId,
    "conversations",
    input.conversationId,
    "document-page-image",
    input.fileId,
    input.checksum,
    `page-${page}-dpi-${input.dpi}.png`
  ].join("/");
}

export function createObjectKey(input: {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  segment: string;
  extension: string;
}): string {
  const id = createPlatformId("obj");
  return [
    "documents",
    input.clientInstanceId,
    "conversations",
    input.conversationId,
    input.segment,
    `${id}.${input.extension}`
  ].join("/");
}
