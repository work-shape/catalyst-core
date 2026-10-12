import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { WorkflowAssetKind } from "@vivd-catalyst/chat-server";
import {
  AppError,
  StoreBackedAuditRecorder,
  defineAssetKind,
  type AuditRecorder
} from "@vivd-catalyst/core";
import { ASSET_SYNC_ITEM_MAX_BYTES } from "@vivd-catalyst/api-contract";
import {
  agent,
  clientInstanceId,
  errorSchema,
  skill,
  type AccessInstance
} from "./support/access-instance";
import {
  setupNamespaceHolder as setupNamespace,
  type NamespaceHolderInstance
} from "./support/asset-operations";

// What a write of an asset is refused for first, what a refusal tells a caller who may write
// an asset and not read it, and what a write answers once it is committed.

type Response = Awaited<ReturnType<AccessInstance["call"]>>;
const refusal = (response: Response) => ({
  status: response.statusCode,
  ...errorSchema.parse(response.json()).error
});

const memoSchema = z.strictObject({
  name: z.string(),
  text: z.string(),
  locked: z.boolean().optional()
});

/**
 * A kind a workspace may own as well as the instance, read and written with the rights of a
 * skill. A stored memo that is `locked` takes no write, as a Connection of release config.
 */
function createMemoKind(): WorkflowAssetKind {
  return {
    ...defineAssetKind({
      kind: "memo",
      plural: "memos",
      schema: memoSchema,
      owners: ["instance", "workspace"],
      nameRule: { pattern: /^[a-z][a-z0-9-]*$/u, maxLength: 40, description: "lowercase" },
      actions: { read: "skill.read", write: "skill.write", delete: "skill.delete" },
      validate: () => [],
      summarize: (memo) => ({ name: memo.name, title: memo.text })
    }),
    holdsInstanceDefault: false,
    hasWorkspaceAvailability: false,
    prepareInteractiveUpsert: ({ next }) => next,
    missingUpsertRight: () => undefined,
    assertInteractiveUpsertAllowed: () => undefined,
    assertInteractiveDeleteAllowed: () => undefined,
    assertStoredWritable({ current }) {
      if (memoSchema.safeParse(current).data?.locked) {
        throw new AppError("VALIDATION_FAILED", "The memo is read-only", {
          reason: "read_only_origin"
        });
      }
    }
  };
}

const memo = (name: string, text = "Text.", locked?: true) => ({
  name,
  text,
  ...(locked ? { locked } : {})
});

let t: NamespaceHolderInstance;
let workspaceId: string;
const audit = { failOn: undefined as number | undefined, updates: 0 };

// One instance for the file: the tests of a file share its database.
beforeAll(async () => {
  t = await setupNamespace({
    furtherKinds: [createMemoKind()],
    furtherToolNames: ["read_skill"],
    server: (stores) => {
      const recorder = new StoreBackedAuditRecorder({ clientInstanceId, store: stores.audit });
      const failing: AuditRecorder = {
        record(input) {
          if (input.type === "config_asset.updated") {
            audit.updates += 1;
            if (audit.updates === audit.failOn) {
              return Promise.reject(new Error("the audit store is down"));
            }
          }
          return recorder.record(input);
        }
      };
      return { auditRecorder: failing };
    }
  });
  workspaceId = await t.sharedWorkspace("Team");
});

