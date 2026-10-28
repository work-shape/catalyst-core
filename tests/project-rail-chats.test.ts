import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asConversationId,
  asUserId,
  type CollaborationWorkspaceId
} from "@work-shape/catalyst-core";
import {
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";

// PRJ-5: the rail unfolds the active project to its five newest chats, read with the chat
// list's own call, so the project's audience decides: a member reads a shared project's chats,
// nobody but its creator a private project's, and no instance role or grant adds a reader.
// Kai owns Team, Lena is a member, Mia holds Builder there and is no member.

const RAIL_LIMIT = 5;
const projectSchema = z.looseObject({ id: z.string(), collaborationWorkspaceId: z.string() });
const listSchema = z.object({ items: z.array(z.looseObject({ id: z.string() })) });

describe("the chats the rail shows under a project", () => {
  let t: AccessInstance;
  let team: CollaborationWorkspaceId;
  let shared: z.infer<typeof projectSchema>;
  let kaisPrivate: z.infer<typeof projectSchema>;
  const sharedChats: string[] = [];
  let privateChat: string;
  let miaId: string;

  const createProject = async (title: string, audience?: "private") =>
    projectSchema.parse(
      (
        await t.expectOk(t.kai.id, "projects.create", {
          payload: { collaborationWorkspaceId: team, title, ...(audience ? { audience } : {}) }
        })
      ).json()
    );
  const startIn = async (userId: string, project: z.infer<typeof projectSchema>) => {
    const created = await t.expectOk(userId, "conversations.create", {
      payload: { title: "Chat", collaborationWorkspaceId: team, projectId: project.id }
    });
    const id = z.object({ id: z.string() }).parse(created.json()).id;
    await t.stores.conversations.appendMessage({
      clientInstanceId,
      conversationId: asConversationId(id),
      role: "user",
      text: "Hello"
    });
    return id;
  };
  const railRead = (userId: string, project: z.infer<typeof projectSchema>) =>
    t.call(userId, "conversations.list", {
      query: { collaborationWorkspaceId: team, projectId: project.id, limit: RAIL_LIMIT }
    });

  beforeAll(async () => {
    t = await setupAccessInstance({ modules: { projects: { enabled: true } } });
    team = (
      await t.stores.workspaces.createWorkspace({
        clientInstanceId,
        kind: "shared",
        name: "Team",
        creatorUserId: t.kai.id
      })
    ).id;
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: team,
      userId: asUserId(t.lena.id),
      role: "member"
    });
    const mia = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Mia",
      roles: ["user"],
      permissions: []
    });
    miaId = mia.id;
    await t.grant(mia.id, "builder", { workspaceId: team });
    shared = await createProject("Projekt Nord");
    kaisPrivate = await createProject("Notizen Kai", "private");
    for (let index = 0; index < 6; index += 1) {
      sharedChats.push(await startIn(index % 2 === 0 ? t.kai.id : t.lena.id, shared));
    }
    privateChat = await startIn(t.kai.id, kaisPrivate);
  });
  afterAll(async () => {
    await t?.instance.close();
  });

  it("gives a member the shared project's five newest chats, whoever wrote them", async () => {
    for (const userId of [t.kai.id, t.lena.id]) {
      const response = await railRead(userId, shared);
      expect(response.statusCode).toBe(200);
      const page = listSchema.parse(response.json());
      expect(page.items.map(({ id }) => id)).toEqual(sharedChats.slice(1).reverse());
    }
  });

  it("gives a private project's chats to its creator alone", async () => {
    const own = listSchema.parse((await railRead(t.kai.id, kaisPrivate)).json());
    expect(own.items.map(({ id }) => id)).toEqual([privateChat]);
    expect((await railRead(t.lena.id, kaisPrivate)).statusCode).toBe(404);
  });

  it("gives no chat to a Builder or an administrator who is no member", async () => {
    expect((await railRead(miaId, shared)).statusCode).toBe(404);
    expect((await railRead(t.admin.id, shared)).statusCode).toBe(404);
  });
});
