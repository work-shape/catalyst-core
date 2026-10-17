import { publishAgentDraft } from "./support/agent-draft-publication";
import { describe, expect, it } from "vitest";
import {
  SCOPES_HEADER,
  agent,
  clientInstanceId,
  errorSchema,
  skill
} from "./support/access-instance";
import { setupNamespaceHolder } from "./support/asset-operations";
import {
  RELEASE_ONLY,
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
import { applyAtCurrentRevisions } from "./support/asset-revisions";

// A whole release through `assets.sync`: what a holder of the release right is exempt from in
// that call, and that nobody else and no other operation is. The service principal of these
// tests holds `config_assets.read` and `config_assets.release`, as a key for the CLI does.
// What a release does as the release path did before it is in asset-release-parity.

describe("a release through assets.sync", () => {
  it("drafts a release update and publishes it under release field rules, while the service cannot publish (AD-1 64)", async () => {
    const t = await setup({ editingLimits: RELEASE_ONLY });
    const before = await t.stored("agent", "rel-old");
    const version = await t.version();
    const pushed = await syncAsService(
      t,
      [putAgent("rel-old", { instructions: "Released instructions." }, 1)],
      "config_assets:read config_assets:release"
    );
    expect(pushed.statusCode, pushed.body).toBe(200);
    expect(pushed.json()).toMatchObject({
      version,
      items: [{ draftRevision: 1, publishedRevision: 1 }]
    });
    expect(await t.stored("agent", "rel-old")).toEqual(before);
    const refused = await asService(t, "assets.publish", {
      params: { kind: "agent", name: "rel-old" },
      payload: { revision: 1 }
    });
    expect(refused.statusCode).toBe(403);
    const own = await t.call(t.admin.id, "assets.put", {
      params: { kind: "agent", name: "rel-old" },
      payload: {
        config: agent("rel-old", { instructions: "Own instructions." }),
        expectedRevision: 1,
        expectedDraftRevision: 1
      }
    });
    expect(own.statusCode).toBe(403);
    const published = await t.call(t.admin.id, "assets.publish", {
      params: { kind: "agent", name: "rel-old" },
      payload: { revision: 1 }
    });
    expect(published.statusCode, published.body).toBe(200);
    expect(await t.stored("agent", "rel-old")).toMatchObject({
      revision: 2,
      config: { instructions: "Released instructions." }
    });
  });

  it("refuses a stale draft fence in sync and rolls back its sibling skill write (AD-1 62, 64)", async () => {
    const t = await setup();
    await syncAsService(t, [putAgent("rel-old", { instructions: "First." }, 1)]);
    const before = await t.stored("skill", "rel-guide");
    const refused = await syncAsService(t, [
      { ...putAgent("rel-old", { instructions: "Stale." }, 1), expectedDraftRevision: null },
      putSkill("rel-guide", "Must not land.", 1)
    ]);
    expect(refused.statusCode).toBe(412);
    expect(await t.stored("skill", "rel-guide")).toEqual(before);
  });

  it("lands in one version on an instance that is edited by release only, and binds everyone else", async () => {
    const t = await setup({ editingLimits: RELEASE_ONLY });
    // The agent the release replaces is one an operator placed in chosen workspaces.
    await t.stores.configAssets.setAgentAvailability({
      clientInstanceId,
      agentName: "rel-old",
      availability: { mode: "selected", personalWorkspaces: true, collaborationWorkspaceIds: [] }
    });
    const release = [
      putAgent("rel-intake", { instructions: "Take the request in." }),
      putSkill("rel-guide", "The new guidance.", 1),
      deleteAgent("rel-old")
    ];
    const before = await t.version();

    // An administrator holds every kind's write and delete right, and is bound by the limits.
    const asAdmin = await syncAs(t, t.admin.id, release);
    expect(asAdmin.statusCode).toBe(403);
    expect(refusedItems(asAdmin)).toEqual({
      code: "FORBIDDEN",
      items: [
        { name: "rel-intake", status: "not_applied" },
        { name: "rel-guide", status: "not_applied" },
        {
          name: "rel-old",
          status: "refused",
          code: "FORBIDDEN",
          message: "Interactive agent deletion is disabled"
        }
      ]
    });
    const withoutDelete = await syncAs(t, t.admin.id, release.slice(0, 2));
    expect(refusedItems(withoutDelete).items).toEqual([
      {
        name: "rel-intake",
        status: "refused",
        code: "FORBIDDEN",
        message: "Interactive agent creation is disabled"
      },
      {
        name: "rel-guide",
        status: "refused",
        code: "FORBIDDEN",
        message: "Interactive skill editing is disabled"
      }
    ]);
    expect(await t.version()).toBe(before);
    expect(await t.stored("agent", "rel-intake")).toBeUndefined();
    expect(await t.stored("agent", "rel-old")).toMatchObject({ status: "active", revision: 1 });

    // A key without a scope for writing assets does not reach the operation.
    const readOnly = await syncAsService(t, release, "config_assets:read");
    expect(readOnly.statusCode).toBe(403);
    expect(errorSchema.parse(readOnly.json()).error.message).toBe(
      "Missing auth scope 'config_assets:write'"
    );

    // The key of the CLI carries the two scopes it was issued with.
    const pushed = await syncAsService(t, release, "config_assets:read config_assets:release");
    expect(pushed.statusCode, pushed.body).toBe(200);
    expect(pushed.json()).toMatchObject({
      version: before + 1,
      items: [
        { name: "rel-intake", status: "applied", revision: 1 },
        { name: "rel-guide", status: "applied", revision: 2 },
        { name: "rel-old", status: "applied", revision: 2 }
      ]
    });
    expect(await t.version()).toBe(before + 1);
    expect(await t.stored("agent", "rel-intake")).toMatchObject({ status: "active", revision: 1 });
    expect(await t.stored("skill", "rel-guide")).toMatchObject({
      revision: 2,
      config: { content: "The new guidance." }
    });
    expect(await t.stored("agent", "rel-old")).toMatchObject({ status: "deleted" });
    // The pushed agent is in no workspace until someone places it.
    const availability = await t.stores.configAssets.listAgentAvailability({ clientInstanceId });
    expect(availability.get("rel-intake")).toEqual({
      mode: "selected",
      personalWorkspaces: false,
      collaborationWorkspaceIds: []
    });
  });

  it("exempts nobody from the editing limits on a single put, delete or revert", async () => {
    const t = await setup({ editingLimits: RELEASE_ONLY });
    const changed = await syncAs(t, t.releaser.id, [
      putAgent("rel-old", { instructions: "Changed by release." }, 1)
    ]);
    expect(changed.statusCode, changed.body).toBe(200);
    await publishAgentDraft(t, "rel-old");

    // The same holder, on the operations of the interface.
    const limited = (message: string) => ({ status: 403, code: "FORBIDDEN", message });
    const refusals = [
      [
        await t.call(t.releaser.id, "assets.put", {
          params: { kind: "agent", name: "rel-old" },
          payload: { config: agent("rel-old", { instructions: "Changed by hand." }) }
        }),
        limited("Interactive changes are not allowed for agent field: instructions")
      ],
      [
        await t.call(t.releaser.id, "assets.put", {
          params: { kind: "agent", name: "rel-fresh" },
          payload: { config: agent("rel-fresh"), expectedRevision: null }
        }),
        limited("Interactive agent creation is disabled")
      ],
      [
        await t.call(t.releaser.id, "assets.delete", {
          params: { kind: "agent", name: "rel-old" }
        }),
        limited("Interactive agent deletion is disabled")
      ],
      [
        await t.call(t.releaser.id, "assets.revert", {
          params: { kind: "agent", name: "rel-old" },
          payload: { revision: 1 }
        }),
        limited("Interactive changes are not allowed for agent field: instructions")
      ]
    ] as const;
    for (const [response, expected] of refusals) {
      const { error } = errorSchema.parse(response.json());
      expect({ status: response.statusCode, code: error.code, message: error.message }).toEqual(
        expected
      );
    }
    // The service principal holds no right of the kind, so the single operations refuse it.
    const single = await asService(t, "assets.put", {
      params: { kind: "agent", name: "rel-old" },
      payload: { config: agent("rel-old", { displayName: "Renamed" }), expectedRevision: 2 }
    });
    expect(single.statusCode).toBe(403);
    expect(errorSchema.parse(single.json()).error.details).toEqual({
      action: "agent.write",
      reason: "no_grant"
    });
    // Its key's scope for release sync opens the sync and no other operation that writes.
    const scoped = await asService(
      t,
      "assets.put",
      {
        params: { kind: "agent", name: "rel-old" },
        payload: { config: agent("rel-old", { displayName: "Renamed" }), expectedRevision: 2 }
      },
      "config_assets:read config_assets:release"
    );
    expect(errorSchema.parse(scoped.json()).error.message).toBe(
      "Missing auth scope 'config_assets:write'"
    );
    expect(await t.stored("agent", "rel-old")).toMatchObject({ status: "active", revision: 2 });
    expect(await t.stored("agent", "rel-fresh")).toBeUndefined();
  });

  it("is pushed while changing assets in the interface is off, by the release holder only", async () => {
    const t = await setup({ editingLimits: { enabled: false } });
    const moduleOff = {
      status: 404,
      code: "NOT_FOUND",
      details: { reason: "module_off", module: "assetManagement" }
    };
    const release = [putSkill("rel-guide", "Pushed.", 1)];

    await t.expectRefused(t.admin.id, "assets.sync", { payload: { items: release } }, moduleOff);
    // A user without any right learns the same and nothing of the items.
    await t.expectRefused(t.lena.id, "assets.sync", { payload: { items: release } }, moduleOff);
    await t.expectRefused(
      t.releaser.id,
      "assets.put",
      {
        params: { kind: "skill", name: "rel-guide" },
        payload: { config: skill("rel-guide", "By hand.") }
      },
      moduleOff
    );
    expect(await t.stored("skill", "rel-guide")).toMatchObject({ revision: 1 });

    const pushed = await syncAsService(t, release);
    expect(pushed.statusCode, pushed.body).toBe(200);
    expect(await t.stored("skill", "rel-guide")).toMatchObject({
      revision: 2,
      config: { content: "Pushed." }
    });
    const agentDraft = await syncAsService(t, [
      putAgent("rel-old", { instructions: "Published from a release." }, 1)
    ]);
    expect(agentDraft.statusCode, agentDraft.body).toBe(200);
    await publishAgentDraft(t, "rel-old");
    expect(await t.stored("agent", "rel-old")).toMatchObject({
      revision: 2,
      config: { instructions: "Published from a release." }
    });
    const live = await t.stored("agent", "rel-old");
    if (!live) throw new Error("Released agent missing");
    const interactive = await t.stores.agentProposals.save({
      clientInstanceId,
      agentId: live.id,
      baseRevision: live.revision,
      expectedDraftRevision: null,
      author: { release: false },
      config: agent("rel-old", { instructions: "Interactive draft." }),
      savedAt: new Date().toISOString()
    });
    if (!interactive) throw new Error("Interactive fixture draft missing");
    await t.expectRefused(
      t.admin.id,
      "assets.publish",
      {
        params: { kind: "agent", name: "rel-old" },
        payload: { revision: interactive.revision }
      },
      moduleOff
    );
  });

  it("carries model settings without the right that governs them, in a sync only", async () => {
    const t = await setup();
    const bound = putAgent("rel-old", { modelProviderId: undefined, modelBindingId: "plain" }, 1);

    // An administrator holds `agent.write` and not `agent_models.manage`.
    const asAdmin = await syncAs(t, t.admin.id, [bound]);
    expect(asAdmin.statusCode).toBe(403);
    expect(refusedItems(asAdmin).items).toEqual([
      expect.objectContaining({ name: "rel-old", status: "refused", action: "agent_models.manage" })
    ]);
    const single = await t.call(t.releaser.id, "assets.put", {
      params: { kind: "agent", name: "rel-old" },
      payload: { config: agent("rel-old", { modelProviderId: undefined, modelBindingId: "plain" }) }
    });
    expect(single.statusCode).toBe(403);
    expect(errorSchema.parse(single.json()).error.message).toContain("'agent_models.manage'");
    expect(await t.stored("agent", "rel-old")).toMatchObject({ revision: 1 });

    const pushed = await syncAsService(t, [bound]);
    expect(pushed.statusCode, pushed.body).toBe(200);
    await publishAgentDraft(t, "rel-old");
    expect(await t.stored("agent", "rel-old")).toMatchObject({
      revision: 2,
      config: { modelBindingId: "plain" }
    });
  });

  it("names the default of an empty instance and of one it empties, and nothing is picked for it", async () => {
    const t = await setupNamespaceHolder();
    const defaultAgentName = async () =>
      (await t.stores.configAssets.getConfigAssetState({ clientInstanceId })).defaultAgentName;
    await applyAtCurrentRevisions(t.stores.configAssets, {
      clientInstanceId,
      mutations: [
        { type: "setDefaultAgent", agentName: undefined },
        { type: "delete", kind: "agent", name: "assistant" }
      ]
    });
    const inKai = { namespace: "kai-" };

    // Kai holds `agent.write` in the Namespace: the default of the instance is not his.
    const asKai = await syncAs(t, t.kai.id, [putAgent("kai-first")], inKai);
    expect(asKai.statusCode).toBe(403);
    expect(refusedItems(asKai).items).toEqual([
      {
        name: "kai-first",
        status: "refused",
        code: "FORBIDDEN",
        action: "agent.write",
        message: "Missing the right 'agent.write' on the instance, which changing its default needs"
      }
    ]);
    // The service principal holds no `agent.write` at all, so the single put refuses it.
    const single = await asService(t, "assets.put", {
      params: { kind: "agent", name: "kai-first" },
      payload: { config: agent("kai-first") }
    });
    expect(single.statusCode).toBe(403);

    // A release must say which agent is the default: the first one is not taken for it.
    const unnamed = await syncAsService(t, [putAgent("kai-first")]);
    expect(unnamed.statusCode).toBe(422);
    expect(JSON.stringify(errorSchema.parse(unnamed.json()).error.details)).toContain(
      "defaultAgentName must be set when agents are defined"
    );
    expect(await t.stored("agent", "kai-first")).toBeUndefined();
    expect(await defaultAgentName()).toBeUndefined();

    const first = await releaseAsService(t, {
      items: [putAgent("kai-first")],
      defaultAgentName: "kai-first"
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(await defaultAgentName()).toBe("kai-first");
    // The default is available everywhere, though it arrived by a push.
    const availability = await t.stores.configAssets.listAgentAvailability({ clientInstanceId });
    expect(availability.get("kai-first")).toMatchObject({ mode: "all" });

    // Nor does deleting the last agent take the default away by itself.
    const orphaned = await syncAsService(t, [deleteAgent("kai-first")]);
    expect(orphaned.statusCode).toBe(422);
    expect(await defaultAgentName()).toBe("kai-first");
    const last = await releaseAsService(t, {
      items: [deleteAgent("kai-first")],
      defaultAgentName: null
    });
    expect(last.statusCode, last.body).toBe(200);
    expect(await defaultAgentName()).toBeUndefined();

    // The administrator's batch still makes the first agent the default, as it always did.
    const asAdmin = await syncAs(t, t.admin.id, [putAgent("kai-second")], inKai);
    expect(asAdmin.statusCode, asAdmin.body).toBe(200);
    expect(await defaultAgentName()).toBe("kai-second");
  });

  it("is refused as a whole for a deny on one asset, which names the item", async () => {
    const t = await setup();
    const deny = (action: string, assetId: string) =>
      t.stores.access.createGrant({
        clientInstanceId,
        holderKind: "service_principal",
        holderId: SERVICE,
        action,
        effect: "deny",
        scopeKind: "asset",
        scopeId: assetId,
        grantedBy: t.admin.id
      });
    await deny("agent.write", await t.assetId("agent", "rel-old"));
    const before = await t.version();

    const refused = await syncAsService(t, [
      putSkill("rel-guide", "Pushed.", 1),
      putAgent("rel-old", { instructions: "Pushed." }, 1),
      putAgent("rel-intake")
    ]);
    expect(refused.statusCode).toBe(403);
    expect(refusedItems(refused)).toEqual({
      code: "FORBIDDEN",
      items: [
        { name: "rel-guide", status: "not_applied" },
        {
          name: "rel-old",
          status: "refused",
          code: "FORBIDDEN",
          action: "agent.write",
          message: "Missing the right 'agent.write'"
        },
        { name: "rel-intake", status: "not_applied" }
      ]
    });
    // A deny on reading the asset is no way around for a delete either.
    await deny("agent.read", await t.assetId("agent", "assistant"));
    const deleted = await syncAsService(t, [
      putSkill("rel-guide", "Pushed.", 1),
      deleteAgent("assistant")
    ]);
    expect(refusedItems(deleted).items).toEqual([
      { name: "rel-guide", status: "not_applied" },
      expect.objectContaining({ name: "assistant", status: "refused", action: "agent.read" })
    ]);
    expect(await t.version()).toBe(before);
    expect(await t.stored("skill", "rel-guide")).toMatchObject({ revision: 1 });
    expect(await t.stored("agent", "rel-intake")).toBeUndefined();
  });
});

describe("what a release is checked against", () => {
  it("is the whole stored set: a skill its key may not read is still a skill an agent names", async () => {
    const t = await setup({ furtherToolNames: ["read_skill"] });
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "service_principal",
      holderId: SERVICE,
      action: "skill.read",
      effect: "deny",
      scopeKind: "asset",
      scopeId: await t.assetId("skill", "rel-guide"),
      grantedBy: t.admin.id
    });
    // The key cannot read the skill.
    const read = await asService(t, "assets.get", { params: { kind: "skill", name: "rel-guide" } });
    expect(read.statusCode).toBe(403);

    // The batch does not carry the skill, and its agent names it.
    const naming = (skillName: string) => ({ skillNames: [skillName], toolNames: ["read_skill"] });
    const pushed = await syncAsService(t, [putAgent("rel-intake", naming("rel-guide"))]);
    expect(pushed.statusCode, pushed.body).toBe(200);
    expect(await t.stored("agent", "rel-intake")).toMatchObject({
      config: { skillNames: ["rel-guide"] }
    });
    // A name that is no skill of the instance is refused as before.
    const dangling = await syncAsService(t, [putAgent("rel-lost", naming("rel-none"))]);
    expect(dangling.statusCode).toBe(422);
  });

  it("holds a delete of an absent asset to its absence: one created meanwhile refuses the batch", async () => {
    const t = await setup();
    const store = t.stores.configAssets;
    const apply = store.applyConfigAssetMutations.bind(store);
    let raced = false;
    // Another writer creates the asset after the sync read the set and before it writes.
    store.applyConfigAssetMutations = async (input) => {
      if (!raced) {
        raced = true;
        await apply({
          clientInstanceId,
          baseRevisions: { "agent:rel-ghost": null },
          mutations: [
            { type: "upsert", kind: "agent", name: "rel-ghost", config: agent("rel-ghost") }
          ]
        });
      }
      return apply(input);
    };
    const refused = await syncAsService(t, [
      deleteAgent("rel-ghost"),
      putSkill("rel-guide", "Pushed.", 1)
    ]);
    store.applyConfigAssetMutations = apply;

    expect(refused.statusCode, refused.body).toBe(412);
    expect(refusedItems(refused).items).toEqual([
      expect.objectContaining({ name: "rel-ghost", status: "refused", code: "REVISION_CONFLICT" }),
      { name: "rel-guide", status: "not_applied" }
    ]);
    // The created asset stands, and nothing of the batch was written.
    expect(await t.stored("agent", "rel-ghost")).toMatchObject({ status: "active", revision: 1 });
    expect(await t.stored("skill", "rel-guide")).toMatchObject({ revision: 1 });
  });
});

describe("assets of a kind no release carries", () => {
  it("are left alone by a release, also where their kind is not registered, and stop none", async () => {
    const t = await setup();
    // A row of a module that was switched off: the instance registers no kind for it.
    await applyAtCurrentRevisions(t.stores.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "connection",
          name: "rel-crm",
          config: { name: "rel-crm", title: "CRM" }
        }
      ]
    });
    const release = [
      putSkill("rel-guide", "Pushed.", 1),
      putAgent("rel-intake"),
      deleteAgent("rel-old")
    ];

    const checked = await asService(t, "assets.sync_check", { payload: { items: release } });
    expect(checked.statusCode, checked.body).toBe(200);
    const pushed = await syncAsService(t, release);
    expect(pushed.statusCode, pushed.body).toBe(200);
    expect(await t.stored("agent", "rel-old")).toMatchObject({ status: "deleted" });
    expect(await t.stored("connection", "rel-crm")).toMatchObject({
      status: "active",
      revision: 1
    });
    // The listing of a release kind does not show it, so no working copy takes it for a
    // remote-only asset to prune.
    for (const kind of ["agent", "skill"]) {
      const listed = await asService(t, "assets.list", { params: { kind } });
      expect(listed.body).not.toContain("rel-crm");
    }
    // Nor does the overview a pull reads its version from.
    const overview = await asService(t, "config_assets.get_overview", {});
    expect(overview.statusCode, overview.body).toBe(200);
    expect(overview.body).not.toContain("rel-crm");
    // Naming it in a release is a refusal of that item, by its kind.
    const named = await syncAsService(t, [
      { type: "delete", kind: "connection", name: "rel-crm", expectedRevision: 1 }
    ]);
    expect(named.statusCode).toBeGreaterThanOrEqual(400);
    expect(await t.stored("connection", "rel-crm")).toMatchObject({ status: "active" });
  });
});

