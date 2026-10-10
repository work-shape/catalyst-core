import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ASSET_RELEASE_SYNC_MAX_ITEMS, ASSET_SYNC_MAX_ITEMS } from "@vivd-catalyst/api-contract";
import { defineAssetKind } from "@vivd-catalyst/core";
import {
  SERVICE_HEADER,
  agent,
  clientInstanceId,
  errorSchema,
  type AccessInstance
} from "./support/access-instance";
import {
  SERVICE,
  asService,
  deleteAgent,
  putAgent,
  putSkill,
  refusedItems,
  releaseAsService,
  setupRelease as setup,
  syncAs,
  syncAsService,
  type Item
} from "./support/asset-release";

// A release through `assets.sync` does what the release path, `config_assets.replace`, does
// with the same content: where its agents start, what it refuses, how it names the default
// agent, what a delete of nothing is, and how much it holds. And nothing of that reaches a
// caller who holds no release right, or another operation.

const availabilityOf = async (t: AccessInstance, name: string) =>
  (await t.stores.configAssets.listAgentAvailability({ clientInstanceId })).get(name);
const defaultAgentOf = async (t: AccessInstance) =>
  (await t.stores.configAssets.getConfigAssetState({ clientInstanceId })).defaultAgentName;
const hiddenSchema = z.object({ hiddenAgentNames: z.array(z.string()).optional() });

/** The same content through the release path, as the CLI sends it today. */
const replace = (t: AccessInstance, payload: Item) =>
  t.instance.call("config_assets.replace", {
    payload: { baseVersion: null, mode: "merge", agents: [], skills: [], ...payload },
    headers: { [SERVICE_HEADER]: SERVICE }
  });

async function placeInChosenWorkspaces(t: AccessInstance, agentName: string) {
  await t.stores.configAssets.setAgentAvailability({
    clientInstanceId,
    agentName,
    availability: { mode: "selected", personalWorkspaces: true, collaborationWorkspaceIds: [] }
  });
}

