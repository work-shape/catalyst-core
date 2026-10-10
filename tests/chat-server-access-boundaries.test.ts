import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  agent,
  clientInstanceId,
  setupAccessInstance as setup,
  skill
} from "./support/access-instance";

// Ways around a deny, a Namespace list or the hiding of superadmins that a review found, each
// beside the neighbouring call that stays allowed.

const revisionsPage = z.object({ items: z.array(z.object({ revision: z.number() })) });

describe("a deny and the deletion of its asset", () => {
  it("refuses the delete to a holder whose read is denied for the asset", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    await t.grant(t.kai.id, "skill.read", { namespace: "kai-" });
    await t.grant(t.kai.id, "skill.delete", { namespace: "kai-" });
    for (const name of ["kai-secret", "kai-open"]) {
      await t.expectOk(t.admin.id, "config_assets.put", {
        params: { kind: "skill", name },
        payload: { config: skill(name, "Not for Kai.") }
      });
    }
    const denyId = await t.grant(
      t.kai.id,
      "skill.read",
      { assetId: await t.assetId("skill", "kai-secret") },
      "deny"
    );

    await t.expectRefused(
      t.kai.id,
      "config_assets.delete",
      { params: { kind: "skill", name: "kai-secret" }, payload: {} },
      t.forbidden("skill.read", "denied")
    );
    const rows = await t.stores.access.listGrants({ clientInstanceId });
    expect(rows.filter((row) => row.id === denyId)).toHaveLength(1);
    await t.expectRefused(
      t.kai.id,
      "config_assets.revisions.list",
      { params: { kind: "skill", name: "kai-secret" } },
      t.forbidden("skill.read", "denied")
    );
    // The neighbour without a deny is deleted, and its history stays readable.
    await t.expectOk(t.kai.id, "config_assets.delete", {
      params: { kind: "skill", name: "kai-open" },
      payload: {}
    });
    const history = await t.expectOk(t.kai.id, "config_assets.revisions.list", {
      params: { kind: "skill", name: "kai-open" }
    });
    expect(revisionsPage.parse(history.json()).items).toHaveLength(2);
  });

  it("keeps the deny on the history and the name after somebody else deletes the asset", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    for (const holder of [t.kai, t.lena]) {
      await t.grant(holder.id, "skill.read", { namespace: "kai-" });
      await t.grant(holder.id, "skill.write", { namespace: "kai-" });
    }
    await t.expectOk(t.admin.id, "config_assets.put", {
      params: { kind: "skill", name: "kai-secret" },
      payload: { config: skill("kai-secret", "Not for Kai.") }
    });
    const assetId = await t.assetId("skill", "kai-secret");
    const denyId = await t.grant(t.kai.id, "skill.read", { assetId }, "deny");
    const allowId = await t.grant(t.lena.id, "skill.delete", { assetId });

    await t.expectOk(t.admin.id, "config_assets.delete", {
      params: { kind: "skill", name: "kai-secret" },
      payload: {}
    });

    // The allow on the asset is gone with it, the deny is not.
    const rows = await t.stores.access.listGrants({ clientInstanceId });
    expect(rows.some((row) => row.id === allowId)).toBe(false);
    expect(rows.some((row) => row.id === denyId)).toBe(true);
    // Kai could not read the skill before and cannot read its history now, nor bring it back
    // to read it.
    await t.expectRefused(
      t.kai.id,
      "config_assets.revisions.list",
      { params: { kind: "skill", name: "kai-secret" } },
      t.forbidden("skill.read", "denied")
    );
    await t.expectOk(t.kai.id, "config_assets.revert", {
      params: { kind: "skill", name: "kai-secret" },
      payload: { revision: 1 }
    });
    await t.expectRefused(
      t.kai.id,
      "config_assets.get",
      { params: { kind: "skill", name: "kai-secret" } },
      t.forbidden("skill.read", "denied")
    );
    // Lena, who could read it, still reads the history.
    await t.expectOk(t.lena.id, "config_assets.revisions.list", {
      params: { kind: "skill", name: "kai-secret" }
    });
    // Revoking the deny is what opens it.
    await t.expectOk(t.admin.id, "permissions.revoke", { params: { grantId: denyId } });
    await t.expectOk(t.kai.id, "config_assets.get", {
      params: { kind: "skill", name: "kai-secret" }
    });
  });
});

