import { describe, expect, it } from "vitest";
import { z } from "zod";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { agentListableToolNames } from "@work-shape/catalyst-client-assembly";
import {
  StoreBackedAuditRecorder,
  asApiCredentialId,
  asClientInstanceId,
  asCollaborationWorkspaceId,
  asConversationId,
  asServicePrincipalId,
  createPlatformId
} from "@work-shape/catalyst-core";
import { createTestInstanceWith, type TestInstance } from "./support/test-instance";
import { testOperations, type TestCallInput, type TestOperationName } from "./support/operations";
import type { TestStore } from "./support/test-store";
import { withTestSql } from "./support/test-sql";
import { createTestConfig } from "./support/fixtures";

// CHAT-SHARE-1: the creator of a private chat in a Shared Workspace names members of it, who
// then read and write in it while members. Nobody else gains anything, and only the creator in
// their own session changes who reads it.

const clientInstanceId = asClientInstanceId("demo-local");

/** Who calls: a person in their own session, or through a key, an embedding host or a service. */
const viaSchema = z.enum(["session", "key", "embed", "service"]);
type Via = z.infer<typeof viaSchema>;

const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional()
  })
});

const MISSING = { code: "NOT_FOUND", message: "Conversation is not available" };

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

function as(actor: string, via: Via = "session") {
  return { headers: { "x-dev-user-id": actor, "x-share-via": via } };
}

/**
 * A team with an owner, the creator of a private chat, a member to be named and a member who
 * is not: the chat holds a message and a finished run of its creator.
 */
