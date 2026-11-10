import { describe, expect, it } from "vitest";
import { z } from "zod";
import { setupWorkspaceHolder as setup } from "./support/asset-operations";

// Studio's lists start on every owner the reader is offered (fix/studio-where-filter): one
// `assets.list` page across the owners `owners` names, each row with its owner, and every row
// shown by the same right as in its owner's own list.

const pageSchema = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      scope: z.union([
        z.object({ kind: z.literal("instance") }),
        z.object({ kind: z.literal("workspace"), workspaceId: z.string() })
      ]),
      isDefault: z.literal(true).optional()
    })
  ),
  nextCursor: z.string().optional()
});

describe("a list of several owners", () => {
  it("answers one page across the owners named, by the rights of each owner's own list", async () => {
    const t = await setup();
    const otherTeam = await t.sharedWorkspace("Other team");
    await t.put(t.admin.id, "skill", "house-skill");
    await t.put(t.kai.id, "skill", "kai-skill", t.kaiTeam);
    await t.put(t.admin.id, "skill", "other-skill", otherTeam);
    const skills = (userId: string, query: Record<string, string>) =>
      t
        .expectOk(userId, "assets.list", { params: { kind: "skill" }, query })
        .then((response) => pageSchema.parse(response.json()));
    const every = (...owners: string[]) => ({ owners: owners.join(",") });

    // The administrator's every-owner list holds what each owner's list holds, with its owner.
    const all = await skills(t.admin.id, every("instance", t.kaiTeam, otherTeam));
    expect(all.items.map(({ name, scope }) => ({ name, scope }))).toEqual([
      { name: "house-skill", scope: { kind: "instance" } },
      { name: "kai-skill", scope: { kind: "workspace", workspaceId: t.kaiTeam } },
      { name: "other-skill", scope: { kind: "workspace", workspaceId: otherTeam } }
    ]);
    // An owner left out is not listed.
    expect(
      (await skills(t.admin.id, every("instance", t.kaiTeam))).items.map((item) => item.name)
    ).toEqual(["house-skill", "kai-skill"]);
    expect((await skills(t.admin.id, every(t.kaiTeam))).items.map((item) => item.name)).toEqual([
      "kai-skill"
    ]);

    // Naming an owner opens nothing: Kai holds rights in his own team alone.
    expect(
      (await skills(t.kai.id, every("instance", t.kaiTeam, otherTeam))).items.map(
        (item) => item.name
      )
    ).toEqual(["kai-skill"]);
    expect((await skills(t.lena.id, every("instance", t.kaiTeam, otherTeam))).items).toEqual([]);

    // The pages run on across the owners by name.
    const first = await skills(t.admin.id, {
      ...every("instance", t.kaiTeam, otherTeam),
      limit: "2"
    });
    expect(first.items.map((item) => item.name)).toEqual(["house-skill", "kai-skill"]);
    expect(first.nextCursor).toBeDefined();
    const second = await skills(t.admin.id, {
      ...every("instance", t.kaiTeam, otherTeam),
      limit: "2",
      cursor: first.nextCursor ?? ""
    });
    expect(second.items.map((item) => item.name)).toEqual(["other-skill"]);

    // Owners and one workspace are two ways to name a list, not one.
    await t.expectRefused(
      t.admin.id,
      "assets.list",
      {
        params: { kind: "skill" },
        query: { ...every("instance", t.kaiTeam), workspaceId: t.kaiTeam }
      },
      { status: 422, code: "VALIDATION_FAILED" }
    );
  });
});