describe("where the agents of a release start", () => {
  it("is where the release path starts them: everywhere, and hidden when the batch renames a placed agent", async () => {
    const t = await setup();
    // One agent for each path to rename, both placed in chosen workspaces.
    await t.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      mutations: [{ type: "upsert", kind: "agent", name: "rel-older", config: agent("rel-older") }]
    });
    await placeInChosenWorkspaces(t, "rel-old");
    await placeInChosenWorkspaces(t, "rel-older");

    // A new agent beside the others is available everywhere.
    const added = await syncAsService(t, [putAgent("added")]);
    const addedByReplace = await replace(t, { agents: [agent("added-by-replace")] });
    expect(added.statusCode, added.body).toBe(200);
    expect(addedByReplace.statusCode, addedByReplace.body).toBe(200);
    expect(await availabilityOf(t, "added")).toMatchObject({ mode: "all" });
    expect(await availabilityOf(t, "added")).toEqual(await availabilityOf(t, "added-by-replace"));
    expect(hiddenSchema.parse(added.json()).hiddenAgentNames).toBeUndefined();
    expect(hiddenSchema.parse(addedByReplace.json()).hiddenAgentNames).toBeUndefined();

    // A batch that deletes an agent placed in chosen workspaces renames it: the new one is hidden.
    const renamed = await syncAsService(t, [putAgent("renamed"), deleteAgent("rel-old")]);
    const renamedByReplace = await replace(t, {
      agents: [agent("renamed-by-replace")],
      deleteAssets: [{ kind: "agent", name: "rel-older" }]
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamedByReplace.statusCode, renamedByReplace.body).toBe(200);
    expect(await availabilityOf(t, "renamed")).toEqual({
      mode: "selected",
      personalWorkspaces: false,
      collaborationWorkspaceIds: []
    });
    expect(await availabilityOf(t, "renamed")).toEqual(
      await availabilityOf(t, "renamed-by-replace")
    );
    expect(hiddenSchema.parse(renamed.json()).hiddenAgentNames).toEqual(["renamed"]);
    expect(hiddenSchema.parse(renamedByReplace.json()).hiddenAgentNames).toEqual([
      "renamed-by-replace"
    ]);
  });

  it("leaves an agent created or brought back by a put, a revert or another caller's sync where it always started", async () => {
    const t = await setup();
    await placeInChosenWorkspaces(t, "rel-old");
    // A key that may write agents one by one: its calls come from automation, as the CLI's do.
    for (const action of ["agent.write", "agent.delete"]) {
      await t.stores.access.createGrant({
        clientInstanceId,
        holderKind: "service_principal",
        holderId: SERVICE,
        action,
        effect: "allow",
        scopeKind: "instance",
        grantedBy: t.admin.id
      });
    }
    const address = (name: string) => ({ params: { kind: "agent", name } });

    const created = await asService(t, "assets.put", {
      ...address("by-key"),
      payload: { config: agent("by-key") }
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(await availabilityOf(t, "by-key")).toMatchObject({ mode: "all" });

    const deleted = await asService(t, "assets.delete", {
      ...address("rel-old"),
      payload: { expectedRevision: 1 }
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    const revived = await asService(t, "assets.revert", {
      ...address("rel-old"),
      payload: { revision: 1, expectedRevision: 2 }
    });
    expect(revived.statusCode, revived.body).toBe(200);
    expect(await availabilityOf(t, "rel-old")).toMatchObject({ mode: "all" });

    // Neither does a sync of a caller who holds no release right.
    const synced = await syncAs(t, t.admin.id, [putAgent("rel-by-sync")]);
    expect(synced.statusCode, synced.body).toBe(200);
    expect(await availabilityOf(t, "rel-by-sync")).toMatchObject({ mode: "all" });
    expect(hiddenSchema.parse(synced.json()).hiddenAgentNames).toBeUndefined();
  });
});

describe("a definition in a release", () => {
  it("is refused for a model setting the instance cannot run, where an interactive save drops it", async () => {
    const t = await setup();
    const fast = { modelProviderId: undefined, modelBindingId: "plain", fastMode: true };

    const refused = await syncAsService(t, [putAgent("rel-old", fast, 1)]);
    const refusedByReplace = await replace(t, { agents: [agent("assistant", fast)] });
    expect(refused.statusCode).toBe(422);
    expect(refusedByReplace.statusCode).toBe(422);
    // Both name the setting, in the words of the one check of the set.
    const issuesOf = (response: { json(): unknown }) =>
      JSON.stringify(errorSchema.parse(response.json()).error.details);
    expect(issuesOf(refused)).toContain("fast mode");
    expect(issuesOf(refusedByReplace)).toContain("fast mode");
    expect(await t.stored("agent", "rel-old")).toMatchObject({ revision: 1 });

    // The superadmin's save through the same operation is adjusted, as it always was.
    const saved = await syncAs(t, t.root.id, [putAgent("rel-old", fast, 1)]);
    expect(saved.statusCode, saved.body).toBe(200);
    const config = (await t.stored("agent", "rel-old"))?.config;
    expect(config).toMatchObject({ modelBindingId: "plain" });
    expect(config).not.toHaveProperty("fastMode");
  });

  it("is refused for a kind no release carries, by the kind's name", async () => {
    const widgetKind = {
      ...defineAssetKind({
        kind: "widget",
        plural: "widgets",
        schema: z.object({ name: z.string(), title: z.string() }),
        nameRule: { pattern: /^[a-z][a-z0-9-]*$/u, description: "Widget name is invalid" },
        actions: { read: "widget.read", write: "widget.write", delete: "widget.delete" },
        validate: () => [],
        summarize: (widget) => ({ name: widget.name, title: widget.title })
      }),
      holdsInstanceDefault: false,
      hasWorkspaceAvailability: false,
      prepareInteractiveUpsert: ({ next }: { next: Record<string, unknown> }) => next,
      missingUpsertRight: () => undefined,
      assertInteractiveUpsertAllowed: () => undefined,
      assertInteractiveDeleteAllowed: () => undefined
    };
    const t = await setup({ furtherKinds: [widgetKind] });

    const refused = await syncAsService(t, [
      putSkill("rel-guide", "Pushed.", 1),
      { type: "put", kind: "widget", config: { name: "board", title: "Board" } }
    ]);
    expect(refused.statusCode).toBe(422);
    expect(refusedItems(refused).items).toEqual([
      { name: "rel-guide", status: "not_applied" },
      {
        name: "board",
        status: "refused",
        code: "VALIDATION_FAILED",
        message: "Asset kind 'widget' is not part of a release"
      }
    ]);
    expect(await t.stored("widget", "board")).toBeUndefined();
    expect(await t.stored("skill", "rel-guide")).toMatchObject({ revision: 1 });
  });
});

describe("the default agent of a release", () => {
  it("is named by the batch: beside its items, in place of a deleted default, and alone", async () => {
    const t = await setup();
    const before = await t.version();

    // The default moves while the agent that held it stays.
    const moved = await releaseAsService(t, {
      items: [putAgent("rel-intake")],
      defaultAgentName: "rel-old",
      expectedDefaultAgentName: "assistant"
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(await defaultAgentOf(t)).toBe("rel-old");
    expect(await t.stored("agent", "assistant")).toMatchObject({ status: "active" });
    expect(await t.version()).toBe(before + 1);

    // A batch without items changes the default and nothing else.
    const alone = await releaseAsService(t, { items: [], defaultAgentName: "rel-intake" });
    expect(alone.statusCode, alone.body).toBe(200);
    expect(alone.json()).toMatchObject({ version: before + 2, items: [] });
    expect(await defaultAgentOf(t)).toBe("rel-intake");

    // The default is deleted and replaced in one batch, while other agents stay.
    const replaced = await releaseAsService(t, {
      items: [deleteAgent("rel-intake")],
      defaultAgentName: "assistant"
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(await defaultAgentOf(t)).toBe("assistant");
    expect(await t.stored("agent", "rel-intake")).toMatchObject({ status: "deleted" });
    expect(await t.stored("agent", "rel-old")).toMatchObject({ status: "active" });
  });

  it("is refused against another default than the caller read, for a name that is no agent, and for anyone without the release right", async () => {
    const t = await setup();

    const stale = await releaseAsService(t, {
      items: [],
      defaultAgentName: "rel-old",
      expectedDefaultAgentName: "somebody"
    });
    expect(stale.statusCode).toBe(409);
    expect(errorSchema.parse(stale.json()).error.details).toEqual({
      reason: "default_agent_changed",
      currentDefaultAgentName: "assistant"
    });
    // The expectation is checked also where the batch leaves the default as it is.
    const before = await t.version();
    const staleUpdate = await releaseAsService(t, {
      items: [putSkill("rel-guide", "Pushed.", 1)],
      expectedDefaultAgentName: "somebody"
    });
    expect(staleUpdate.statusCode).toBe(409);
    expect(await t.stored("skill", "rel-guide")).toMatchObject({ revision: 1 });
    expect(await t.version()).toBe(before);
    const current = await releaseAsService(t, {
      items: [putSkill("rel-guide", "Pushed.", 1)],
      expectedDefaultAgentName: "assistant"
    });
    expect(current.statusCode, current.body).toBe(200);
    expect(await defaultAgentOf(t)).toBe("assistant");
    const nobody = await releaseAsService(t, { items: [], defaultAgentName: "nobody" });
    expect(nobody.statusCode).toBe(422);
    const empty = await releaseAsService(t, { items: [] });
    expect(errorSchema.parse(empty.json()).error).toMatchObject({
      code: "VALIDATION_FAILED",
      message: "A batch needs an item or a default agent"
    });
    // An administrator changes the default through the operation that is his.
    for (const userId of [t.admin.id, t.root.id]) {
      const refused = await syncAs(t, userId, [], { defaultAgentName: "rel-old" });
      expect(refused.statusCode).toBe(403);
      expect(errorSchema.parse(refused.json()).error.details).toEqual({
        action: "assets.release",
        reason: "no_grant"
      });
    }
    expect(await defaultAgentOf(t)).toBe("assistant");
  });
});

describe("a delete in a release", () => {
  it("of an asset that is not there is reported and refuses nothing, for the release holder only", async () => {
    const t = await setup();
    await t.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      mutations: [{ type: "delete", kind: "agent", name: "rel-old" }]
    });
    const release = [
      deleteAgent("rel-never-there"),
      deleteAgent("rel-old", 2),
      putSkill("rel-guide", "Pushed.", 1)
    ];

    const asAdmin = await syncAs(t, t.admin.id, release);
    expect(asAdmin.statusCode).toBe(404);
    expect(refusedItems(asAdmin).items.map((item) => [item.name, item.status])).toEqual([
      ["rel-never-there", "refused"],
      ["rel-old", "refused"],
      ["rel-guide", "not_applied"]
    ]);

    const pushed = await syncAsService(t, release);
    expect(pushed.statusCode, pushed.body).toBe(200);
    expect(pushed.json()).toMatchObject({
      items: [
        { type: "delete", kind: "agent", name: "rel-never-there", status: "absent" },
        { type: "delete", kind: "agent", name: "rel-old", status: "absent" },
        { type: "put", kind: "skill", name: "rel-guide", status: "applied", revision: 2 }
      ]
    });
    expect(await t.stored("agent", "rel-never-there")).toBeUndefined();
    expect(await t.stored("agent", "rel-old")).toMatchObject({ status: "deleted", revision: 2 });
  });
});

describe("the size of a batch", () => {
  const skills = (count: number) =>
    Array.from({ length: count }, (_, index) => putSkill(`rel-bulk-${index}`, "Guidance."));

  it("is the release's own for a release holder and the ordinary one for everyone else", async () => {
    const t = await setup();
    const overOrdinary = skills(ASSET_SYNC_MAX_ITEMS + 1);

    const asAdmin = await syncAs(t, t.admin.id, overOrdinary);
    expect(asAdmin.statusCode).toBe(422);
    expect(errorSchema.parse(asAdmin.json()).error.message).toBe(
      `A batch holds at most ${ASSET_SYNC_MAX_ITEMS} items`
    );
    expect(await t.stored("skill", "bulk-0")).toBeUndefined();

    const before = await t.version();
    const pushed = await syncAsService(t, overOrdinary);
    expect(pushed.statusCode, pushed.body).toBe(200);
    expect(await t.version()).toBe(before + 1);
    expect(await t.stored("skill", `rel-bulk-${ASSET_SYNC_MAX_ITEMS}`)).toMatchObject({
      revision: 1
    });

    const overRelease = await syncAsService(t, skills(ASSET_RELEASE_SYNC_MAX_ITEMS + 1));
    expect(overRelease.statusCode).toBe(422);
  });
});