describe("the order a write of an asset is refused in", () => {
  beforeAll(async () => {
    await t.put(t.kai.id, "agent", "kai-agent");
  });

  const withEffort = { config: agent("kai-agent", { reasoningEffort: "low" }) };
  const modelRight = { action: "agent_models.manage", reason: "no_grant" };

  // Fails without the change: a put that named no revision answered 428, and one against
  // another revision 412 with the revision, before the missing right was looked at.
  it("answers a put the right it lacks beside the write right before the revision", async () => {
    for (const expectedRevision of [undefined, 99]) {
      const refused = refusal(
        await t.call(t.kai.id, "assets.put", {
          params: { kind: "agent", name: "kai-agent" },
          payload: { ...withEffort, expectedRevision }
        })
      );
      expect(refused).toMatchObject({ status: 403, code: "FORBIDDEN", details: modelRight });
      expect(JSON.stringify(refused)).not.toContain("currentRevision");
    }
    // With every right, the missing revision is what is answered, and then the stale one.
    const put = (expectedRevision: number | undefined) =>
      t.call(t.root.id, "assets.put", {
        params: { kind: "agent", name: "kai-agent" },
        payload: { ...withEffort, expectedRevision }
      });
    expect(refusal(await put(undefined))).toMatchObject({
      status: 428,
      code: "PRECONDITION_REQUIRED"
    });
    expect(refusal(await put(99))).toMatchObject({ status: 412, code: "REVISION_CONFLICT" });
  });

  // Fails without the change: a revert was asked for the right its restored content needs
  // only after the revision, so it answered 428 or 412 with the revision first.
  it("answers a revert the right its restored content needs before the revision", async () => {
    await t.put(t.kai.id, "agent", "kai-reverted");
    const write = (config: Record<string, unknown>, expectedRevision: number) =>
      t.expectOk(t.root.id, "assets.put", {
        params: { kind: "agent", name: "kai-reverted" },
        payload: { config, expectedRevision }
      });
    await write(agent("kai-reverted", { reasoningEffort: "low" }), 1);
    await write(agent("kai-reverted"), 2);
    const revert = (userId: string, expectedRevision: number | undefined) =>
      t.call(userId, "assets.revert", {
        params: { kind: "agent", name: "kai-reverted" },
        payload: { revision: 2, expectedRevision }
      });
    for (const expectedRevision of [undefined, 99]) {
      const refused = refusal(await revert(t.kai.id, expectedRevision));
      expect(refused).toMatchObject({ status: 403, code: "FORBIDDEN", details: modelRight });
      expect(JSON.stringify(refused)).not.toContain("currentRevision");
    }
    expect(refusal(await revert(t.root.id, undefined))).toMatchObject({ status: 428 });
    expect(refusal(await revert(t.root.id, 99))).toMatchObject({ status: 412 });
  });

  // Fails without the change: the batch answered 428 for the missing revision first.
  it("answers a batch the right an item lacks before the revision an item does not name", async () => {
    const refused = refusal(
      await t.call(t.kai.id, "assets.sync", {
        payload: {
          namespace: "kai-",
          items: [{ type: "put", kind: "agent", ...withEffort, expectedRevision: undefined }]
        }
      })
    );
    expect(refused).toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      details: { items: [{ status: "refused", error: { action: "agent_models.manage" } }] }
    });
  });
});

