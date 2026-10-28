import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { agent, clientInstanceId, errorSchema, skill } from "./support/access-instance";
import { publishSkillDraft } from "./support/agent-draft-publication";
import {
  setupWorkspaceHolder as setup,
  type WorkspaceHolderInstance
} from "./support/asset-operations";

// One batch writes several assets, each against the revision its caller read, all of them or
// none. Every item here names its `expectedRevision` itself, so the helper that fills in the
// current one for other tests leaves the batch as it is written.

type Item =
  | { type: "put"; kind: string; config: Record<string, unknown>; expectedRevision?: number | null }
  | { type: "delete"; kind: string; name: string; expectedRevision?: number };

const putSkill = (name: string, expectedRevision: number | null | undefined, content?: string) =>
  ({ type: "put", kind: "skill", config: skill(name, content), expectedRevision }) satisfies Item;

/** A batch of Kai's workspace. */
const sync = (t: WorkspaceHolderInstance, userId: string, items: Item[], headers = {}) =>
  t.call(userId, "assets.sync", { payload: { workspaceId: t.kaiTeam, items }, headers });

const refusalOf = (response: Awaited<ReturnType<typeof sync>>) =>
  errorSchema.parse(response.json()).error;

const appliedSchema = z.object({
  version: z.number(),
  items: z.array(
    z.object({ type: z.string(), kind: z.string(), name: z.string(), status: z.string() }).loose()
  ),
  warnings: z.array(z.unknown())
});