describe("a Namespace's model list and an agent without a binding", () => {
  it("refuses a provider id and the default model to a writer without the model right", async () => {
    const t = await setup();
    await t.createNamespace("kai-", { allowedModelBindingIds: ["plain"] });
    await t.createNamespace("free-");
    await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });
    await t.grant(t.kai.id, "agent.write", { namespace: "free-" });
    const required = {
      status: 403,
      code: "FORBIDDEN",
      details: { reason: "model_binding_required", namespace: "kai-" }
    };
    const { modelProviderId: _modelProviderId, ...withoutModel } = agent("kai-helper");

    // Kai, and an administrator: neither holds agent_models.manage.
    for (const userId of [t.kai.id, t.admin.id]) {
      await t.expectRefused(
        userId,
        "config_assets.put",
        { params: { kind: "agent", name: "kai-helper" }, payload: { config: agent("kai-helper") } },
        required
      );
      await t.expectRefused(
        userId,
        "config_assets.put",
        { params: { kind: "agent", name: "kai-helper" }, payload: { config: withoutModel } },
        required
      );
    }
    // A Namespace without a list does not ask for a binding.
    expect((await t.putAgent(t.kai.id, "free-helper")).statusCode).toBe(200);

    // The holder of the model right may leave the list that way, and binds an agent to it.
    expect((await t.putAgent(t.root.id, "kai-provider")).statusCode).toBe(200);
    await t.expectOk(t.root.id, "config_assets.put", {
      params: { kind: "agent", name: "kai-helper" },
      payload: { config: { ...withoutModel, modelBindingId: "plain" } }
    });
    // Kai edits the bound agent and cannot take the binding off it.
    await t.expectOk(t.kai.id, "config_assets.put", {
      params: { kind: "agent", name: "kai-helper" },
      payload: { config: { ...withoutModel, modelBindingId: "plain", instructions: "More." } }
    });
    await t.expectRefused(
      t.kai.id,
      "config_assets.put",
      {
        params: { kind: "agent", name: "kai-helper" },
        payload: { config: agent("kai-helper", { instructions: "More." }) }
      },
      required
    );
  });
});

describe("a Namespace's model list and its writer", () => {
  it("lets the writer pick a listed binding without the model right, there and nowhere else", async () => {
    const t = await setup();
    await t.createNamespace("kai-", { allowedModelBindingIds: ["plain"] });
    await t.createNamespace("free-");
    await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });
    await t.grant(t.kai.id, "agent.write", { namespace: "free-" });
    const bound = (name: string, modelBindingId: string, overrides = {}) => {
      const { modelProviderId: _modelProviderId, ...rest } = agent(name, overrides);
      return { ...rest, modelBindingId };
    };
    const put = (name: string, config: Record<string, unknown>) => ({
      params: { kind: "agent", name },
      payload: { config }
    });

    await t.expectOk(t.kai.id, "config_assets.put", put("kai-new", bound("kai-new", "plain")));
    await t.expectRefused(
      t.kai.id,
      "config_assets.put",
      put("kai-other", bound("kai-other", "other")),
      {
        status: 403,
        code: "FORBIDDEN",
        details: { reason: "model_not_allowed", modelBindingId: "other", namespace: "kai-" }
      }
    );
    // Editing the agent keeps working, and every other model setting still needs the right.
    await t.expectOk(
      t.kai.id,
      "config_assets.put",
      put("kai-new", bound("kai-new", "plain", { instructions: "More." }))
    );
    const effort = await t.expectRefused(
      t.kai.id,
      "config_assets.put",
      put("kai-new", { ...bound("kai-new", "plain"), reasoningEffort: "low" }),
      { status: 403, code: "FORBIDDEN" }
    );
    expect(effort.message).toContain("agent_models.manage");
    // A Namespace without a list, and a name in no Namespace, keep the rule as it was.
    for (const [userId, name] of [
      [t.kai.id, "free-helper"],
      [t.admin.id, "plain-helper"]
    ] as const) {
      const refusal = await t.expectRefused(
        userId,
        "config_assets.put",
        put(name, bound(name, "plain")),
        { status: 403, code: "FORBIDDEN" }
      );
      expect(refusal.message).toContain("agent_models.manage");
    }

    // The release sync is bound by the list as before and needs no model right for a binding.
    await t.stores.users.updateUser({
      clientInstanceId,
      userId: t.admin.id,
      permissions: ["config_assets.release"]
    });
    const bundle = (modelBindingId: string) => ({
      baseVersion: null,
      defaultAgentName: "assistant",
      agents: [agent("assistant"), bound("kai-new", modelBindingId)],
      skills: []
    });
    await t.expectRefused(
      t.admin.id,
      "config_assets.replace",
      { payload: bundle("other") },
      {
        status: 403,
        code: "FORBIDDEN",
        details: { reason: "model_not_allowed", modelBindingId: "other", namespace: "kai-" }
      }
    );
    await t.expectOk(t.admin.id, "config_assets.replace", { payload: bundle("plain") });
  });
});

