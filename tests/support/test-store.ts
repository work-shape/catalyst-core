import postgres from "postgres";
import {
  AppError,
  asUserId,
  createPlatformId,
  type AgentRun,
  type Conversation,
  type CreateConversationInput
} from "@vivd-catalyst/core";
import type { PostgresStores } from "@vivd-catalyst/postgres-store";
import { fileTestDatabaseUrl } from "./test-database";

type TestConversationInput = Omit<
  CreateConversationInput,
  "collaborationWorkspaceId" | "visibility"
>;
export interface TestStore extends PostgresStores {
  createConversationForTesting(input: TestConversationInput): Promise<Conversation>;
  /**
   * A stored run behind a stored user message, for rows that refer to a run. A conversation
   * holds one active run, so call it once per conversation.
   */
  createAgentRunForTesting(conversation: Conversation): Promise<AgentRun>;
}

/** Arrange the synthetic identity through real constraints, then use the named stores. */
export function addTestStoreHelpers(stores: PostgresStores): TestStore {
  return {
    ...stores,
    async createConversationForTesting(input) {
      const sql = postgres(await fileTestDatabaseUrl(), { max: 1 });
      try {
        await sql`
          insert into product_users (id, client_instance_id, display_label, roles, permission_refs, permissions, status, created_at, updated_at)
          values (${input.createdByUserId}, ${input.clientInstanceId}, ${input.createdByExternalUserId}, '["user"]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'active', now(), now())
          on conflict (id) do nothing
        `;
        const [user] = await sql<
          { client_instance_id: string }[]
        >`select client_instance_id from product_users where id = ${input.createdByUserId}`;
        if (user?.client_instance_id !== input.clientInstanceId)
          throw new AppError("CONFLICT", "Test user belongs to another client instance");
      } finally {
        await sql.end();
      }
      const workspace = await stores.workspaces.ensurePersonalWorkspace({
        clientInstanceId: input.clientInstanceId,
        userId: asUserId(input.createdByUserId)
      });
      return stores.conversations.createConversation({
        ...input,
        collaborationWorkspaceId: workspace.id,
        visibility: "workspace"
      });
    },
    async createAgentRunForTesting(conversation) {
      const message = await stores.conversations.appendMessage({
        clientInstanceId: conversation.clientInstanceId,
        conversationId: conversation.id,
        role: "user",
        text: "Synthetic run input"
      });
      return stores.agentRuns.createAgentRun({
        id: createPlatformId<"AgentRunId">("run"),
        clientInstanceId: conversation.clientInstanceId,
        conversationId: conversation.id,
        ownerUserId: conversation.createdByUserId,
        inputMessageId: message.id,
        agentName: "test_agent",
        correlationId: "corr_test_run"
      });
    }
  };
}

type ClaimAttachmentsInput = Parameters<
  PostgresStores["files"]["claimReadyDraftAttachmentsForMessage"]
>[0];

/** Stores the user message a claim names, then claims the ready draft attachments for it. */
export async function claimAttachmentsForStoredMessage(
  stores: Pick<PostgresStores, "conversations" | "files">,
  input: ClaimAttachmentsInput
): ReturnType<PostgresStores["files"]["claimReadyDraftAttachmentsForMessage"]> {
  await stores.conversations.appendMessage({
    id: input.messageId,
    clientInstanceId: input.clientInstanceId,
    conversationId: input.conversationId,
    role: "user",
    text: "Synthetic message with attachments"
  });
  return stores.files.claimReadyDraftAttachmentsForMessage(input);
}