describe("the revision each item of a batch is made against", () => {
  let t: WorkspaceHolderInstance;
  beforeAll(async () => {
    t = await setup({ furtherToolNames: ["read_skill"] });
    // Lena writes skills of Kai's workspace and may not read them.
    await t.grant(t.lena.id, "skill.write", { workspaceId: t.kaiTeam });
  });

  const revisionsOf = async (kind: string, name: string) =>
    (await t.stores.configAssets.listConfigAssetRevisions({ clientInstanceId, kind, name })).length;
  const version = async () =>
    (await t.stores.configAssets.getConfigAssetState({ clientInstanceId })).version;

  // Fails without the change: an item without a revision was written over whatever was there.
  it("refuses a batch with an item that names no revision, names the asset and stores nothing", async () => {
    const refused = await sync(t, t.kai.id, [
      putSkill("kai-first", null),
      putSkill("kai-blind", undefined)
    ]);

    expect(refused.statusCode).toBe(428);
    expect(refusalOf(refused)).toMatchObject({
      code: "PRECONDITION_REQUIRED",
      details: { assets: [{ kind: "skill", name: "kai-blind" }] }
    });
    expect(await t.stored("skill", "kai-first")).toBeUndefined();
    expect(await t.stored("skill", "kai-blind")).toBeUndefined();
  });

  // Fails without the change: the refusal was a 409 that named a revision to whoever asked.
  it("tells a stale item to who may read the asset, and only its name to who may not", async () => {
    await sync(t, t.kai.id, [putSkill("kai-guide", null)]);
    await sync(t, t.admin.id, [putSkill("kai-guide", 1, "Changed.")]);
    // The team's skill changes by its draft and that draft's publish (SKILL-DRAFT-1).
    await publishSkillDraft(t, "kai-guide", t.kaiTeam);

    const stale = await sync(t, t.kai.id, [
      putSkill("kai-guide", 1, "Stale."),
      putSkill("kai-beside", null)
    ]);
    expect(stale.statusCode).toBe(412);
    expect(refusalOf(stale)).toMatchObject({
      code: "REVISION_CONFLICT",
      details: {
        conflicts: [
          {
            kind: "skill",
            name: "kai-guide",
            currentRevision: 2,
            changedBy: "Admin",
            changedAt: expect.any(String)
          }
        ]
      }
    });
    expect(await t.stored("skill", "kai-guide")).toMatchObject({
      revision: 2,
      config: { content: "Changed." }
    });
    expect(await t.stored("skill", "kai-beside")).toBeUndefined();

    const unread = await sync(t, t.lena.id, [putSkill("kai-guide", 1, "Unread.")]);
    expect(unread.statusCode).toBe(412);
    const details = z
      .object({ conflicts: z.array(z.unknown()), items: z.array(z.unknown()) })
      .parse(refusalOf(unread).details);
    expect(details.conflicts).toEqual([{ kind: "skill", name: "kai-guide" }]);
    expect(JSON.stringify(details.items)).not.toContain("currentRevision");
    expect(JSON.stringify(details)).not.toContain("Admin");
  });

  it("refuses the creation of a name that exists", async () => {
    await sync(t, t.kai.id, [putSkill("kai-taken", null)]);

    const again = await sync(t, t.kai.id, [putSkill("kai-taken", null, "Again.")]);

    expect(again.statusCode).toBe(412);
    expect(refusalOf(again)).toMatchObject({
      code: "REVISION_CONFLICT",
      details: { conflicts: [{ kind: "skill", name: "kai-taken", currentRevision: 1 }] }
    });
    expect(await revisionsOf("skill", "kai-taken")).toBe(1);
  });

  // Fails without the change: a create brought a deleted asset back without having seen it go.
  it("creates a deleted name again only against the revision of its delete", async () => {
    await sync(t, t.kai.id, [putSkill("kai-gone", null)]);
    await sync(t, t.admin.id, [
      { type: "delete", kind: "skill", name: "kai-gone", expectedRevision: 1 }
    ]);

    const unseen = await sync(t, t.kai.id, [putSkill("kai-gone", null, "Back.")]);
    expect(unseen.statusCode).toBe(412);
    expect(refusalOf(unseen)).toMatchObject({
      code: "REVISION_CONFLICT",
      details: {
        conflicts: [{ kind: "skill", name: "kai-gone", currentRevision: 2, deleted: true }]
      }
    });
    expect(await t.stored("skill", "kai-gone")).toMatchObject({ status: "deleted", revision: 2 });

    const seen = await sync(t, t.kai.id, [putSkill("kai-gone", 2, "Back.")]);
    expect(seen.statusCode, seen.body).toBe(200);
    expect(await t.stored("skill", "kai-gone")).toMatchObject({ status: "active", revision: 3 });
  });

  // Fails without the change: a write was made against the version of the whole set, so any
  // other save refused it.
  it("is not refused for an asset it does not name", async () => {
    await sync(t, t.kai.id, [putSkill("kai-mine", null), putSkill("kai-theirs", null)]);
    await sync(t, t.admin.id, [putSkill("kai-theirs", 1, "Theirs, changed.")]);
    await publishSkillDraft(t, "kai-theirs", t.kaiTeam);

    const applied = await sync(t, t.kai.id, [putSkill("kai-mine", 1, "Mine, changed.")]);

    expect(applied.statusCode, applied.body).toBe(200);
    expect(appliedSchema.parse(applied.json())).toMatchObject({
      // The team's skill is written as its draft; live stays at 1 (SKILL-DRAFT-1).
      items: [
        {
          type: "put",
          kind: "skill",
          name: "kai-mine",
          status: "applied",
          revision: 1,
          draftRevision: 1
        }
      ],
      warnings: []
    });
    expect(await t.stored("skill", "kai-theirs")).toMatchObject({ revision: 2 });
  });

  it("lands a new skill and a new agent that names it as one, and nothing of them beside a stale third", async () => {
    await sync(t, t.kai.id, [putSkill("kai-third", null)]);
    await sync(t, t.admin.id, [putSkill("kai-third", 1, "Changed.")]);
    const pair: Item[] = [
      putSkill("kai-method", null),
      {
        type: "put",
        kind: "agent",
        config: agent("kai-analyst", { toolNames: ["read_skill"], skillNames: ["kai-method"] }),
        expectedRevision: null
      }
    ];
    const before = await version();

    const withStale = await sync(t, t.kai.id, [...pair, putSkill("kai-third", 1, "Stale.")]);
    expect(withStale.statusCode).toBe(412);
    expect(await t.stored("skill", "kai-method")).toBeUndefined();
    expect(await t.stored("agent", "kai-analyst")).toBeUndefined();
    expect(await version()).toBe(before);

    const alone = await sync(t, t.kai.id, pair);
    expect(alone.statusCode, alone.body).toBe(200);
    expect(await t.stored("skill", "kai-method")).toMatchObject({ status: "active", revision: 1 });
    expect(await t.stored("agent", "kai-analyst")).toMatchObject({
      revision: 1,
      config: { skillNames: ["kai-method"] }
    });
    // One version for the batch: nobody reads a set with the one and without the other.
    expect(await version()).toBe(before + 1);
  });

  // Fails without the change: both creations were written, the second as revision 2.
  it("answers two creations of one name that start together with one creation and one conflict", async () => {
    const create = (content: string) =>
      t.call(t.kai.id, "assets.put", {
        params: { kind: "skill", name: "kai-race" },
        payload: {
          config: skill("kai-race", content),
          expectedRevision: null,
          workspaceId: t.kaiTeam
        }
      });

    const answers = await Promise.all([create("One."), create("Two.")]);

    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 412]);
    const lost = answers.find((answer) => answer.statusCode === 412);
    expect(lost && errorSchema.parse(lost.json()).error.code).toBe("REVISION_CONFLICT");
    expect(await t.stored("skill", "kai-race")).toMatchObject({ revision: 1 });
    expect(await revisionsOf("skill", "kai-race")).toBe(1);
  });

  it("answers a batch sent again under its Idempotency-Key as the first time, and writes no revision", async () => {
    const batch = [putSkill("kai-once", null)];
    const headers = { "idempotency-key": "asset-sync-once" };

    const first = await sync(t, t.kai.id, batch, headers);
    const again = await sync(t, t.kai.id, batch, headers);

    expect(first.statusCode, first.body).toBe(200);
    // Without the key the second call is a creation of a name that exists.
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(await revisionsOf("skill", "kai-once")).toBe(1);
    expect((await sync(t, t.kai.id, batch)).statusCode).toBe(412);
  });
});
