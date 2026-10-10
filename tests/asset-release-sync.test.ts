import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  SCOPES_HEADER,
  SERVICE_HEADER,
  agent,
  clientInstanceId,
  errorSchema,
  setupAccessInstance,
  skill,
  type AccessInstance,
  type AccessInstanceOptions
} from "./support/access-instance";
import { setupNamespaceHolder } from "./support/asset-operations";

// A whole release through `assets.sync`: what a holder of the release right is exempt from in
// that call, and that nobody else and no other operation is. The service principal of these
// tests holds `config_assets.read` and `config_assets.release`, as a key for the CLI does.

const SERVICE = "sp_test";
/** The limits of an instance that is edited by release only, but for the display name. */
const RELEASE_ONLY = {
  editableAgentFields: ["displayName"],
  allowAgentCreation: false,
  allowAgentDeletion: false,
  allowSkillEditing: false
};

const refusalSchema = z.object({
  items: z.array(
    z.object({
      index: z.number(),
      name: z.string().optional(),
      status: z.enum(["refused", "not_applied"]),
      error: z
        .object({ code: z.string(), message: z.string(), action: z.string().optional() })
        .optional()
    })
  )
});

type Item = Record<string, unknown>;
const putAgent = (name: string, overrides: Item = {}, expectedRevision?: number): Item => ({
  type: "put",
  kind: "agent",
  config: agent(name, overrides),
  ...(expectedRevision === undefined ? {} : { expectedRevision })
});
const putSkill = (name: string, content: string, expectedRevision?: number): Item => ({
  type: "put",
  kind: "skill",
  config: skill(name, content),
  ...(expectedRevision === undefined ? {} : { expectedRevision })
});
const deleteAgent = (name: string, expectedRevision = 1): Item => ({
  type: "delete",
  kind: "agent",
  name,
  expectedRevision
});

async function setup(options: AccessInstanceOptions = {}) {
  const t = await setupAccessInstance(options);
  // An administrator who also holds the release right: bound outside a sync like anyone.
  const releaser = await t.stores.users.createUser({
    clientInstanceId,
    displayLabel: "Releaser",
    roles: ["user", "admin"],
    permissions: ["config_assets.release"]
  });
  await t.stores.configAssets.applyConfigAssetMutations({
    clientInstanceId,
    mutations: [
      { type: "upsert", kind: "agent", name: "old", config: agent("old") },
      { type: "upsert", kind: "skill", name: "guide", config: skill("guide") }
    ]
  });
  const stored = (kind: string, name: string) =>
    t.stores.configAssets.getConfigAsset({ clientInstanceId, kind, name });
  const version = async () =>
    (await t.stores.configAssets.getConfigAssetState({ clientInstanceId })).version;
  return { ...t, releaser, stored, version };
}

/** A call of the service principal, with the scopes of its key where the test names them. */
function asService(
  t: AccessInstance,
  operation: Parameters<AccessInstance["call"]>[1],
  input: Parameters<AccessInstance["instance"]["call"]>[1],
  scopes?: string
) {
  return t.instance.call(operation, {
    ...input,
    headers: { [SERVICE_HEADER]: SERVICE, ...(scopes ? { [SCOPES_HEADER]: scopes } : {}) }
  });
}

const syncAsService = (t: AccessInstance, items: Item[], scopes?: string) =>
  asService(t, "assets.sync", { payload: { items } }, scopes);
const syncAs = (t: AccessInstance, userId: string, items: Item[]) =>
  t.call(userId, "assets.sync", { payload: { items } });

function refusedItems(response: { json(): unknown }) {
  const { error } = errorSchema.parse(response.json());
  return {
    code: error.code,
    items: refusalSchema.parse(error.details).items.map((item) => ({
      name: item.name,
      status: item.status,
      ...(item.error ? { code: item.error.code, message: item.error.message } : {}),
      ...(item.error?.action ? { action: item.error.action } : {})
    }))
  };
}

