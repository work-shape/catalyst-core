import { type ClientInstanceId, type ConversationId } from "@work-shape/catalyst-core";
import { type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { schema } from "./schema";

export type PostgresConnection = PostgresJsDatabase<typeof schema>;

export interface PostgresPlatformFileStoreCallbacks {
  /** Tells the job workers of this process that the store enqueued a job. */
  jobsEnqueued(): void;
  touchConversation(
    clientInstanceId: ClientInstanceId,
    conversationId: ConversationId,
    updatedAt: Date
  ): Promise<void>;
}
