import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  agent,
  clientInstanceId,
  setupAccessInstance as setup,
  skill
} from "./support/access-instance";

// Ways around a deny, a workspace's build limits or the hiding of superadmins that a review found, each
// beside the neighbouring call that stays allowed.

const revisionsPage = z.object({ items: z.array(z.object({ revision: z.number() })) });

describe("a deny and the deletion of its asset", () => {
  it("refuses the delete to a holder whose read is denied for the asset", async () => {
    const t = await setup();
    const workspaceId = await t.sharedWorkspace("Kai");
    const inWorkspace = { workspaceId };
    await t.grant(t.kai.id, "skill.read", inWorkspace);
    await t.grant(t.kai.id, "skill.delete", inWorkspace);
    for (const name of ["kai-secret", "kai-open"]) {
      await t.expectOk(t.admin.id, "assets.put", {
        params: { kind: "skill", name },
        payload: { config: skill(name, "Not for Kai."), workspaceId }
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
      "assets.delete",
      { params: { kind: "skill", name: "kai-secret" }, payload: inWorkspace },
      t.forbidden("skill.read", "denied")
    );
    const rows = await t.stores.access.listGrants({ clientInstanceId });
    expect(rows.filter((row) => row.id === denyId)).toHaveLength(1);
    await t.expectRefused(
      t.kai.id,
      "assets.revisions.list",
      { params: { kind: "skill", name: "kai-secret" }, query: inWorkspace },
      t.forbidden("skill.read", "denied")
    );
    // The neighbour without a deny is deleted, and its history stays readable.
    await t.expectOk(t.kai.id, "assets.delete", {
      params: { kind: "skill", name: "kai-open" },
      payload: inWorkspace
    });
    const history = await t.expectOk(t.kai.id, "assets.revisions.list", {
      params: { kind: "skill", name: "kai-open" },
      query: inWorkspace
    });
    expect(revisionsPage.parse(history.json()).items).toHaveLength(2);
  });

  it("keeps the deny on the history and the name after somebody else deletes the asset", async () => {
    const t = await setup();
    const workspaceId = await t.sharedWorkspace("Kai");
    const inWorkspace = { workspaceId };
    for (const holder of [t.kai, t.lena]) {
      await t.grant(holder.id, "skill.read", inWorkspace);
      await t.grant(holder.id, "skill.write", inWorkspace);
    }
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "skill", name: "kai-secret" },
      payload: { config: skill("kai-secret", "Not for Kai."), workspaceId }
    });
    const assetId = await t.assetId("skill", "kai-secret");
    const denyId = await t.grant(t.kai.id, "skill.read", { assetId }, "deny");
    const allowId = await t.grant(t.lena.id, "skill.delete", { assetId });

    await t.expectOk(t.admin.id, "assets.delete", {
      params: { kind: "skill", name: "kai-secret" },
      payload: inWorkspace
    });

    // The allow on the asset is gone with it, the deny is not.
    const rows = await t.stores.access.listGrants({ clientInstanceId });
    expect(rows.some((row) => row.id === allowId)).toBe(false);
    expect(rows.some((row) => row.id === denyId)).toBe(true);
    // Kai could not read the skill before and cannot read its history now, nor bring back a
    // revision of it: a revert restores content, which its guardrails would answer about.
    await t.expectRefused(
      t.kai.id,
      "assets.revisions.list",
      { params: { kind: "skill", name: "kai-secret" }, query: inWorkspace },
      t.forbidden("skill.read", "denied")
    );
    await t.expectRefused(
      t.kai.id,
      "assets.revert",
      { params: { kind: "skill", name: "kai-secret" }, payload: { revision: 1, workspaceId } },
      t.forbidden("skill.read", "denied")
    );
    await t.expectOk(t.admin.id, "assets.revert", {
      params: { kind: "skill", name: "kai-secret" },
      payload: { revision: 1, workspaceId }
    });
    await t.expectRefused(
      t.kai.id,
      "assets.get",
      { params: { kind: "skill", name: "kai-secret" }, query: inWorkspace },
      t.forbidden("skill.read", "denied")
    );
    // Lena, who could read it, still reads the history.
    await t.expectOk(t.lena.id, "assets.revisions.list", {
      params: { kind: "skill", name: "kai-secret" },
      query: inWorkspace
    });
    // Revoking the deny is what opens it.
    await t.expectOk(t.admin.id, "permissions.revoke", { params: { grantId: denyId } });
    await t.expectOk(t.kai.id, "assets.get", {
      params: { kind: "skill", name: "kai-secret" },
      query: inWorkspace
    });
  });
});

/** A workspace with a model list, one without, and Kai's agent.write in both. */
async function twoWorkspaces(t: Awaited<ReturnType<typeof setup>>) {
  const listed = await t.sharedWorkspace("Kai");
  const free = await t.sharedWorkspace("Free");
  await t.expectOk(t.admin.id, "workspaces.limits.update", {
    params: { collaborationWorkspaceId: listed },
    payload: { allowedModelBindingIds: ["plain"] }
  });
  await t.grant(t.kai.id, "agent.write", { workspaceId: listed });
  await t.grant(t.kai.id, "agent.write", { workspaceId: free });
  return { listed, free };
}