describe("assets.sync_check", () => {
  it("answers what the sync would and writes nothing", async () => {
    const t = await setup({ furtherToolNames: ["read_skill"] });
    const before = await t.version();
    const check = (payload: Item, scopes?: string) =>
      asService(t, "assets.sync_check", { payload }, scopes);
    const naming = (skillName: string) => ({ skillNames: [skillName], toolNames: ["read_skill"] });

    // A new agent that names a new skill of the same batch, and the default agent.
    const valid = await check({
      items: [putSkill("rel-new", "New."), putAgent("rel-intake", naming("rel-new"))],
      defaultAgentName: "rel-intake"
    });
    expect(valid.statusCode, valid.body).toBe(200);
    expect(valid.json()).toEqual({ valid: true });
    expect(await t.version()).toBe(before);
    expect(await t.stored("agent", "rel-intake")).toBeUndefined();
    expect(await t.stored("skill", "rel-new")).toBeUndefined();

    // A batch the sync refuses is refused the same way, item by item.
    const stale = [putSkill("rel-guide", "Pushed.", 7), putAgent("rel-intake")];
    const refused = await check({ items: stale });
    expect(refused.statusCode).toBe(412);
    expect(refusedItems(refused)).toEqual(refusedItems(await syncAsService(t, stale)));
    const invalid = await check({ items: [putAgent("rel-lost", naming("rel-none"))] });
    expect(invalid.statusCode).toBe(422);

    // It is opened like the sync: by the release scope of a release holder, or the write scope.
    expect((await check({ items: stale }, "config_assets:read")).statusCode).toBe(403);
    expect(
      (await check({ items: [putAgent("rel-intake")] }, "config_assets:read config_assets:release"))
        .statusCode
    ).toBe(200);
    // Without the release right a batch names its Namespace, as in the sync.
    const asAdmin = await t.call(t.admin.id, "assets.sync_check", {
      payload: { items: [putAgent("rel-intake")] }
    });
    expect(asAdmin.statusCode).toBe(422);
    expect(await t.version()).toBe(before);
  });
});