describe("a release through assets.sync", () => {
  it("lands in one version on an instance that is edited by release only, and binds everyone else", async () => {
    const t = await setup({ editingLimits: RELEASE_ONLY });
    // The agent the release replaces is one an operator placed in chosen workspaces.
    await t.stores.configAssets.setAgentAvailability({
      clientInstanceId,
      agentName: "old",
      availability: { mode: "selected", personalWorkspaces: true, collaborationWorkspaceIds: [] }
    });
    const release = [
      putAgent("intake", { instructions: "Take the request in." }),
      putSkill("guide", "The new guidance.", 1),
      deleteAgent("old")
    ];
    const before = await t.version();

    // An administrator holds every kind's write and delete right, and is bound by the limits.
    const asAdmin = await syncAs(t, t.admin.id, release);
    expect(asAdmin.statusCode).toBe(403);
    expect(refusedItems(asAdmin)).toEqual({
      code: "FORBIDDEN",
      items: [
        { name: "intake", status: "not_applied" },
        { name: "guide", status: "not_applied" },
        {
          name: "old",
          status: "refused",
          code: "FORBIDDEN",
          message: "Interactive agent deletion is disabled"
        }
      ]
    });
    const withoutDelete = await syncAs(t, t.admin.id, release.slice(0, 2));
    expect(refusedItems(withoutDelete).items).toEqual([
      {
        name: "intake",
        status: "refused",
        code: "FORBIDDEN",
        message: "Interactive agent creation is disabled"
      },
      {
        name: "guide",
        status: "refused",
        code: "FORBIDDEN",
        message: "Interactive skill editing is disabled"
      }
    ]);
    expect(await t.version()).toBe(before);
    expect(await t.stored("agent", "intake")).toBeUndefined();
    expect(await t.stored("agent", "old")).toMatchObject({ status: "active", revision: 1 });

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
        { name: "intake", status: "applied", revision: 1 },
        { name: "guide", status: "applied", revision: 2 },
        { name: "old", status: "applied", revision: 2 }
      ]
    });
    expect(await t.version()).toBe(before + 1);
    expect(await t.stored("agent", "intake")).toMatchObject({ status: "active", revision: 1 });
    expect(await t.stored("skill", "guide")).toMatchObject({
      revision: 2,
      config: { content: "The new guidance." }
    });
    expect(await t.stored("agent", "old")).toMatchObject({ status: "deleted" });
    // The pushed agent is in no workspace until someone places it.
    const availability = await t.stores.configAssets.listAgentAvailability({ clientInstanceId });
    expect(availability.get("intake")).toEqual({
      mode: "selected",
      personalWorkspaces: false,
      collaborationWorkspaceIds: []
    });
  });

  it("exempts nobody from the editing limits on a single put, delete or revert", async () => {
    const t = await setup({ editingLimits: RELEASE_ONLY });
    const changed = await syncAs(t, t.releaser.id, [
      putAgent("old", { instructions: "Changed by release." }, 1)
    ]);
    expect(changed.statusCode, changed.body).toBe(200);

    // The same holder, on the operations of the interface.
    const limited = (message: string) => ({ status: 403, code: "FORBIDDEN", message });
    const refusals = [
      [
        await t.call(t.releaser.id, "assets.put", {
          params: { kind: "agent", name: "old" },
          payload: { config: agent("old", { instructions: "Changed by hand." }) }
        }),
        limited("Interactive changes are not allowed for agent field: instructions")
      ],
      [
        await t.call(t.releaser.id, "assets.put", {
          params: { kind: "agent", name: "fresh" },
          payload: { config: agent("fresh"), expectedRevision: undefined }
        }),
        limited("Interactive agent creation is disabled")
      ],
      [
        await t.call(t.releaser.id, "assets.delete", { params: { kind: "agent", name: "old" } }),
        limited("Interactive agent deletion is disabled")
      ],
      [
        await t.call(t.releaser.id, "assets.revert", {
          params: { kind: "agent", name: "old" },
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
      params: { kind: "agent", name: "old" },
      payload: { config: agent("old", { displayName: "Renamed" }), expectedRevision: 2 }
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
        params: { kind: "agent", name: "old" },
        payload: { config: agent("old", { displayName: "Renamed" }), expectedRevision: 2 }
      },
      "config_assets:read config_assets:release"
    );
    expect(errorSchema.parse(scoped.json()).error.message).toBe(
      "Missing auth scope 'config_assets:write'"
    );
    expect(await t.stored("agent", "old")).toMatchObject({ status: "active", revision: 2 });
    expect(await t.stored("agent", "fresh")).toBeUndefined();
  });

  it("is pushed while changing assets in the interface is off, by the release holder only", async () => {
    const t = await setup({ editingLimits: { enabled: false } });
    const moduleOff = {
      status: 404,
      code: "NOT_FOUND",
      details: { reason: "module_off", module: "assetManagement" }
    };
    const release = [putSkill("guide", "Pushed.", 1)];

    await t.expectRefused(t.admin.id, "assets.sync", { payload: { items: release } }, moduleOff);
    // A user without any right learns the same and nothing of the items.
    await t.expectRefused(t.lena.id, "assets.sync", { payload: { items: release } }, moduleOff);
    await t.expectRefused(
      t.releaser.id,
      "assets.put",
      { params: { kind: "skill", name: "guide" }, payload: { config: skill("guide", "By hand.") } },
      moduleOff
    );
    expect(await t.stored("skill", "guide")).toMatchObject({ revision: 1 });

    const pushed = await syncAsService(t, release);
    expect(pushed.statusCode, pushed.body).toBe(200);
    expect(await t.stored("skill", "guide")).toMatchObject({
      revision: 2,
      config: { content: "Pushed." }
    });
  });

  it("carries model settings without the right that governs them, in a sync only", async () => {
    const t = await setup();
    const bound = putAgent("old", { modelProviderId: undefined, modelBindingId: "plain" }, 1);

    // An administrator holds `agent.write` and not `agent_models.manage`.
    const asAdmin = await syncAs(t, t.admin.id, [bound]);
    expect(asAdmin.statusCode).toBe(403);
    expect(refusedItems(asAdmin).items).toEqual([
      expect.objectContaining({ name: "old", status: "refused", action: "agent_models.manage" })
    ]);
    const single = await t.call(t.releaser.id, "assets.put", {
      params: { kind: "agent", name: "old" },
      payload: { config: agent("old", { modelProviderId: undefined, modelBindingId: "plain" }) }
    });
    expect(single.statusCode).toBe(403);
    expect(errorSchema.parse(single.json()).error.message).toContain("'agent_models.manage'");
    expect(await t.stored("agent", "old")).toMatchObject({ revision: 1 });

    const pushed = await syncAsService(t, [bound]);
    expect(pushed.statusCode, pushed.body).toBe(200);
    expect(await t.stored("agent", "old")).toMatchObject({
      revision: 2,
      config: { modelBindingId: "plain" }
    });
  });

  it("gives an empty instance its default agent and takes the last one away, in a sync only", async () => {
    const t = await setupNamespaceHolder();
    const defaultAgentName = async () =>
      (await t.stores.configAssets.getConfigAssetState({ clientInstanceId })).defaultAgentName;
    await t.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      mutations: [
        { type: "setDefaultAgent", agentName: undefined },
        { type: "delete", kind: "agent", name: "assistant" }
      ]
    });

    // Kai holds `agent.write` in the Namespace: the default of the instance is not his.
    const asKai = await syncAs(t, t.kai.id, [putAgent("kai-first")]);
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
    expect(await defaultAgentName()).toBeUndefined();

    const first = await syncAsService(t, [putAgent("kai-first")]);
    expect(first.statusCode, first.body).toBe(200);
    expect(await defaultAgentName()).toBe("kai-first");
    // The default is available everywhere, though it arrived by a push.
    const availability = await t.stores.configAssets.listAgentAvailability({ clientInstanceId });
    expect(availability.get("kai-first")?.mode ?? "all").toBe("all");

    const last = await syncAsService(t, [deleteAgent("kai-first")]);
    expect(last.statusCode, last.body).toBe(200);
    expect(await defaultAgentName()).toBeUndefined();
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
    await deny("agent.write", await t.assetId("agent", "old"));
    const before = await t.version();

    const refused = await syncAsService(t, [
      putSkill("guide", "Pushed.", 1),
      putAgent("old", { instructions: "Pushed." }, 1),
      putAgent("intake")
    ]);
    expect(refused.statusCode).toBe(403);
    expect(refusedItems(refused)).toEqual({
      code: "FORBIDDEN",
      items: [
        { name: "guide", status: "not_applied" },
        {
          name: "old",
          status: "refused",
          code: "FORBIDDEN",
          action: "agent.write",
          message: "Missing the right 'agent.write'"
        },
        { name: "intake", status: "not_applied" }
      ]
    });
    // A deny on reading the asset is no way around for a delete either.
    await deny("agent.read", await t.assetId("agent", "assistant"));
    const deleted = await syncAsService(t, [
      putSkill("guide", "Pushed.", 1),
      deleteAgent("assistant")
    ]);
    expect(refusedItems(deleted).items).toEqual([
      { name: "guide", status: "not_applied" },
      expect.objectContaining({ name: "assistant", status: "refused", action: "agent.read" })
    ]);
    expect(await t.version()).toBe(before);
    expect(await t.stored("skill", "guide")).toMatchObject({ revision: 1 });
    expect(await t.stored("agent", "intake")).toBeUndefined();
  });
});

