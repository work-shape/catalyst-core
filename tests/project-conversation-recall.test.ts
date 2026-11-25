import { createPlatformAssetCalls } from "@work-shape/catalyst-server";
import {
  PROJECT_RECALL_NOTICE,
  asConversationId,
  asToolCallId,
  asUserId,
  type AgentRunId,
  type AuthenticatedUser,
  type CollaborationWorkspaceId,
  type UserRecord
} from "@work-shape/catalyst-core";
import { ToolRegistry, createProjectConversationTools } from "@work-shape/catalyst-tool-execution";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { testServerOptions } from "./support/test-instance";
import { withTestSql } from "./support/test-sql";
import { createTestToolRunner, recordedAuditEvent } from "./support/tool-runner";

// RECALL-2: from a chat in a project, the agent searches and reads the project's other chats,
// those the person reads, and nothing else: no chat of another project, of no project or of
// another workspace, not the chat it calls from, no deleted chat, draft, run thread or chat
// with the personal-data mark; a run thread is in no project by its constraint. Before, no tool reached another conversation at all.
// Kai owns Team and Other; Lena is a member of Team.

const ON = { projects: { enabled: true } };
const projectSchema = z.looseObject({ id: z.string() });
const idSchema = z.object({ id: z.string() });
const resultSchema = z.object({
  status: z.string(),
  output: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string().optional(), message: z.string() }).optional()
});
const searchSchema = z.object({
  notice: z.string(),
  source: z.string(),
  conversations: z.array(
    z.object({
      conversationId: z.string(),
      title: z.string(),
      titleMatch: z.boolean(),
      hits: z.array(z.object({ messageId: z.string(), snippet: z.string() }))
    })
  ),
  more: z.boolean()
});
const readSchema = z.object({
  notice: z.string(),
  source: z.string(),
  conversationId: z.string(),
  title: z.string(),
  messages: z.array(z.object({ text: z.string() }))
});