describe("assets.sync without a Namespace", () => {
  it("is a release: every other caller names the one Namespace of the batch", async () => {
    const t = await setupNamespaceHolder();
    await t.put(t.admin.id, "agent", "lena-notes");
    const unnamed = (userId: string, items: Item[]) =>
      t.call(userId, "assets.sync", { payload: { items } });
    const needsNamespace = {
      code: "VALIDATION_FAILED",
      message: "A batch names the Namespace or the workspace it belongs to"
    };

    // A Namespace holder, an administrator and a superadmin: none of them holds the release right.
    for (const userId of [t.kai.id, t.admin.id, t.root.id]) {
      const refused = await unnamed(userId, [putAgent("kai-intake")]);
      expect(refused.statusCode).toBe(422);
      expect(errorSchema.parse(refused.json()).error).toMatchObject(needsNamespace);
    }
    expect(await t.stored("agent", "kai-intake")).toBeUndefined();
    // With the Namespace named the batch is Kai's to make, and stays inside it.
    expect(
      (await syncAs(t, t.kai.id, [putAgent("kai-intake")], { namespace: "kai-" })).statusCode
    ).toBe(200);

    // A release reaches across Namespaces and outside every one of them.
    const release = await syncAsService(t, [
      putAgent("kai-second"),
      putAgent("lena-notes", { displayName: "Renamed" }, 1),
      putSkill("free-standing", "Outside every Namespace.")
    ]);
    expect(release.statusCode, release.body).toBe(200);
    expect(await t.stored("skill", "free-standing")).toMatchObject({ status: "active" });
    expect(await t.stored("agent", "lena-notes")).toMatchObject({ revision: 1 });
    const pending = (
      await t.expectOk(t.admin.id, "agents.draft.get", { params: { name: "lena-notes" } })
    ).json();
    expect(pending).toMatchObject({ draft: { revision: 1, config: { displayName: "Renamed" } } });
  });

  it("is opened by the key's release scope only for a principal who holds the release right", async () => {
    const t = await setupNamespaceHolder();
    const releaseKey = { [SCOPES_HEADER]: "config_assets:read config_assets:release" };
    const payload = { namespace: "kai-", items: [putAgent("kai-intake")] };

    // Kai may write the item, and his key carries no scope for writing assets.
    const asKai = await t.call(t.kai.id, "assets.sync", { payload, headers: releaseKey });
    expect(asKai.statusCode).toBe(403);
    expect(errorSchema.parse(asKai.json()).error.message).toBe(
      "Missing auth scope 'config_assets:write'"
    );
    // Nor does the superadmin's, who holds every right but the release right.
    const asRoot = await t.call(t.root.id, "assets.sync", { payload, headers: releaseKey });
    expect(asRoot.statusCode).toBe(403);
    expect(await t.stored("agent", "kai-intake")).toBeUndefined();

    // With the scope for writing assets the same call is Kai's to make.
    const scoped = await t.call(t.kai.id, "assets.sync", {
      payload,
      headers: { [SCOPES_HEADER]: "config_assets:read config_assets:write" }
    });
    expect(scoped.statusCode, scoped.body).toBe(200);
    // The service principal holds the release right, so its release key opens the sync.
    const pushed = await syncAsService(
      t,
      [putAgent("kai-pushed")],
      "config_assets:read config_assets:release"
    );
    expect(pushed.statusCode, pushed.body).toBe(200);
  });

  it("is a release only with the release scope on the key and the release right on its principal", async () => {
    const t = await setup({ editingLimits: RELEASE_ONLY });
    const before = await t.version();
    const RELEASE_KEY = "config_assets:read config_assets:release";
    const WRITE_KEY = "config_assets:read config_assets:write";
    const items = [putAgent("rel-intake")];
    const call =
      (operation: "assets.sync" | "assets.sync_check") =>
      (userId: string, scopes: string, payload: Item) =>
        t.call(userId, operation, { payload, headers: { [SCOPES_HEADER]: scopes } });
    const refusal = async (answer: ReturnType<typeof t.call>) => {
      const response = await answer;
      return {
        status: response.statusCode,
        message: errorSchema.parse(response.json()).error.message
      };
    };
    const needsNamespace = {
      status: 422,
      message: "A batch names the Namespace or the workspace it belongs to"
    };
    const missingScope = { status: 403, message: "Missing auth scope 'config_assets:write'" };

    for (const operation of ["assets.sync_check", "assets.sync"] as const) {
      const as = call(operation);
      // The write scope and the release right: an ordinary writer. The batch names its
      // Namespace, names no default agent and is bound by the editing limits.
      expect(await refusal(as(t.releaser.id, WRITE_KEY, { items }))).toEqual(needsNamespace);
      const named = await as(t.releaser.id, WRITE_KEY, { namespace: "rel-", items });
      expect(named.statusCode).toBe(403);
      expect(refusedItems(named).items).toEqual([
        {
          name: "rel-intake",
          status: "refused",
          code: "FORBIDDEN",
          message: "Interactive agent creation is disabled"
        }
      ]);
      const naming = { namespace: "rel-", items: [], defaultAgentName: "rel-old" };
      expect(await refusal(as(t.releaser.id, WRITE_KEY, naming))).toEqual({
        status: 403,
        message: "Missing the right 'assets.release'"
      });

      // The release scope without the release right does not reach the operation.
      expect(await refusal(as(t.admin.id, RELEASE_KEY, { items }))).toEqual(missingScope);
      // Neither of the two: an ordinary writer.
      expect(await refusal(as(t.admin.id, WRITE_KEY, { items }))).toEqual(needsNamespace);
      expect(await t.version()).toBe(before);
    }

    // Both: the release, first checked and then applied.
    const release = { items, defaultAgentName: "rel-intake" };
    const checked = await call("assets.sync_check")(t.releaser.id, RELEASE_KEY, release);
    expect(checked.statusCode, checked.body).toBe(200);
    expect(await t.version()).toBe(before);
    const pushed = await call("assets.sync")(t.releaser.id, RELEASE_KEY, release);
    expect(pushed.statusCode, pushed.body).toBe(200);
    expect(await t.stored("agent", "rel-intake")).toMatchObject({ status: "active" });
    // A key that carries both scopes is a release key too.
    const both = await call("assets.sync")(t.releaser.id, `${WRITE_KEY} config_assets:release`, {
      items: [putSkill("free-standing", "Outside every Namespace.")]
    });
    expect(both.statusCode, both.body).toBe(200);
  });
});