describe("assets.sync without a Namespace", () => {
  it("decides every item by the caller's right on it", async () => {
    const t = await setupNamespaceHolder();
    await t.put(t.admin.id, "agent", "lena-notes");

    const outside = await syncAs(t, t.kai.id, [
      putAgent("kai-intake"),
      putAgent("lena-notes", { displayName: "Taken" }, 1)
    ]);
    expect(outside.statusCode).toBe(403);
    expect(refusedItems(outside)).toEqual({
      code: "FORBIDDEN",
      items: [
        { name: "kai-intake", status: "not_applied" },
        {
          name: "lena-notes",
          status: "refused",
          code: "FORBIDDEN",
          action: "agent.write",
          message: "Missing the right 'agent.write'"
        }
      ]
    });
    expect(await t.stored("agent", "kai-intake")).toBeUndefined();

    // Inside his prefix the same call is his to make, and the administrator's reaches anywhere.
    expect((await syncAs(t, t.kai.id, [putAgent("kai-intake")])).statusCode).toBe(200);
    const anywhere = await syncAs(t, t.admin.id, [
      putAgent("kai-second"),
      putAgent("lena-notes", { displayName: "Renamed" }, 1),
      putSkill("free-standing", "Outside every Namespace.")
    ]);
    expect(anywhere.statusCode, anywhere.body).toBe(200);
    expect(await t.stored("skill", "free-standing")).toMatchObject({ status: "active" });
    // An agent created in the interface starts where it always did.
    const availability = await t.stores.configAssets.listAgentAvailability({ clientInstanceId });
    expect(availability.get("kai-second")?.mode ?? "all").toBe("all");
  });
});
