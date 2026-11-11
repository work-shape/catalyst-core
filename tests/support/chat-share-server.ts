import { z } from "zod";
import {
  StoreBackedAuditRecorder,
  asApiCredentialId,
  asClientInstanceId,
  asConversationId,
  asServicePrincipalId,
  createPlatformId
} from "@work-shape/catalyst-core";
import { expect } from "vitest";
import { createTestInstanceWith, type TestInstance } from "./test-instance";
import { testOperations, type TestCallInput, type TestOperationName } from "./operations";
import type { TestStore } from "./test-store";
import { withTestSql } from "./test-sql";
import { createTestConfig } from "./fixtures";

// The instance and fixture the CHAT-SHARE server tests share: a team with an owner, the
// creator of a private chat, a member to be named, a member who is not, and a person in no
// team with them.

export const clientInstanceId = asClientInstanceId("demo-local");

/** Who calls: a person in their own session, or through a key, an embedding host or a service. */
const viaSchema = z.enum(["session", "key", "embed", "service"]);
export type Via = z.infer<typeof viaSchema>;

export const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional()
  })
});

export const MISSING = { code: "NOT_FOUND", message: "Conversation is not available" };

async function createShareInstance(): Promise<TestInstance<TestStore>> {
  const config = createTestConfig();
  // Projects for the guard; apps so their routes answer past the module switch.
  config.modules.projects = { enabled: true };
  config.modules.apps = { enabled: true };
  return createTestInstanceWith((stores) => ({
    config,
    auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: stores.audit }),
    authAdapter: {
      id: "share-test",
      credentialMode: "ambient",
      async authenticate(request) {
        const header = (name: string) => {
          const value = request.headers[name];
          return typeof value === "string" ? value : undefined;
        };
        const via = viaSchema.parse(header("x-share-via") ?? "session");
        if (via === "service") {
          return {
            kind: "service",
            id: asServicePrincipalId("sp_share_test"),
            credentialId: asApiCredentialId("cred_share_test"),
            displayLabel: "Service",
            permissionRefs: [],
            permissions: [],
            clientInstanceId,
            authSource: "test",
            scopes: ["*"]
          };
        }
        const actor = header("x-dev-user-id") ?? "creator";
        const user = await stores.users.resolveUserIdentity({
          clientInstanceId,
          authSource: "test",
          externalUserId: actor,
          displayLabel: actor,
          email: `${actor}@example.test`,
          roles: actor === "owner" ? ["user", "admin", "superadmin"] : ["user"],
          permissionRefs: ["demo-tools"],
          permissions: [],
          correlationId: "test"
        });
        return {
          ...user,
          scopes: ["*"],
          ...(via === "key"
            ? {
                delegatedActor: {
                  kind: "api_key" as const,
                  id: asApiCredentialId("key_share_test"),
                  displayLabel: "Key",
                  authSource: "test"
                }
              }
            : via === "embed"
              ? {
                  delegatedActor: {
                    kind: "service_principal" as const,
                    id: "sp_embedding_host",
                    authSource: "test"
                  }
                }
              : {})
        };
      }
    }
  }));
}

export function as(actor: string, via: Via = "session") {
  return { headers: { "x-dev-user-id": actor, "x-share-via": via } };
}

/**
 * A team with an owner, the creator of a private chat, a member to be named and a member who
 * is not: the chat holds a message and a finished run of its creator.
 */
export async function createFixture() {
  const app = await createShareInstance();
  const ids: Record<string, string> = {};
  for (const actor of ["owner", "creator", "named", "colleague", "outsider"]) {
    const me = await app.call("me.get", {}, as(actor));
    expect(me.statusCode).toBe(200);
    ids[actor] = me.json<{ id: string }>().id;
  }
  const created = await app.call(
    "workspaces.create",
    { payload: { name: "Team", defaultConversationVisibility: "private" } },
    as("owner")
  );
  expect(created.statusCode).toBe(200);
  const workspaceId = created.json<{ id: string }>().id;
  for (const actor of ["creator", "named", "colleague"]) await addMember(app, workspaceId, actor);
  const conversationId = await createChat(app, workspaceId, "Quarter figures");
  const runId = await createRun(app, conversationId, required(ids.creator), "completed");
  return {
    app,
    ids: ids as Record<"owner" | "creator" | "named" | "colleague" | "outsider", string>,
    workspaceId,
    conversationId,
    runId
  };
}