describe("what a write tells a caller who may not read the asset", () => {
  beforeAll(async () => {
    // Lena writes and deletes in the Namespace and reads nothing of it.
    await t.grant(t.lena.id, "skill.write", { namespace: "kai-" });
    await t.grant(t.lena.id, "skill.delete", { namespace: "kai-" });
    const put = (name: string, config: Record<string, unknown>, workspace?: string) =>
      t.expectOk(t.admin.id, "assets.put", {
        params: { kind: "memo", name },
        payload: { config, ...(workspace ? { workspaceId: workspace } : {}) }
      });
    await put("kai-active", memo("kai-active"));
    await put("kai-gone", memo("kai-gone"));
    await t.expectOk(t.admin.id, "assets.delete", { params: { kind: "memo", name: "kai-gone" } });
    await put("kai-locked", memo("kai-locked", "Text.", true));
    await put("kai-team", memo("kai-team"), workspaceId);
  });

  /** A refusal without the name it is about, so that two of them can be compared. */
  const shape = (response: Response, name: string) =>
    JSON.parse(JSON.stringify(refusal(response)).replaceAll(name, "<name>")) as unknown;
  const del = (userId: string, name: string, expectedRevision: number) =>
    t.call(userId, "assets.delete", {
      params: { kind: "memo", name },
      payload: { expectedRevision }
    });
  const put = (userId: string, name: string, expectedRevision: number | null | undefined) =>
    t.call(userId, "assets.put", {
      params: { kind: "memo", name },
      payload: { config: memo(name, "Written."), expectedRevision }
    });
  const sync = (userId: string, items: unknown[]) =>
    t.call(userId, "assets.sync", { payload: { namespace: "kai-", items } });
  const nameOnly = (name: string) => ({
    status: 412,
    code: "REVISION_CONFLICT",
    details: { reason: "revision_conflict", conflicts: [{ kind: "memo", name }] }
  });

  // Fails without the change: an asset that was not there answered 404 and one that was
  // answered 412, so a delete told its caller which names exist.
  it("answers a delete the same whether the asset is there, deleted or was never stored", async () => {
    const stale = await del(t.lena.id, "kai-active", 99);
    expect(refusal(stale)).toMatchObject(nameOnly("kai-active"));
    expect(refusal(stale).details).toEqual(nameOnly("kai-active").details);
    for (const name of ["kai-gone", "kai-never", "kai-team"]) {
      expect(shape(await del(t.lena.id, name, 99), name)).toEqual(shape(stale, "kai-active"));
    }
    // In a batch as well.
    const batch = (name: string) =>
      sync(t.lena.id, [{ type: "delete", kind: "memo", name, expectedRevision: 99 }]);
    const staleBatch = await batch("kai-active");
    expect(refusal(staleBatch)).toMatchObject({ status: 412, code: "REVISION_CONFLICT" });
    for (const name of ["kai-gone", "kai-never", "kai-team"]) {
      expect(shape(await batch(name), name)).toEqual(shape(staleBatch, "kai-active"));
    }
    // Who reads the asset is told which it is.
    expect(refusal(await del(t.admin.id, "kai-never", 99))).toMatchObject({ status: 404 });
    expect(refusal(await del(t.admin.id, "kai-active", 99))).toMatchObject({
      status: 412,
      details: { conflicts: [{ name: "kai-active", currentRevision: 1 }] }
    });
  });

  // Fails without the change: the write answered 422 "belongs to another scope", in a batch
  // before the missing revision, to a caller who may not read the workspace's asset.
  it("tells a name that another owner holds only to who may read that asset", async () => {
    expect(refusal(await put(t.lena.id, "kai-team", undefined))).toMatchObject({ status: 428 });
    for (const expectedRevision of [null, 1]) {
      const single = await put(t.lena.id, "kai-team", expectedRevision);
      expect(refusal(single).details).toEqual(nameOnly("kai-team").details);
      expect(refusal(single)).toMatchObject(nameOnly("kai-team"));
      // Kai reads the Namespace's own memos and nothing of the workspace.
      const kai = await put(t.kai.id, "kai-team", expectedRevision);
      expect(refusal(kai).details).toEqual(nameOnly("kai-team").details);
    }
    const item = (expectedRevision: number | null | undefined) => ({
      type: "put",
      kind: "memo",
      config: memo("kai-team", "Written."),
      expectedRevision
    });
    expect(refusal(await sync(t.lena.id, [item(undefined)]))).toMatchObject({ status: 428 });
    const batch = refusal(await sync(t.kai.id, [item(null)]));
    expect(batch).toMatchObject({ status: 412, code: "REVISION_CONFLICT" });
    expect(z.object({ conflicts: z.unknown() }).parse(batch.details).conflicts).toEqual([
      { kind: "memo", name: "kai-team" }
    ]);
    expect(JSON.stringify(batch)).not.toContain("scope");
    // The administrator reads the workspace's memo and is told where the name is.
    const told = refusal(await put(t.admin.id, "kai-team", null));
    expect(told).toMatchObject({ status: 422, details: { reason: "invalid_scope" } });
    expect(refusal(await sync(t.admin.id, [item(null)]))).toMatchObject({ status: 422 });
    await expect(
      t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "memo", name: "kai-team" })
    ).resolves.toMatchObject({ revision: 1, scope: { kind: "workspace" } });
  });

  // Fails without the change: a stored asset that takes no write answered so to every
  // writer, whatever revision the write named, which told a writer who reads nothing that the
  // asset is there and what it is.
  it("tells that a stored asset takes no write only to a reader or against its revision", async () => {
    const stale = await put(t.lena.id, "kai-locked", 99);
    expect(shape(stale, "kai-locked")).toEqual(
      shape(await put(t.lena.id, "kai-active", 99), "kai-active")
    );
    expect(shape(await del(t.lena.id, "kai-locked", 99), "kai-locked")).toEqual(
      shape(await del(t.lena.id, "kai-active", 99), "kai-active")
    );
    const staleItem = (name: string) =>
      sync(t.lena.id, [
        { type: "put", kind: "memo", config: memo(name, "Written."), expectedRevision: 99 }
      ]);
    expect(shape(await staleItem("kai-locked"), "kai-locked")).toEqual(
      shape(await staleItem("kai-active"), "kai-active")
    );
    // Against the revision the asset is at, the write would be made: it is told why not.
    for (const answer of [
      await put(t.lena.id, "kai-locked", 1),
      await del(t.lena.id, "kai-locked", 1),
      await sync(t.lena.id, [
        { type: "put", kind: "memo", config: memo("kai-locked", "Written."), expectedRevision: 1 }
      ])
    ]) {
      expect(refusal(answer)).toMatchObject({ status: 422 });
      expect(JSON.stringify(refusal(answer))).toContain("read-only");
    }
    // A reader is told at once, whatever revision the write names.
    expect(refusal(await put(t.admin.id, "kai-locked", 99))).toMatchObject({
      status: 422,
      details: { reason: "read_only_origin" }
    });
    expect(await t.stored("memo", "kai-locked")).toMatchObject({ revision: 1 });
  });

  // What cannot be kept back, pinned: a create of a name that is taken is refused, so its
  // caller knows the name is used. Nothing else is told: no revision, no writer, no time, and
  // not whether the asset is active, deleted or another owner's.
  it("tells a create of a taken name that the name is used, and nothing else", async () => {
    const answers = [];
    for (const name of ["kai-active", "kai-gone", "kai-team", "kai-locked"]) {
      const taken = await put(t.lena.id, name, null);
      expect(refusal(taken).details).toEqual(nameOnly(name).details);
      answers.push(shape(taken, name));
    }
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
    // A name that was never stored is created: that difference is the one a create tells.
    expect((await put(t.lena.id, "kai-fresh", null)).statusCode).toBe(200);
  });
});

