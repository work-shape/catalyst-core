import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { asUserId } from "@work-shape/catalyst-core";
import { agent, clientInstanceId } from "./support/access-instance";
import { setupWorkspaceHolder } from "./support/asset-operations";

// What a read of one asset answers beyond the asset, and how much of its history a call reads:
// the workspaces of its availability only as far as the caller sees them, one page of the
// revisions, and one revision for a restore.

const availabilitySchema = z.object({
  availability: z.object({
    mode: z.string(),
    personalWorkspaces: z.boolean(),
    collaborationWorkspaceIds: z.array(z.string())
  })
});
const revisionPageSchema = z.object({
  items: z.array(z.object({ revision: z.number(), operation: z.string() })),
  nextCursor: z.string().optional()
});
const address = { params: { kind: "agent", name: "kai-intake" } };

describe("the availability of an agent in assets.get", () => {
  it("names only the workspaces its reader may see, and all of them to an administrator", async () => {
    const t = await setupWorkspaceHolder();
    await t.put(t.admin.id, "agent", "kai-intake");
    // Kai and Lena read the agent of the instance through a grant on it. Kai is a member of
    // one workspace the agent is offered in, Lena of the other.
    const assetId = await t.assetId("agent", "kai-intake");
    for (const [user, collaborationWorkspaceId] of [
      [t.kai, t.kaiTeam],
      [t.lena, t.lenaTeam]
    ] as const) {
      await t.grant(user.id, "agent.read", { assetId });
      await t.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId,
        userId: asUserId(user.id),
        role: "member"
      });
    }
    await t.stores.configAssets.setAgentAvailability({
      clientInstanceId,
      agentName: "kai-intake",
      availability: {
        mode: "selected",
        personalWorkspaces: true,
        collaborationWorkspaceIds: [t.kaiTeam, t.lenaTeam]
      }
    });
    const seenBy = async (userId: string) => {
      const response = await t.expectOk(userId, "assets.get", address);
      const { availability } = availabilitySchema.parse(response.json());
      expect(availability).toMatchObject({ mode: "selected", personalWorkspaces: true });
      return availability.collaborationWorkspaceIds;
    };

    expect(await seenBy(t.kai.id)).toEqual([t.kaiTeam]);
    expect(await seenBy(t.lena.id)).toEqual([t.lenaTeam]);
    // Whoever may set the availability lists every Shared Workspace, and reads them all here.
    const all = [t.kaiTeam, t.lenaTeam].sort();
    expect((await seenBy(t.admin.id)).sort()).toEqual(all);
    expect((await seenBy(t.root.id)).sort()).toEqual(all);
  });
});

describe("the history of an asset", () => {
  it("is listed newest first a page at a time and restored from the one revision named", async () => {
    const t = await setupWorkspaceHolder();
    const inKai = { workspaceId: t.kaiTeam };
    for (const instructions of ["One.", "Two.", "Three.", "Four.", "Five."]) {
      const response = await t.call(t.kai.id, "assets.put", {
        ...address,
        payload: { config: agent("kai-intake", { instructions }), ...inKai }
      });
      expect(response.statusCode, response.body).toBe(200);
      await t.publishDraft("kai-intake", t.kaiTeam);
    }
    const list = vi.spyOn(t.stores.configAssets, "listConfigAssetRevisions");
    const page = async (query: { limit: number; cursor?: string }) =>
      revisionPageSchema.parse(
        (
          await t.expectOk(t.kai.id, "assets.revisions.list", {
            ...address,
            query: { ...query, ...inKai }
          })
        ).json()
      );

    // Newest first. The store is asked for the page, in that order, and for the one row
    // that tells whether another follows.
    const first = await page({ limit: 2 });
    expect(first.items.map((item) => item.revision)).toEqual([5, 4]);
    expect(list).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: { limit: 3 }, newestFirst: true })
    );
    const second = await page({ limit: 2, cursor: first.nextCursor });
    expect(second.items.map((item) => item.revision)).toEqual([3, 2]);
    expect(list).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: { limit: 3, after: [4] }, newestFirst: true })
    );
    // The last page carries no cursor: every revision was answered once, down to the first.
    const last = await page({ limit: 2, cursor: second.nextCursor });
    expect(last).toEqual({ items: [{ revision: 1, operation: "create" }] });

    // A restore reads the revision it names and no list of them.
    list.mockClear();
    await t.expectOk(t.kai.id, "assets.revert", { ...address, payload: { revision: 2, ...inKai } });
    expect(list).not.toHaveBeenCalled();
    await t.publishDraft("kai-intake", t.kaiTeam);
    expect(await t.stored("agent", "kai-intake")).toMatchObject({
      revision: 6,
      config: { instructions: "Two." }
    });
    await t.expectRefused(
      t.kai.id,
      "assets.revert",
      { ...address, payload: { revision: 9, ...inKai } },
      { status: 422, code: "VALIDATION_FAILED" }
    );
  });
});
