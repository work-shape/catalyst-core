import { createHash } from "node:crypto";
import { type ClientInstanceId, type ConversationId, createPlatformId } from "@vivd-catalyst/core";

export function createChecksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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