describe("what a committed write answers", () => {
  /** Runs `between` inside the next write of the store, before or after it is committed. */
  const race = (when: "before" | "after", between: () => Promise<unknown>) => {
    const store = t.stores.configAssets;
    const apply = store.applyConfigAssetMutations.bind(store);
    store.applyConfigAssetMutations = async (input) => {
      store.applyConfigAssetMutations = apply;
      if (when === "before") await between();
      const result = await apply(input);
      if (when === "after") await between();
      return result;
    };
  };
  const putSkill = (name: string, expectedRevision: number | null, content = "Guidance.") => ({
    type: "put",
    kind: "skill",
    config: skill(name, content),
    expectedRevision
  });
  const sync = (userId: string, items: unknown[]) =>
    t.call(userId, "assets.sync", { payload: { namespace: "kai-", items } });

  // Fails without the change: the put read the asset again after its commit and answered the
  // revision of whoever wrote next, so its caller's next save went over that write unseen.
  it("answers a put the revision it wrote, not the one a later write gave the asset", async () => {
    await t.put(t.kai.id, "skill", "kai-mine");
    race("after", () =>
      t.stores.configAssets.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { "skill:kai-mine": 2 },
        mutations: [
          { type: "upsert", kind: "skill", name: "kai-mine", config: skill("kai-mine", "Theirs.") }
        ]
      })
    );
    const mine = await t.expectOk(t.kai.id, "assets.put", {
      params: { kind: "skill", name: "kai-mine" },
      payload: { config: skill("kai-mine", "Mine."), expectedRevision: 1 }
    });
    expect(mine.json()).toMatchObject({ revision: 2 });
    expect(await t.stored("skill", "kai-mine")).toMatchObject({ revision: 3 });

    // The next save from that answer is refused: the other write is not gone over.
    const next = await t.call(t.kai.id, "assets.put", {
      params: { kind: "skill", name: "kai-mine" },
      payload: { config: skill("kai-mine", "Mine again."), expectedRevision: 2 }
    });
    expect(next.statusCode).toBe(412);
    expect(await t.stored("skill", "kai-mine")).toMatchObject({
      revision: 3,
      config: { content: "Theirs." }
    });
  });

  // Fails without the change: the set was checked before the lock alone. A write that gave
  // an agent a skill and one that deleted the skill each passed, and the agent was left with a
  // skill that is gone.
  it("refuses a write that another write made invalid between its check and its lock", async () => {
    await t.put(t.kai.id, "skill", "kai-shared");
    await t.put(t.kai.id, "agent", "kai-reader");
    const assign = (userId: string) =>
      t.call(userId, "assets.put", {
        params: { kind: "agent", name: "kai-reader" },
        payload: {
          config: agent("kai-reader", { skillNames: ["kai-shared"], toolNames: ["read_skill"] }),
          expectedRevision: 1
        }
      });
    const deleteSkill = () =>
      t.stores.configAssets.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { "skill:kai-shared": 1 },
        mutations: [{ type: "delete", kind: "skill", name: "kai-shared" }]
      });

    race("before", deleteSkill);
    const refused = await assign(t.admin.id);
    expect(refused.statusCode, refused.body).toBe(422);
    expect(await t.stored("agent", "kai-reader")).toMatchObject({
      revision: 1,
      config: { skillNames: [] }
    });
    expect(await t.stored("skill", "kai-shared")).toMatchObject({ status: "deleted" });

    // The other way round in a batch: the delete is refused once the agent names the skill.
    await t.put(t.kai.id, "skill", "kai-kept");
    await t.put(t.kai.id, "agent", "kai-keeper");
    race("before", () =>
      t.stores.configAssets.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { "agent:kai-keeper": 1 },
        mutations: [
          {
            type: "upsert",
            kind: "agent",
            name: "kai-keeper",
            config: agent("kai-keeper", { skillNames: ["kai-kept"], toolNames: ["read_skill"] })
          }
        ]
      })
    );
    const batch = await sync(t.admin.id, [
      { type: "delete", kind: "skill", name: "kai-kept", expectedRevision: 1 },
      putSkill("kai-beside", null)
    ]);
    expect(batch.statusCode, batch.body).toBe(422);
    expect(await t.stored("skill", "kai-kept")).toMatchObject({ status: "active", revision: 1 });
    expect(await t.stored("skill", "kai-beside")).toBeUndefined();
  });

  // Fails without the change: the rows of the trail were written one by one after the commit
  // and the first that failed made the call fail, with every asset written and a caller who
  // was told that nothing was.
  it("answers a batch it committed as applied when a row of the trail cannot be written", async () => {
    audit.updates = 0;
    audit.failOn = 2;
    const applied = await sync(t.kai.id, [
      putSkill("kai-one", null),
      putSkill("kai-two", null),
      putSkill("kai-three", null)
    ]);
    audit.failOn = undefined;

    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json()).toMatchObject({
      items: [
        { name: "kai-one", status: "applied", revision: 1, id: expect.any(String) },
        { name: "kai-two", status: "applied", revision: 1 },
        { name: "kai-three", status: "applied", revision: 1 }
      ]
    });
    for (const name of ["kai-one", "kai-two", "kai-three"]) {
      expect(await t.stored("skill", name)).toMatchObject({ status: "active", revision: 1 });
    }
    // The rows that could be written are there: the one after the failure too.
    const rows = await t.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "config_asset.updated",
      limit: 50
    });
    const names = rows.map((row) => z.object({ name: z.string() }).parse(row.metadata).name);
    expect(names).toEqual(expect.arrayContaining(["kai-one", "kai-three"]));
    expect(names).not.toContain("kai-two");
  });

  // Fails without the change: a revision number was all an item named, so an item read of
  // another asset of the same name at the same number was written.
  it("refuses an item whose asset is another one than its caller read, and writes nothing", async () => {
    await t.put(t.kai.id, "skill", "kai-replaced");
    const id = await t.assetId("skill", "kai-replaced");
    const item = (expectedAssetId: string) => ({
      ...putSkill("kai-replaced", 1, "Changed."),
      expectedAssetId
    });

    const refused = refusal(
      await sync(t.kai.id, [item("cfga_of_another_database"), putSkill("kai-along", null)])
    );
    expect(refused).toMatchObject({
      status: 409,
      code: "CONFLICT",
      details: {
        items: [
          { name: "kai-replaced", status: "refused", error: { code: "CONFLICT" } },
          { name: "kai-along", status: "not_applied" }
        ]
      }
    });
    expect(JSON.stringify(refused)).toContain("another database");
    expect(await t.stored("skill", "kai-replaced")).toMatchObject({ revision: 1 });
    expect(await t.stored("skill", "kai-along")).toBeUndefined();

    expect((await sync(t.kai.id, [item(id)])).statusCode).toBe(200);
  });

  // Fails without the change: one item could hold the body of a whole batch.
  it("refuses an item whose definition is larger than one item holds", async () => {
    const large = putSkill("kai-large", null, "x".repeat(ASSET_SYNC_ITEM_MAX_BYTES));
    const refused = refusal(await sync(t.kai.id, [large, putSkill("kai-small", null)]));
    expect(refused).toMatchObject({
      status: 422,
      details: { items: [{ name: "kai-large", status: "refused" }, { status: "not_applied" }] }
    });
    expect(JSON.stringify(refused)).toContain(`${ASSET_SYNC_ITEM_MAX_BYTES} bytes`);
    expect(await t.stored("skill", "kai-small")).toBeUndefined();
  });
});