export async function addMember(app: TestInstance<TestStore>, workspaceId: string, actor: string) {
  const added = await app.call(
    "workspaces.members.add",
    {
      params: { collaborationWorkspaceId: workspaceId },
      payload: { email: `${actor}@example.test` }
    },
    as("owner")
  );
  expect(added.statusCode).toBe(200);
}

export async function createChat(
  app: TestInstance<TestStore>,
  workspaceId: string,
  title: string,
  actor = "creator"
): Promise<string> {
  const created = await app.call(
    "conversations.create",
    { payload: { title, collaborationWorkspaceId: workspaceId, visibility: "private" } },
    as(actor)
  );
  expect(created.statusCode).toBe(200);
  const id = created.json<{ id: string }>().id;
  await app.stores.conversations.appendMessage({
    clientInstanceId,
    conversationId: asConversationId(id),
    role: "user",
    text: "private content"
  });
  return id;
}

export async function createRun(
  app: TestInstance<TestStore>,
  conversationId: string,
  ownerUserId: string,
  status: "running" | "completed"
) {
  const message = await app.stores.conversations.appendMessage({
    clientInstanceId,
    conversationId: asConversationId(conversationId),
    role: "user",
    text: "a turn"
  });
  const run = await app.stores.agentRuns.createAgentRun({
    id: createPlatformId<"AgentRunId">("run"),
    clientInstanceId,
    conversationId: asConversationId(conversationId),
    ownerUserId,
    inputMessageId: message.id,
    agentName: "default",
    correlationId: "corr_share"
  });
  if (status === "completed") {
    const completedAt = new Date().toISOString();
    await app.stores.agentRuns.updateAgentRunStatus({
      clientInstanceId,
      runId: run.id,
      status: "completed",
      updatedAt: completedAt,
      completedAt,
      lastSequence: 0
    });
  }
  return run.id;
}

function isOperationName(name: string): name is TestOperationName {
  return Object.hasOwn(testOperations, name);
}

export function operationName(name: string): TestOperationName {
  if (!isOperationName(name)) throw new Error(`no operation ${name}`);
  return name;
}

export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

export async function share(
  app: TestInstance<TestStore>,
  conversationId: string,
  userId: string,
  actor = "creator",
  via: Via = "session"
): ReturnType<TestInstance<TestStore>["call"]> {
  return app.call(
    "conversations.add_person",
    { params: { conversationId }, payload: { userId } },
    as(actor, via)
  );
}

export function reasonOf(response: { json<T>(): T }) {
  return errorSchema.parse(response.json()).error.details?.reason;
}

export async function auditRows(type: string) {
  return withTestSql(
    (sql) => sql`
      select subject, status, metadata from audit_events
      where client_instance_id = ${clientInstanceId} and type = ${type}
      order by created_at, id`
  );
}

/** Every reading route of a conversation, with what it needs beside the conversation id. */
export function readingRoutes(runId: string): Record<string, TestCallInput> {
  return {
    "conversations.share_candidates": {},
    "conversations.reader_offer.get": {},
    "conversations.thread.get": {},
    "conversations.messages.list": {},
    "conversations.resources.list": {},
    "conversations.subagents.list": {},
    "conversations.structured_data.get": { params: { structuredDataResourceId: "sdr_missing" } },
    "conversations.runs.observe": { params: { runId } },
    "conversations.draft_attachments.list": {},
    "conversations.files.get_content": { params: { fileId: "file_missing" } },
    "conversations.artifacts.get_content": { params: { artifactId: "artifact_missing" } },
    "conversations.artifacts.get_preview": { params: { artifactId: "artifact_missing" } },
    "conversations.attachments.get_preview": { params: { attachmentId: "attachment_missing" } },
    "pages.list": {},
    "pages.get": { params: { pageId: "page_missing" } },
    "pages.files.list": { params: { pageId: "page_missing", fileSetId: "fs_missing" } },
    "pages.files.get": {
      params: { pageId: "page_missing", fileSetId: "fs_missing" },
      query: { path: "index.html" }
    },
    "pages.preview": { params: { pageId: "page_missing" }, payload: {} },
    "apps.get_from_page": { params: { pageId: "page_missing" }, query: { app: "missing" } },
    "apps.preview_captures.pending": {},
    "feedback.list_own": {},
    "conversations.project_instructions.get": {}
  };
}

export async function workspaceOf(
  app: TestInstance<TestStore>,
  conversationId: string
): Promise<string | undefined> {
  return (
    await app.stores.conversations.getConversation(
      clientInstanceId,
      asConversationId(conversationId)
    )
  )?.collaborationWorkspaceId;
}