describe("a workspace's model list and an agent without a binding", () => {
  it("refuses a provider id and the default model to a writer without the model right", async () => {
    const t = await setup();
    const { listed, free } = await twoWorkspaces(t);
    const required = {
      status: 403,
      code: "FORBIDDEN",
      details: { reason: "model_binding_required", workspaceId: listed, workspace: "Kai" }
    };
    const { modelProviderId: _modelProviderId, ...withoutModel } = agent("kai-helper");
    const put = (config: Record<string, unknown>, workspaceId = listed) => ({
      params: { kind: "agent", name: String(config.name) },
      payload: { config, workspaceId }
    });

    // Kai, and an administrator: neither holds agent_models.manage.
    for (const userId of [t.kai.id, t.admin.id]) {
      await t.expectRefused(userId, "assets.put", put(agent("kai-helper")), required);
      await t.expectRefused(userId, "assets.put", put(withoutModel), required);
    }
    // A workspace without a list does not ask for a binding.
    await t.expectOk(t.kai.id, "assets.put", put(agent("free-helper"), free));

    // The holder of the model right may leave the list that way, and binds an agent to it.
    await t.expectOk(t.root.id, "assets.put", put(agent("kai-provider")));
    await t.expectOk(t.root.id, "assets.put", put({ ...withoutModel, modelBindingId: "plain" }));
    // Kai edits the bound agent and cannot take the binding off it.
    await t.expectOk(
      t.kai.id,
      "assets.put",
      put({ ...withoutModel, modelBindingId: "plain", instructions: "More." })
    );
    await t.expectRefused(
      t.kai.id,
      "assets.put",
      put(agent("kai-helper", { instructions: "More." })),
      required
    );
  });
});

describe("a workspace's model list and its writer", () => {
  it("lets the writer pick a listed binding without the model right, there and nowhere else", async () => {
    const t = await setup();
    const { listed, free } = await twoWorkspaces(t);
    const bound = (name: string, modelBindingId: string, overrides = {}) => {
      const { modelProviderId: _modelProviderId, ...rest } = agent(name, overrides);
      return { ...rest, modelBindingId };
    };
    const put = (name: string, config: Record<string, unknown>, workspaceId?: string) => ({
      params: { kind: "agent", name },
      payload: { config, ...(workspaceId === undefined ? {} : { workspaceId }) }
    });

    await t.expectOk(t.kai.id, "assets.put", put("kai-new", bound("kai-new", "plain"), listed));
    await t.expectRefused(
      t.kai.id,
      "assets.put",
      put("kai-other", bound("kai-other", "other"), listed),
      {
        status: 403,
        code: "FORBIDDEN",
        details: {
          reason: "model_not_allowed",
          modelBindingId: "other",
          workspaceId: listed,
          workspace: "Kai"
        }
      }
    );
    // Editing the agent keeps working, and every other model setting still needs the right.
    await t.expectOk(
      t.kai.id,
      "assets.put",
      put("kai-new", bound("kai-new", "plain", { instructions: "More." }), listed)
    );
    const effort = await t.expectRefused(
      t.kai.id,
      "assets.put",
      put("kai-new", { ...bound("kai-new", "plain"), reasoningEffort: "low" }, listed),
      { status: 403, code: "FORBIDDEN" }
    );
    expect(effort.message).toContain("agent_models.manage");
    // A workspace without a list, and an agent of the instance, keep the rule as it was.
    for (const [userId, name, workspaceId] of [
      [t.kai.id, "free-helper", free],
      [t.admin.id, "plain-helper", undefined]
    ] as const) {
      const refusal = await t.expectRefused(
        userId,
        "assets.put",
        put(name, bound(name, "plain"), workspaceId),
        { status: 403, code: "FORBIDDEN" }
      );
      expect(refusal.message).toContain("agent_models.manage");
    }
  });
});

describe("a deny that outlived its asset", () => {
  it("is still listed, and revoking it lets a new asset of the name start clean", async () => {
    const t = await setup();
    expect((await t.putAgent(t.admin.id, "shared-one")).statusCode).toBe(200);
    const assetId = await t.assetId("agent", "shared-one");
    const denyId = await t.grant(t.kai.id, "agent.read", { assetId }, "deny");
    await t.expectOk(t.admin.id, "assets.delete", {
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
  it("leaves grantedBy out for an administrator and shows it to a superadmin", async () => {
    const t = await setup();
    await t.expectOk(t.root.id, "permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: t.kai.id,
        action: "agent.read",
        effect: "allow",
        scopeKind: "asset",
        scopeId: await t.assetId("agent", "assistant")
      }
    });
    await t.grant(t.kai.id, "agent.write", { workspaceId: await t.sharedWorkspace("Kai") });

    const grants = z.object({
      items: z.array(z.object({ action: z.string(), grantedBy: z.string().optional() }))
    });
    const seenBy = async (userId: string) =>
      Object.fromEntries(
        grants
          .parse((await t.expectOk(userId, "permissions.list")).json())
          .items.map((row) => [row.action, row.grantedBy])
      );

    expect(await seenBy(t.admin.id)).toEqual({
      "agent.read": undefined,
      "agent.write": t.admin.id
    });
    expect(JSON.stringify((await t.expectOk(t.admin.id, "permissions.list")).json())).not.toContain(
      t.root.id
    );
    expect(await seenBy(t.root.id)).toEqual({ "agent.read": t.root.id, "agent.write": t.admin.id });
  });
});