describe("the agent's search and read of its project's other chats", () => {
  let t: AccessInstance;
  let team: CollaborationWorkspaceId;
  let other: CollaborationWorkspaceId;
  let nord: string;
  let calling: string;
  let lindenweg: string;
  let gone: string;
  let draft: string;
  let marked: string;
  let elsewhere: string[];
  let kaisPrivate: string;
  const audit: unknown[] = [];
  const logged: unknown[] = [];
  let run: ReturnType<typeof createTestToolRunner>;
  const runs = new Map<string, AgentRunId>();

  const createProject = async (
    workspace: CollaborationWorkspaceId,
    title: string,
    audience?: "private"
  ) =>
    projectSchema.parse(
      (
        await t.expectOk(t.kai.id, "projects.create", {
          payload: {
            collaborationWorkspaceId: workspace,
            title,
            ...(audience ? { audience } : {})
          }
        })
      ).json()
    ).id;
  const chat = async (
    user: UserRecord,
    workspace: CollaborationWorkspaceId,
    title: string,
    projectId: string | undefined,
    texts: string[]
  ) => {
    const created = await t.expectOk(user.id, "conversations.create", {
      payload: {
        title,
        collaborationWorkspaceId: workspace,
        ...(projectId ? { projectId } : {})
      }
    });
    const id = idSchema.parse(created.json()).id;
    for (const [index, text] of texts.entries()) {
      await t.stores.conversations.appendMessage({
        clientInstanceId,
        conversationId: asConversationId(id),
        role: index % 2 === 0 ? "user" : "assistant",
        text
      });
    }
    return id;
  };
  const person = (user: UserRecord): AuthenticatedUser => ({
    id: user.id,
    externalUserId: user.id,
    displayLabel: user.displayLabel,
    roles: user.roles,
    permissionRefs: [],
    clientInstanceId,
    authSource: "test"
  });
  const tool = async (user: UserRecord, from: string, toolName: string, input: unknown) => {
    const conversation = await t.stores.conversations.getConversation(
      clientInstanceId,
      asConversationId(from)
    );
    if (!conversation) throw new Error("The chat is not there");
    // One run per chat: a chat holds one active run at a time.
    const agentRunId = runs.get(from) ?? (await t.stores.createAgentRunForTesting(conversation)).id;
    runs.set(from, agentRunId);
    return resultSchema.parse(
      await run(
        {
          toolName,
          toolCallId: asToolCallId(`toolcall_${globalThis.crypto.randomUUID()}`),
          agentRunId,
          conversationId: asConversationId(from),
          agentName: "assistant",
          input
        },
        { clientInstanceId, correlationId: "corr_recall_2", user: person(user) }
      )
    );
  };

  beforeAll(async () => {
    t = await setupAccessInstance({ modules: ON });
    const workspace = async (name: string) =>
      (
        await t.stores.workspaces.createWorkspace({
          clientInstanceId,
          kind: "shared",
          name,
          creatorUserId: t.kai.id
        })
      ).id;
    team = await workspace("Team");
    other = await workspace("Other");
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: team,
      userId: asUserId(t.lena.id),
      role: "member"
    });
    nord = await createProject(team, "Projekt Nord");
    const sued = await createProject(team, "Projekt Süd");
    kaisPrivate = await createProject(team, "Notizen Kai", "private");
    const anderswo = await createProject(other, "Projekt Anderswo");

    calling = await chat(t.kai, team, "Heute", nord, ["Wo steht die Checkliste?"]);
    lindenweg = await chat(t.lena, team, "Lindenweg", nord, [
      "Bitte die Checklisten für das Flurstück 12 prüfen.",
      "Die Checkliste für den Kaufvertrag fehlt noch."
    ]);
    gone = await chat(t.kai, team, "Alt", nord, ["Checkliste von gestern"]);
    await t.expectOk(t.kai.id, "conversations.delete", { params: { conversationId: gone } });
    // A draft without a message, whose title would match.
    draft = await chat(t.kai, team, "Checkliste Entwurf", nord, []);
    marked = await chat(t.kai, team, "Post", nord, ["Checkliste aus dem Postfach"]);
    // The store marks only a chat its person alone reads; the mark is set as a run would have.
    // A run thread is in no project (`conversations_project_chat_check`), so none is here.
    await withTestSql(
      (sql) => sql`update conversations set personal_data_at = now() where id = ${marked}`
    );
    elsewhere = [
      await chat(t.kai, team, "Süd", sued, ["Checkliste in Süd"]),
      await chat(t.kai, team, "Lose", undefined, ["Checkliste ohne Projekt"]),
      await chat(t.kai, other, "Anderswo", anderswo, ["Checkliste anderswo"]),
      await chat(t.kai, team, "Privat", kaisPrivate, ["Checkliste privat"])
    ];

    const options = testServerOptions(t.instance);
    if (!options) throw new Error("The instance has no server options");
    const tools = createProjectConversationTools(createPlatformAssetCalls(options));
    run = createTestToolRunner({
      registry: new ToolRegistry({ tools }),
      getAgentToolNames: () => tools.map((definition) => definition.name),
      auditRecorder: {
        record: (input) => {
          audit.push(input);
          return Promise.resolve(recordedAuditEvent(clientInstanceId, input));
        }
      },
      logger: {
        debug: (...line: unknown[]) => logged.push(line),
        info: (...line: unknown[]) => logged.push(line),
        warn: (...line: unknown[]) => logged.push(line),
        error: (...line: unknown[]) => logged.push(line),
        child() {
          return this;
        }
      }
    });
  });
  afterAll(async () => {
    await t?.instance.close();
  });

  it("finds only the project's other chats the person reads, and opens with the notice", async () => {
    const found = await tool(t.kai, calling, "platform.conversations.search", {
      query: "checkliste"
    });
    expect(found.status, found.error?.message).toBe("success");
    const output = searchSchema.parse(found.output);
    expect(Object.keys(found.output ?? {})[0]).toBe("notice");
    expect(output.notice).toBe(PROJECT_RECALL_NOTICE);
    expect(output.source).toBe(`project:${nord}`);
    expect(output.conversations.map((chat) => chat.conversationId)).toEqual([lindenweg]);
    expect(output.conversations[0]?.hits.map((hit) => hit.snippet)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("«Checklisten»"),
        expect.stringContaining("«Checkliste»")
      ])
    );

    // A title matches as the person wrote it; without words the newest chats by title.
    const byTitle = searchSchema.parse(
      (await tool(t.kai, calling, "platform.conversations.search", { query: "Lindenweg" })).output
    );
    expect(byTitle.conversations).toMatchObject([
      { conversationId: lindenweg, titleMatch: true, hits: [] }
    ]);
    const listed = searchSchema.parse(
      (await tool(t.lena, lindenweg, "platform.conversations.search", {})).output
    );
    expect(listed.conversations.map((chat) => chat.conversationId)).toEqual([calling]);
  });

  it("reads another chat of the project, and answers every other id as a missing chat", async () => {
    const read = await tool(t.kai, calling, "platform.conversations.read", {
      conversationId: lindenweg
    });
    expect(read.status, read.error?.message).toBe("success");
    const output = readSchema.parse(read.output);
    expect(output).toMatchObject({
      notice: PROJECT_RECALL_NOTICE,
      source: `project:${nord}`,
      title: "Lindenweg"
    });
    // From the chat's start; a run of the first test left its own input after these.
    expect(output.messages.slice(0, 2).map((message) => message.text)).toEqual([
      "Bitte die Checklisten für das Flurstück 12 prüfen.",
      "Die Checkliste für den Kaufvertrag fehlt noch."
    ]);
    for (const conversationId of [calling, gone, draft, marked, ...elsewhere]) {
      const refused = await tool(t.kai, calling, "platform.conversations.read", {
        conversationId
      });
      expect({ conversationId, status: refused.status, message: refused.error?.message }).toEqual({
        conversationId,
        status: "failed",
        message: "Conversation is not available"
      });
    }
  });

  it("gives a member outside a private project's audience nothing of it", async () => {
    const refused = await t.call(t.lena.id, "projects.conversations.search", {
      params: { projectId: kaisPrivate },
      query: { query: "checkliste" }
    });
    expect(refused.statusCode).toBe(404);
    expect(
      await t.stores.conversations.listRecallConversations({
        clientInstanceId,
        collaborationWorkspaceId: team,
        projectId: kaisPrivate,
        userId: t.lena.id
      })
    ).toEqual([]);
  });

  it("keeps no query, title or snippet in Operation Runs, audit rows or logs", async () => {
    const kept = JSON.stringify([await run.runs.list({ clientInstanceId }), audit, logged]);
    expect(kept).toContain("platform.conversations.search");
    for (const words of ["checkliste", "Checkliste", "Lindenweg", "Flurstück", "Kaufvertrag"]) {
      expect(kept).not.toContain(words);
    }
  });
});
