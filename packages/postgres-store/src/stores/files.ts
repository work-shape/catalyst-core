import { type PlatformFileStore } from "@vivd-catalyst/core";
import { touchConversation } from "../postgres-conversation-operations";
import { createPostgresPlatformFileStore } from "../postgres-file-store";
import type { PostgresConnection } from "../postgres-database";
export function createPostgresFilesStore(db: PostgresConnection): PlatformFileStore {
  return createPostgresPlatformFileStore(db, {
    touchConversation: (clientInstanceId, conversationId, updatedAt) =>
      touchConversation(db, clientInstanceId, conversationId, updatedAt)
  });
}