async function createFixture() {
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

async function addMember(app: TestInstance<TestStore>, workspaceId: string, actor: string) {
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

async function createChat(
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

async function createRun(
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

function operationName(name: string): TestOperationName {
  if (!isOperationName(name)) throw new Error(`no operation ${name}`);
  return name;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

async function share(
  app: TestInstance<TestStore>,
  conversationId: string,
  userId: string,
  actor = "creator",
  via: Via = "session"
) {
  return app.call(
    "conversations.add_person",
    { params: { conversationId }, payload: { userId } },
    as(actor, via)
  );
}

function reasonOf(response: { json<T>(): T }) {
  return errorSchema.parse(response.json()).error.details?.reason;
}

async function auditRows(type: string) {
  return withTestSql(
    (sql) => sql`
      select subject, status, metadata from audit_events
      where client_instance_id = ${clientInstanceId} and type = ${type}
      order by created_at, id`
  );
}

/** Every reading route of a conversation, with what it needs beside the conversation id. */
function readingRoutes(runId: string): Record<string, TestCallInput> {
  return {
    "conversations.share_candidates": {},
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

describe("CHAT-SHARE-1: named people on a private chat", () => {
  it("lets a named member read on every reading route, and answers every other member as if the chat were missing", async () => {
    const { app, ids, conversationId, runId } = await createFixture();
    const routes = readingRoutes(runId);
    // Every reading route under a conversation is walked: a new one fails here until it is.
    const reading = Object.entries(apiOperations)
      .filter(([, operation]) => {
        const { path, effect } = operation as { path: string; effect: string };
        return path.includes(":conversationId") && effect === "reading";
      })
      .map(([name]) => name)
      .sort();
    expect(Object.keys(routes).sort()).toEqual(reading);

    const shared = await share(app, conversationId, ids.named);
    expect(shared.statusCode).toBe(200);
    const send = (name: string, actor: string, id = conversationId) => {
      const input = required(routes[name]);
      return app.call(
        operationName(name),
        { ...input, params: { ...input.params, conversationId: id } },
        as(actor)
      );
    };
    const answerOf = async (response: Awaited<ReturnType<typeof send>>) => ({
      status: response.statusCode,
      error: errorSchema.safeParse(response.json()).data?.error
    });
    for (const name of reading) {
      // The answer for a chat that is not there, which an unnamed member must not tell apart.
      const missing = await answerOf(await send(name, "named", "conv_missing"));
      expect(missing.status, name).toBe(404);
      for (const actor of ["colleague", "owner", "outsider"]) {
        expect(await answerOf(await send(name, actor)), `${actor} ${name}`).toEqual(missing);
      }
      const allowed = await send(name, "named");
      const body = allowed.statusCode >= 400 ? errorSchema.safeParse(allowed.json()) : undefined;
      // Allowed: whatever it answers, it is not the answer for a chat that is not there.
      expect(
        { name, missing: body?.success === true && body.data.error.message === MISSING.message },
        name
      ).toEqual({ name, missing: false });
    }

    // The named person reads it in the list and its read carries its people; the unnamed one
    // does not see it.
    const listed = async (actor: string) =>
      (
        await app.call(
          "conversations.list",
          { query: { collaborationWorkspaceId: (await workspaceOf(app, conversationId)) ?? "" } },
          as(actor)
        )
      )
        .json<{ items: { id: string }[] }>()
        .items.map((item) => item.id);
    await expect(listed("named")).resolves.toContain(conversationId);
    await expect(listed("colleague")).resolves.not.toContain(conversationId);
    const thread = await app.call(
      "conversations.thread.get",
      { params: { conversationId } },
      as("named")
    );
    expect(thread.json<{ conversation: { people: unknown[] } }>().conversation.people).toEqual([
      { userId: ids.named, displayLabel: "named", addedAt: expect.any(String) }
    ]);
    await app.close();
  });

  it("serializes the share with the personal-data mark: whichever comes first wins", async () => {
    const { app, ids, workspaceId, conversationId } = await createFixture();
    const conversations = app.stores.conversations;
    // Mark first: the share is refused.
    await conversations.markPersonalData({
      clientInstanceId,
      conversationId: asConversationId(conversationId),
      userId: ids.creator,
      at: new Date().toISOString()
    });
    const refused = await share(app, conversationId, ids.named);
    expect(refused.statusCode).toBe(422);
    expect(reasonOf(refused)).toBe("personal_conversation_private");
    // Share first: the personal call is refused.
    const second = await createChat(app, workspaceId, "Second");
    expect((await share(app, second, ids.named)).statusCode).toBe(200);
    await expect(
      conversations.markPersonalData({
        clientInstanceId,
        conversationId: asConversationId(second),
        userId: ids.creator,
        at: new Date().toISOString()
      })
    ).rejects.toMatchObject({ details: { reason: "personal_connection_context" } });
    // At once, under the store's row lock: exactly one wins, and never both.
    for (let round = 0; round < 5; round += 1) {
      const chat = asConversationId(await createChat(app, workspaceId, `Race ${round}`));
      const [marked, added] = await Promise.allSettled([
        conversations.markPersonalData({
          clientInstanceId,
          conversationId: chat,
          userId: ids.creator,
          at: new Date().toISOString()
        }),
        conversations.addConversationPerson({
          clientInstanceId,
          conversationId: chat,
          userId: ids.named,
          addedByUserId: ids.creator,
          addedAt: new Date().toISOString(),
          checked: { dataStoreAssetIds: [] }
        })
      ]);
      expect([marked.status, added.status].sort()).toEqual(["fulfilled", "rejected"]);
      const after = required(await conversations.getConversation(clientInstanceId, chat));
      expect(after.personalDataAt !== undefined).toBe(marked.status === "fulfilled");
      expect(after.people.length).toBe(added.status === "fulfilled" ? 1 : 0);
    }
    await app.close();
  });

  it("is the person's own step in their own session: a key, an embedding host and a service are refused, and no agent tool shares", async () => {
    const { app, ids, conversationId } = await createFixture();
    for (const via of ["key", "embed"] as const) {
      const refused = await share(app, conversationId, ids.named, "creator", via);
      expect(refused.statusCode, via).toBe(403);
      expect(reasonOf(refused), via).toBe("share_first_party_only");
      const candidates = await app.call(
        "conversations.share_candidates",
        { params: { conversationId } },
        as("creator", via)
      );
      expect(reasonOf(candidates), via).toBe("share_first_party_only");
    }
    const service = await share(app, conversationId, ids.named, "creator", "service");
    expect(service.statusCode).toBe(403);
    expect(
      (
        await app.stores.conversations.getConversation(
          clientInstanceId,
          asConversationId(conversationId)
        )
      )?.people
    ).toEqual([]);
    // Not an Operation Run an agent's call could make, and no tool of the platform's.
    for (const name of [
      "conversations.add_person",
      "conversations.remove_person",
      "conversations.share_candidates"
    ] as const) {
      expect(apiOperations[name]).not.toHaveProperty("headers");
    }
    expect(agentListableToolNames([]).filter((tool) => /person|people|share/u.test(tool))).toEqual(
      []
    );
    // After a share, removing and leaving are first-party too.
    expect((await share(app, conversationId, ids.named)).statusCode).toBe(200);
    for (const [actor, userId] of [
      ["creator", ids.named],
      ["named", ids.named]
    ] as const) {
      const refused = await app.call(
        "conversations.remove_person",
        { params: { conversationId, userId } },
        as(actor, "key")
      );
      expect(reasonOf(refused), actor).toBe("share_first_party_only");
    }
    await app.close();
  });

  it("refuses by the share guard, and only the creator names, moves or deletes", async () => {
    const { app, ids, workspaceId, conversationId } = await createFixture();
    const reasons: Record<string, unknown> = {};
    const tryShare = async (label: string, id: string, userId = ids.named, actor = "creator") => {
      const response = await share(app, id, userId, actor);
      reasons[label] = response.statusCode === 200 ? "shared" : reasonOf(response);
    };
    await tryShare("self", conversationId, ids.creator);
    await tryShare("outsider", conversationId, ids.outsider);
    await tryShare("unknown user", conversationId, "usr_missing");
    await tryShare("by a member who is not the creator", conversationId, ids.named, "colleague");

    // A chat that reads a Data Store a person added.
    const withStore = await createChat(app, workspaceId, "Reads a store");
    const storeAssetId = "asset_store_share";
    await withTestSql(
      (sql) => sql`
        insert into config_assets (id, client_instance_id, kind, name, scope_kind, scope_id, status, active_revision_id, created_at, updated_at)
        values (${storeAssetId}, ${clientInstanceId}, 'data_store', 'ledger', 'workspace', ${workspaceId}, 'active', 'rev_store_share', now(), now())`
    );
    await withTestSql(
      (sql) => sql`
        insert into conversation_data_stores (conversation_id, store_asset_id, client_instance_id, added_by_user_id, added_at)
        values (${withStore}, ${storeAssetId}, ${clientInstanceId}, ${ids.creator}, now())`
    );
    await tryShare("data store", withStore);
    // A chat about an asset the person may not write.
    const about = await createChat(app, workspaceId, "About an asset");
    await app.stores.conversations.setConversationSubject({
      clientInstanceId,
      conversationId: asConversationId(about),
      subject: { kind: "agent", name: "assistant" }
    });
    await tryShare("subject", about);
    // A chat in a project.
    const inProject = await createChat(app, workspaceId, "In a project");
    const project = await app.call(
      "projects.create",
      { payload: { collaborationWorkspaceId: workspaceId, title: "Plan" } },
      as("creator")
    );
    expect(project.statusCode, project.body).toBe(200);
    const projectId = project.json<{ id: string }>().id;
    const placed = await app.call(
      "conversations.set_project",
      { params: { conversationId: inProject }, payload: { projectId } },
      as("creator")
    );
    expect(placed.statusCode, placed.body).toBe(200);
    await tryShare("project", inProject);
    // A chat of a Personal Workspace.
    const ensured = await app.call("workspaces.ensure_personal", {}, as("creator"));
    expect(ensured.statusCode, ensured.body).toBe(200);
    const personal = ensured.json<{ id: string }>();
    const home = await createChat(app, personal.id, "At home");
    await tryShare("personal workspace", home);
    // A chat others read already.
    const team = await app.call(
      "conversations.create",
      { payload: { title: "Team chat", collaborationWorkspaceId: workspaceId } },
      as("creator")
    );
    await withTestSql(
      (sql) =>
        sql`update conversations set visibility = 'workspace' where id = ${team.json<{ id: string }>().id}`
    );
    await tryShare("team chat", team.json<{ id: string }>().id);

    expect(reasons).toEqual({
      self: "share_person_unavailable",
      outsider: "share_person_unavailable",
      "unknown user": "share_person_unavailable",
      "by a member who is not the creator": undefined,
      "data store": "data_store_conversation_private",
      subject: "subject_conversation_private",
      project: "conversation_in_project",
      "personal workspace": "personal_workspace_conversation",
      "team chat": "conversation_not_shareable"
    });

    // At most 20 people.
    const crowded = await createChat(app, workspaceId, "Crowded");
    for (let index = 0; index < 20; index += 1) {
      const user = await app.stores.users.createUser({
        clientInstanceId,
        displayLabel: `Member ${index}`,
        email: `member-${index}@example.test`
      });
      await app.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: asCollaborationWorkspaceId(workspaceId),
        userId: user.id,
        role: "member"
      });
      await app.stores.conversations.addConversationPerson({
        clientInstanceId,
        conversationId: asConversationId(crowded),
        userId: user.id,
        addedByUserId: ids.creator,
        addedAt: new Date().toISOString(),
        checked: { dataStoreAssetIds: [] }
      });
    }
    const limit = await share(app, crowded, ids.named);
    expect(reasonOf(limit)).toBe("share_people_limit");

    // Shared: the named person writes, names nobody, moves nothing and deletes nothing.
    expect((await share(app, conversationId, ids.named)).statusCode).toBe(200);
    const renamed = await app.call(
      "conversations.rename",
      { params: { conversationId }, payload: { title: "Renamed by the named" } },
      as("named")
    );
    expect(renamed.statusCode).toBe(200);
    const chained = await share(app, conversationId, ids.colleague, "named");
    expect(reasonOf(chained)).toBe("share_creator_only");
    const removeOther = await app.call(
      "conversations.remove_person",
      { params: { conversationId, userId: ids.creator } },
      as("named")
    );
    expect(reasonOf(removeOther)).toBe("share_creator_only");
    const moved = await app.call(
      "conversations.move",
      { params: { conversationId }, payload: { collaborationWorkspaceId: personal.id } },
      as("named")
    );
    expect(reasonOf(moved)).toBe("share_creator_only");
    const deleted = await app.call(
      "conversations.delete",
      { params: { conversationId } },
      as("named")
    );
    expect(reasonOf(deleted)).toBe("share_creator_only");
    const intoProject = await app.call(
      "conversations.set_project",
      { params: { conversationId }, payload: { projectId } },
      as("creator")
    );
    expect(reasonOf(intoProject)).toBe("conversation_has_people");
    // Adding a Data Store to a shared chat is refused at the store's lock, as in a team chat.
    await expect(
      app.stores.conversations.addConversationDataStore({
        clientInstanceId,
        conversationId: asConversationId(conversationId),
        assetId: storeAssetId,
        addedByUserId: ids.creator,
        addedAt: new Date().toISOString()
      })
    ).resolves.toBe(false);

    // Denials are audited with their reason, ids only.
    const denied = await auditRows("conversation.person_added");
    for (const row of denied) {
      const metadata = z
        .object({
          workspaceId: z.string(),
          personId: z.string(),
          reason: z.string().optional(),
          operationRunId: z.string().optional()
        })
        .strict()
        .parse(row.metadata);
      expect(JSON.stringify(row)).not.toMatch(/Quarter figures|example\.test|named"/u);
      expect(row.status === "denied").toBe(metadata.reason !== undefined);
    }
    expect(denied.map((row) => row.status)).toContain("denied");
    await app.close();
  });

  it("ends by removal, leave, membership end and move, and drops the person's queued turns", async () => {
    const { app, ids, workspaceId, conversationId } = await createFixture();
    const people = async (id: string) =>
      (
        await app.stores.conversations.getConversation(clientInstanceId, asConversationId(id))
      )?.people.map((person) => person.userId);

    // Removal waits for the person's own running turn, then drops their queued follow-up.
    expect((await share(app, conversationId, ids.named)).statusCode).toBe(200);
    const running = await createRun(app, conversationId, ids.named, "running");
    const waiting = await app.call(
      "conversations.remove_person",
      { params: { conversationId, userId: ids.named } },
      as("creator")
    );
    expect(waiting.statusCode).toBe(409);
    expect(reasonOf(waiting)).toBe("person_run_active");
    const endedAt = new Date().toISOString();
    await app.stores.agentRuns.updateAgentRunStatus({
      clientInstanceId,
      runId: running,
      status: "completed",
      updatedAt: endedAt,
      completedAt: endedAt,
      lastSequence: 0
    });
    await withTestSql(
      (sql) => sql`
        insert into conversation_follow_ups (id, client_instance_id, conversation_id, author_user_id, text, mode, status, position, agent_name, created_at, updated_at)
        values ('fu_share', ${clientInstanceId}, ${conversationId}, ${ids.named}, 'later', 'queue', 'pending', 1, 'default', now(), now())`
    );
    const removed = await app.call(
      "conversations.remove_person",
      { params: { conversationId, userId: ids.named } },
      as("creator")
    );
    expect(removed.json()).toEqual({ conversationId, userId: ids.named, removed: true });
    await expect(people(conversationId)).resolves.toEqual([]);
    const [followUp] = await withTestSql(
      (sql) => sql`select status from conversation_follow_ups where id = 'fu_share'`
    );
    expect(followUp?.status).not.toBe("pending");
    const after = await app.call(
      "conversations.thread.get",
      { params: { conversationId } },
      as("named")
    );
    expect(after.statusCode).toBe(404);

    // Leave.
    expect((await share(app, conversationId, ids.named)).statusCode).toBe(200);
    const left = await app.call(
      "conversations.remove_person",
      { params: { conversationId, userId: ids.named } },
      as("named")
    );
    expect(left.json()).toMatchObject({ removed: true });
    await expect(people(conversationId)).resolves.toEqual([]);

    // The membership ends: the rows of that workspace go in its transaction.
    const other = await createChat(app, workspaceId, "Other");
    expect((await share(app, conversationId, ids.named)).statusCode).toBe(200);
    expect((await share(app, other, ids.named)).statusCode).toBe(200);
    const removedMember = await app.call(
      "workspaces.members.remove",
      { params: { collaborationWorkspaceId: workspaceId, userId: ids.named } },
      as("owner")
    );
    expect(removedMember.statusCode).toBe(200);
    await expect(people(conversationId)).resolves.toEqual([]);
    await expect(people(other)).resolves.toEqual([]);
    // Back as a member, they read nothing until named again.
    await addMember(app, workspaceId, "named");
    expect(
      (await app.call("conversations.thread.get", { params: { conversationId } }, as("named")))
        .statusCode
    ).toBe(404);

    // The move to another workspace takes the rows.
    expect((await share(app, conversationId, ids.named)).statusCode).toBe(200);
    const elsewhere = await app.call(
      "workspaces.create",
      { payload: { name: "Elsewhere" } },
      as("owner")
    );
    const elsewhereId = elsewhere.json<{ id: string }>().id;
    await addMember(app, elsewhereId, "creator");
    const moved = await app.call(
      "conversations.move",
      {
        params: { conversationId },
        payload: { collaborationWorkspaceId: elsewhereId, visibility: "private" }
      },
      as("creator")
    );
    expect(moved.statusCode).toBe(200);
    expect(moved.json<{ people: unknown[] }>().people).toEqual([]);
    await expect(people(conversationId)).resolves.toEqual([]);

    const events = await auditRows("conversation.person_removed");
    expect(
      events.map((row) => {
        const { operationRunId: _run, ...metadata } = z
          .record(z.string(), z.unknown())
          .parse(row.metadata);
        return { subject: row.subject, metadata };
      })
    ).toEqual([
      { subject: conversationId, metadata: { personId: ids.named, reason: "removed" } },
      { subject: conversationId, metadata: { personId: ids.named, reason: "left" } },
      ...[conversationId, other].sort().map((subject) => ({
        subject,
        metadata: { personId: ids.named, reason: "membership_ended" }
      })),
      { subject: conversationId, metadata: { personId: ids.named, reason: "moved" } }
    ]);
    await app.close();
  });

  it("offers the workspace's members, the ones named before first, and files the notice with a conversation link", async () => {
    const { app, ids, workspaceId, conversationId } = await createFixture();
    const before = await createChat(app, workspaceId, "Earlier");
    expect((await share(app, before, ids.colleague)).statusCode).toBe(200);

    const candidates = await app.call(
      "conversations.share_candidates",
      { params: { conversationId } },
      as("creator")
    );
    expect(candidates.statusCode).toBe(200);
    const offered = candidates.json<{ candidates: { userId: string; hasAccess: boolean }[] }>();
    expect(offered.candidates[0]).toMatchObject({ userId: ids.colleague, hasAccess: false });
    expect(offered.candidates.map((candidate) => candidate.userId)).not.toContain(ids.creator);
    expect(offered.candidates.map((candidate) => candidate.userId)).not.toContain(ids.outsider);

    const searched = await app.call(
      "conversations.share_candidates",
      { params: { conversationId }, query: { query: "nam" } },
      as("creator")
    );
    expect(
      searched.json<{ candidates: { userId: string }[] }>().candidates.map((item) => item.userId)
    ).toEqual([ids.named]);

    expect((await share(app, conversationId, ids.named)).statusCode).toBe(200);
    // Naming again changes nothing and files no second notice.
    expect((await share(app, conversationId, ids.named)).statusCode).toBe(200);
    const notices = await withTestSql(
      (sql) => sql`
        select kind, summary, payload, addressee_user_id from approval_requests
        where client_instance_id = ${clientInstanceId} and addressee_user_id = ${ids.named}`
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: "notice",
      summary: "creator shared “Quarter figures” with you",
      payload: {
        link: { kind: "conversation", workspaceId, conversationId }
      }
    });
    const marked = await app.call(
      "conversations.share_candidates",
      { params: { conversationId } },
      as("creator")
    );
    expect(
      marked
        .json<{ candidates: { userId: string; hasAccess: boolean }[] }>()
        .candidates.find((candidate) => candidate.userId === ids.named)
    ).toMatchObject({ hasAccess: true });
    await app.close();
  });
});

async function workspaceOf(
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
