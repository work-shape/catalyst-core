import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asConversationId,
  asUserId,
  type CollaborationWorkspaceId,
  type UserRecord
} from "@work-shape/catalyst-core";
import {
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";

// PRJ-5: `projects.list_mine` lists the projects of every workspace the person is a member of,
// under the audience of PRJ-1: a private project only for its creator, and no grant, bundle or
// instance role adds one. Leaving a workspace takes its projects off the list at once.
// Kai owns Team and Other; Lena is a member of Team only. Mia holds Builder in Team.

const itemSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  collaborationWorkspaceId: z.string(),
  conversationCount: z.number(),
  lastActivityAt: z.string()
});
const listSchema = z.object({ items: z.array(itemSchema) });
const projectSchema = z.looseObject({ id: z.string(), collaborationWorkspaceId: z.string() });

describe("projects across the person's workspaces", () => {
  let t: AccessInstance;
  let mia: UserRecord;
  let team: CollaborationWorkspaceId;
  let other: CollaborationWorkspaceId;

  const create = async (userId: string, workspaceId: string, title: string, audience?: "private") =>
    projectSchema.parse(
      (
        await t.expectOk(userId, "projects.create", {
          payload: {
            collaborationWorkspaceId: workspaceId,
            title,
            ...(audience ? { audience } : {})
          }
        })
      ).json()
    );
  const startIn = async (userId: string, project: z.infer<typeof projectSchema>, sent = true) => {
    const created = await t.expectOk(userId, "conversations.create", {
      payload: {
        title: "Chat",
        collaborationWorkspaceId: project.collaborationWorkspaceId,
        projectId: project.id
      }
    });
    const id = z.object({ id: z.string() }).parse(created.json()).id;
    if (sent) {
      await t.stores.conversations.appendMessage({
        clientInstanceId,
        conversationId: asConversationId(id),
        role: "user",
        text: "Hello"
      });
    }
  };
  const mine = async (userId: string) =>
    listSchema.parse((await t.expectOk(userId, "projects.list_mine", {})).json()).items;
  const titles = async (userId: string) => (await mine(userId)).map((item) => item.title).sort();

  beforeAll(async () => {
    t = await setupAccessInstance({ modules: { projects: { enabled: true } } });
    mia = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Mia",
      roles: ["user"],
      permissions: []
    });
    team = (
      await t.stores.workspaces.createWorkspace({
        clientInstanceId,
        kind: "shared",
        name: "Team",
        creatorUserId: t.kai.id
      })
    ).id;
    other = (
      await t.stores.workspaces.createWorkspace({
        clientInstanceId,
        kind: "shared",
        name: "Other",
        creatorUserId: t.kai.id
      })
    ).id;
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: team,
      userId: asUserId(t.lena.id),
      role: "member"
    });
    await t.grant(mia.id, "builder", { workspaceId: team });
    const nord = await create(t.kai.id, team, "Nord");
    await create(t.kai.id, team, "Notizen Kai", "private");
    await create(t.lena.id, team, "Notizen Lena", "private");
    const elsewhere = await create(t.kai.id, other, "Anderswo");
    await startIn(t.kai.id, nord);
    await startIn(t.lena.id, nord);
    // An unsent draft is no chat of the project yet.
    await startIn(t.kai.id, nord, false);
    await startIn(t.kai.id, elsewhere);
  });
  afterAll(async () => {
    await t?.instance.close();
  });

  it("lists every workspace's shared projects and the person's own private ones", async () => {
    expect(await titles(t.kai.id)).toEqual(["Anderswo", "Nord", "Notizen Kai"]);
    expect(await titles(t.lena.id)).toEqual(["Nord", "Notizen Lena"]);
    const kais = await mine(t.kai.id);
    expect(kais.find((item) => item.title === "Anderswo")?.collaborationWorkspaceId).toBe(other);
    expect(kais.find((item) => item.title === "Nord")?.conversationCount).toBe(2);
    expect(kais.find((item) => item.title === "Notizen Kai")?.conversationCount).toBe(0);
  });

  it("puts the project used last first", async () => {
    const before = (await mine(t.kai.id)).map((item) => item.title);
    const notes = (await mine(t.kai.id)).find((item) => item.title === "Notizen Kai");
    if (!notes) throw new Error("Kai's notes are listed");
    await startIn(t.kai.id, { id: notes.id, collaborationWorkspaceId: team });
    const after = await mine(t.kai.id);
    expect(after[0]?.title).toBe("Notizen Kai");
    expect(after.map((item) => item.title).sort()).toEqual([...before].sort());
    for (const [index, item] of after.entries()) {
      const next = after[index + 1];
      if (next) expect(item.lastActivityAt >= next.lastActivityAt).toBe(true);
    }
  });

  it("shows nothing outside the person's memberships, a grant, a bundle or a role notwithstanding", async () => {
    expect(await titles(mia.id)).toEqual([]);
    expect(await titles(t.admin.id)).toEqual([]);
    // The superadmin is Owner of every Shared Workspace on its own page, and no member here.
    expect(await titles(t.root.id)).toEqual([]);
    const row = await t.grant(t.lena.id, "builder", { workspaceId: other });
    try {
      expect(await titles(t.lena.id)).toEqual(["Nord", "Notizen Lena"]);
    } finally {
      await t.expectOk(t.admin.id, "permissions.revoke", { params: { grantId: row } });
    }
  });

  it("takes a workspace's projects off the list when the person leaves it", async () => {
    await t.stores.workspaces.removeMembership({
      clientInstanceId,
      collaborationWorkspaceId: team,
      userId: asUserId(t.lena.id)
    });
    try {
      expect(await titles(t.lena.id)).toEqual([]);
    } finally {
      await t.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: team,
        userId: asUserId(t.lena.id),
        role: "member"
      });
    }
    expect(await titles(t.lena.id)).toEqual(["Nord", "Notizen Lena"]);
  });

  it("counts the same chats on the list of one workspace", async () => {
    const one = listSchema.parse(
      (
        await t.expectOk(t.lena.id, "projects.list", {
          params: { collaborationWorkspaceId: team }
        })
      ).json()
    ).items;
    expect(one.map((item) => item.title).sort()).toEqual(["Nord", "Notizen Lena"]);
    expect(one.find((item) => item.title === "Nord")?.conversationCount).toBe(2);
  });
});
