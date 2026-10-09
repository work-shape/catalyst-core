import { type PlatformFileStore } from "@vivd-catalyst/core";
import { touchConversation } from "../postgres-conversation-operations";
import { createPostgresPlatformFileStore } from "../postgres-file-store";
import type { PostgresConnection } from "../postgres-database";
/** `jobsEnqueued` is called after the store enqueued a job, as the jobs store reports its own. */
export function createPostgresFilesStore(
  db: PostgresConnection,
  jobsEnqueued: () => void
): PlatformFileStore {
  return createPostgresPlatformFileStore(db, {
    jobsEnqueued,
    touchConversation: (clientInstanceId, conversationId, updatedAt) =>
      touchConversation(db, clientInstanceId, conversationId, updatedAt)
  });
}