describe("a deny that outlived its asset", () => {
  it("is still listed, and revoking it lets a new asset of the name start clean", async () => {
    const t = await setup();
    expect((await t.putAgent(t.admin.id, "shared-one")).statusCode).toBe(200);
    const assetId = await t.assetId("agent", "shared-one");
    const denyId = await t.grant(t.kai.id, "agent.read", { assetId }, "deny");
    await t.expectOk(t.admin.id, "config_assets.delete", {
      params: { kind: "agent", name: "shared-one" },
      payload: {}
    });

    const page = z.object({
      items: z.array(z.object({ id: z.string(), effect: z.string(), scopeId: z.string() }))
    });
    const listed = page.parse(
      (
        await t.expectOk(t.admin.id, "permissions.list", {
          query: { holderKind: "user", holderId: t.kai.id }
        })
      ).json()
    );
    expect(listed.items).toEqual([{ id: denyId, effect: "deny", scopeId: assetId }]);

    await t.expectOk(t.admin.id, "permissions.revoke", { params: { grantId: denyId } });
    expect((await t.putAgent(t.admin.id, "shared-one")).statusCode).toBe(200);
    expect(await t.stores.access.listGrants({ clientInstanceId })).toEqual([]);
  });
});

describe("attribution to a hidden superadmin", () => {
  it("leaves grantedBy and createdBy out for an administrator and shows them to a superadmin", async () => {
    const t = await setup();
    await t.expectOk(t.root.id, "namespaces.create", {
      payload: { prefix: "root-", displayName: "Root" }
    });
    await t.createNamespace("kai-");
    await t.expectOk(t.root.id, "permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: t.kai.id,
        action: "agent.read",
        effect: "allow",
        scopeKind: "namespace",
        namespace: "root-"
      }
    });
    await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });

    const grants = z.object({
      items: z.array(z.object({ action: z.string(), grantedBy: z.string().optional() }))
    });
    const namespaces = z.object({
      items: z.array(z.object({ prefix: z.string(), createdBy: z.string().optional() }))
    });
    const seenBy = async (userId: string) => ({
      grants: Object.fromEntries(
        grants
          .parse((await t.expectOk(userId, "permissions.list")).json())
          .items.map((row) => [row.action, row.grantedBy])
      ),
      namespaces: Object.fromEntries(
        namespaces
          .parse((await t.expectOk(userId, "namespaces.list")).json())
          .items.map((row) => [row.prefix, row.createdBy])
      )
    });

    expect(await seenBy(t.admin.id)).toEqual({
      grants: { "agent.read": undefined, "agent.write": t.admin.id },
      namespaces: { "root-": undefined, "kai-": t.admin.id }
    });
    expect(JSON.stringify((await t.expectOk(t.admin.id, "permissions.list")).json())).not.toContain(
      t.root.id
    );
    expect(JSON.stringify((await t.expectOk(t.admin.id, "namespaces.list")).json())).not.toContain(
      t.root.id
    );
    expect(await seenBy(t.root.id)).toEqual({
      grants: { "agent.read": t.root.id, "agent.write": t.admin.id },
      namespaces: { "root-": t.root.id, "kai-": t.admin.id }
    });
    // The answer to a write hides it the same way.
    const updated = await t.expectOk(t.admin.id, "namespaces.update", {
      params: { prefix: "root-" },
      payload: { displayName: "Root's" }
    });
    expect(updated.json()).not.toHaveProperty("createdBy");
  });
});
