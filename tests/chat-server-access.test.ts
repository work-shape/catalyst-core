import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  agent,
  clientInstanceId,
  setupAccessInstance as setup,
  skill
} from "./support/access-instance";

// Grants and Namespaces at the HTTP boundary. Every refusal the rights model names is proven
// here beside the neighbouring call that is allowed. Who may write a grant, the tenant
// boundary, audit and tool calls are in `chat-server-access-administration.test.ts`.

describe("Namespace grants on agents and skills", () => {
  it("lets a holder of agent.write in a Namespace write there and nowhere else", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    // Before the grant the same call is refused: the grant is what allows it.
    await t.expectRefused(
      t.kai.id,
      "config_assets.put",
      { params: { kind: "agent", name: "kai-helper" }, payload: { config: agent("kai-helper") } },
      t.forbidden("agent.write", "no_grant")
    );
    await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });

    expect((await t.putAgent(t.kai.id, "kai-helper")).statusCode).toBe(200);
    expect(
      (await t.putAgent(t.kai.id, "kai-helper", { instructions: "Help more." })).statusCode
    ).toBe(200);

    // Wrong Namespace: a new name, and an agent that exists.
    for (const name of ["other-helper", "assistant", "kai", "kaiser-helper", "team-kai-helper"]) {
      await t.expectRefused(
        t.kai.id,
        "config_assets.put",
        { params: { kind: "agent", name }, payload: { config: agent(name) } },
        t.forbidden("agent.write", "no_grant")
      );
    }
    expect(
      await t.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "agent",
        name: "other-helper"
      })
    ).toBeUndefined();
  });

  it("applies a grant to its action and kind only", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });
    expect((await t.putAgent(t.kai.id, "kai-helper")).statusCode).toBe(200);

    await t.expectRefused(
      t.kai.id,
      "config_assets.get",
      { params: { kind: "agent", name: "kai-helper" } },
      t.forbidden("agent.read", "no_grant")
    );
    await t.expectRefused(
      t.kai.id,
      "config_assets.revisions.list",
      { params: { kind: "agent", name: "kai-helper" } },
      t.forbidden("agent.read", "no_grant")
    );
    await t.expectRefused(
      t.kai.id,
      "config_assets.delete",
      { params: { kind: "agent", name: "kai-helper" }, payload: {} },
      t.forbidden("agent.delete", "no_grant")
    );
    await t.expectRefused(
      t.kai.id,
      "config_assets.put",
      { params: { kind: "skill", name: "kai-notes" }, payload: { config: skill("kai-notes") } },
      t.forbidden("skill.write", "no_grant")
    );

    await t.grant(t.kai.id, "agent.read", { namespace: "kai-" });
    await t.grant(t.kai.id, "agent.delete", { namespace: "kai-" });
    await t.grant(t.kai.id, "skill.write", { namespace: "kai-" });
    await t.expectOk(t.kai.id, "config_assets.get", {
      params: { kind: "agent", name: "kai-helper" }
    });
    await t.expectOk(t.kai.id, "config_assets.revisions.list", {
      params: { kind: "agent", name: "kai-helper" }
    });
    await t.expectOk(t.kai.id, "config_assets.put", {
      params: { kind: "skill", name: "kai-notes" },
      payload: { config: skill("kai-notes") }
    });
    await t.expectOk(t.kai.id, "config_assets.delete", {
      params: { kind: "agent", name: "kai-helper" },
      payload: {}
    });
    // The read grant is no read outside the Namespace.
    await t.expectRefused(
      t.kai.id,
      "config_assets.get",
      { params: { kind: "agent", name: "assistant" } },
      t.forbidden("agent.read", "no_grant")
    );
  });

  it("lets a Namespace write grant revert inside the Namespace and not outside", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });
    expect((await t.putAgent(t.kai.id, "kai-helper")).statusCode).toBe(200);
    expect(
      (await t.putAgent(t.kai.id, "kai-helper", { instructions: "Changed." })).statusCode
    ).toBe(200);
    expect(
      (await t.putAgent(t.admin.id, "assistant", { instructions: "Changed." })).statusCode
    ).toBe(200);

    await t.expectOk(t.kai.id, "config_assets.revert", {
      params: { kind: "agent", name: "kai-helper" },
      payload: { revision: 1 }
    });
    await t.expectRefused(
      t.kai.id,
      "config_assets.revert",
      { params: { kind: "agent", name: "assistant" }, payload: { revision: 1 } },
      t.forbidden("agent.write", "no_grant")
    );
  });

  it("gives the same refusal for an asset that exists and one that does not", async () => {
    const t = await setup();
    const existing = await t.expectRefused(
      t.kai.id,
      "config_assets.get",
      { params: { kind: "agent", name: "assistant" } },
      t.forbidden("agent.read", "no_grant")
    );
    const missing = await t.expectRefused(
      t.kai.id,
      "config_assets.get",
      { params: { kind: "agent", name: "nobody" } },
      t.forbidden("agent.read", "no_grant")
    );
    expect(missing.message).toBe(existing.message);
    // The administrator, who may read, learns that it is missing.
    await t.expectRefused(
      t.admin.id,
      "config_assets.get",
      { params: { kind: "agent", name: "nobody" } },
      { status: 404, code: "NOT_FOUND" }
    );
  });

  it("opens no overview, export, default-agent or availability call", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    for (const action of ["agent.read", "agent.write", "agent.delete", "skill.read"]) {
      await t.grant(t.kai.id, action, { namespace: "kai-" });
    }
    expect((await t.putAgent(t.kai.id, "kai-helper")).statusCode).toBe(200);

    await t.expectRefused(
      t.kai.id,
      "config_assets.get_overview",
      {},
      t.forbidden("agent.read", "no_grant")
    );
    await t.expectRefused(
      t.kai.id,
      "config_assets.export",
      {},
      t.forbidden("agent.read", "no_grant")
    );
    await t.expectRefused(
      t.kai.id,
      "config_agents.set_default",
      { payload: { agentName: "kai-helper" } },
      t.forbidden("agent.write", "no_grant")
    );
    await t.expectRefused(
      t.kai.id,
      "config_agents.set_availability",
      { params: { name: "kai-helper" }, payload: { mode: "all" } },
      t.forbidden("agent.write", "no_grant")
    );
    await t.expectRefused(
      t.kai.id,
      "config_assets.replace",
      { payload: { agents: [], skills: [], baseVersion: null } },
      t.forbidden("assets.release", "no_grant")
    );
    await t.expectOk(t.admin.id, "config_assets.get_overview");
    await t.expectOk(t.admin.id, "config_agents.set_default", {
      payload: { agentName: "kai-helper" }
    });
  });

  it("keeps the legacy keys of me.get unchanged by a Namespace grant", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    for (const action of [
      "agent.read",
      "agent.write",
      "agent.delete",
      "skill.read",
      "skill.write",
      "skill.delete"
    ]) {
      await t.grant(t.kai.id, action, { namespace: "kai-" });
    }
    const me = z
      .object({ permissions: z.array(z.string()) })
      .parse((await t.expectOk(t.kai.id, "me.get")).json());
    expect(me.permissions).toEqual([]);
    const adminMe = z
      .object({ permissions: z.array(z.string()) })
      .parse((await t.expectOk(t.admin.id, "me.get")).json());
    expect(adminMe.permissions).toEqual([
      "agent_skills.approve",
      "config_assets.read",
      "config_assets.write",
      "usage.view",
      "users.manage",
      "audit.view"
    ]);
  });

  it("does not let a Namespace holder take or drop the default agent", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });
    await t.grant(t.kai.id, "agent.delete", { namespace: "kai-" });
    // With no agent left, the next one written would become the default.
    await t.expectOk(t.admin.id, "config_assets.delete", {
      params: { kind: "agent", name: "assistant" },
      payload: {}
    });
    await t.expectRefused(
      t.kai.id,
      "config_assets.put",
      { params: { kind: "agent", name: "kai-helper" }, payload: { config: agent("kai-helper") } },
      t.forbidden("agent.write", "no_grant")
    );
    expect((await t.putAgent(t.admin.id, "kai-helper")).statusCode).toBe(200);
    // The last agent takes the default with it.
    await t.expectRefused(
      t.kai.id,
      "config_assets.delete",
      { params: { kind: "agent", name: "kai-helper" }, payload: {} },
      t.forbidden("agent.write", "no_grant")
    );
    expect((await t.putAgent(t.admin.id, "assistant")).statusCode).toBe(200);
    await t.expectOk(t.admin.id, "config_agents.set_default", {
      payload: { agentName: "assistant" }
    });
    await t.expectOk(t.kai.id, "config_assets.delete", {
      params: { kind: "agent", name: "kai-helper" },
      payload: {}
    });
  });
});

describe("deny rows and asset grants", () => {
  it("lets a deny on one asset win over the Namespace allow", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });
    expect((await t.putAgent(t.kai.id, "kai-helper")).statusCode).toBe(200);
    expect((await t.putAgent(t.kai.id, "kai-second")).statusCode).toBe(200);

    const denyId = await t.grant(
      t.kai.id,
      "agent.write",
      { assetId: await t.assetId("agent", "kai-helper") },
      "deny"
    );
    await t.expectRefused(
      t.kai.id,
      "config_assets.put",
      {
        params: { kind: "agent", name: "kai-helper" },
        payload: { config: agent("kai-helper", { instructions: "Denied." }) }
      },
      t.forbidden("agent.write", "denied")
    );
    // The neighbouring asset of the same Namespace stays writable.
    expect(
      (await t.putAgent(t.kai.id, "kai-second", { instructions: "Still mine." })).statusCode
    ).toBe(200);

    // Revoking the deny restores the allow.
    await t.expectOk(t.admin.id, "permissions.revoke", { params: { grantId: denyId } });
    expect(
      (await t.putAgent(t.kai.id, "kai-helper", { instructions: "Allowed again." })).statusCode
    ).toBe(200);
  });

  it("lets a Namespace deny win over an asset allow, and over an administrator's role", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    expect((await t.putAgent(t.admin.id, "kai-helper")).statusCode).toBe(200);
    const helper = await t.assetId("agent", "kai-helper");
    await t.grant(t.kai.id, "agent.write", { assetId: helper });
    expect((await t.putAgent(t.kai.id, "kai-helper", { instructions: "One." })).statusCode).toBe(
      200
    );

    await t.grant(t.kai.id, "agent.write", { namespace: "kai-" }, "deny");
    await t.expectRefused(
      t.kai.id,
      "config_assets.put",
      {
        params: { kind: "agent", name: "kai-helper" },
        payload: { config: agent("kai-helper", { instructions: "Two." }) }
      },
      t.forbidden("agent.write", "denied")
    );

    await t.grant(t.lena.id, "agent.write", { namespace: "kai-" }, "deny");
    await t.stores.users.updateUser({
      clientInstanceId,
      userId: t.lena.id,
      roles: ["user", "admin"]
    });
    await t.expectRefused(
      t.lena.id,
      "config_assets.put",
      {
        params: { kind: "agent", name: "kai-helper" },
        payload: { config: agent("kai-helper", { instructions: "Three." }) }
      },
      t.forbidden("agent.write", "denied")
    );
    // The role still answers outside the denied Namespace.
    expect(
      (await t.putAgent(t.lena.id, "assistant", { instructions: "Mine by role." })).statusCode
    ).toBe(200);
  });

  it("lets an asset grant open that asset and no other", async () => {
    const t = await setup();
    expect((await t.putAgent(t.admin.id, "shared-one")).statusCode).toBe(200);
    expect((await t.putAgent(t.admin.id, "shared-two")).statusCode).toBe(200);
    await t.grant(t.kai.id, "agent.write", { assetId: await t.assetId("agent", "shared-one") });

    expect((await t.putAgent(t.kai.id, "shared-one", { instructions: "Mine." })).statusCode).toBe(
      200
    );
    await t.expectRefused(
      t.kai.id,
      "config_assets.put",
      { params: { kind: "agent", name: "shared-two" }, payload: { config: agent("shared-two") } },
      t.forbidden("agent.write", "no_grant")
    );
    // Lena holds nothing on the asset Kai was granted.
    await t.expectRefused(
      t.lena.id,
      "config_assets.put",
      { params: { kind: "agent", name: "shared-one" }, payload: { config: agent("shared-one") } },
      t.forbidden("agent.write", "no_grant")
    );
  });

  it("removes the asset's rows when the asset is deleted, so a new asset of the name inherits nothing", async () => {
    const t = await setup();
    expect((await t.putAgent(t.admin.id, "shared-one")).statusCode).toBe(200);
    const first = await t.assetId("agent", "shared-one");
    await t.grant(t.kai.id, "agent.write", { assetId: first });
    await t.grant(t.lena.id, "agent.write", { assetId: first }, "deny");

    await t.expectOk(t.admin.id, "config_assets.delete", {
      params: { kind: "agent", name: "shared-one" },
      payload: {}
    });
    expect(await t.stores.access.listGrants({ clientInstanceId })).toEqual([]);

    expect((await t.putAgent(t.admin.id, "shared-one")).statusCode).toBe(200);
    await t.expectRefused(
      t.kai.id,
      "config_assets.put",
      { params: { kind: "agent", name: "shared-one" }, payload: { config: agent("shared-one") } },
      t.forbidden("agent.write", "no_grant")
    );
  });

  it("stops answering a revoked grant on the next call", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    const grantId = await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });
    expect((await t.putAgent(t.kai.id, "kai-helper")).statusCode).toBe(200);

    await t.expectOk(t.admin.id, "permissions.revoke", { params: { grantId } });
    await t.expectRefused(
      t.kai.id,
      "config_assets.put",
      {
        params: { kind: "agent", name: "kai-helper" },
        payload: { config: agent("kai-helper", { instructions: "After." }) }
      },
      t.forbidden("agent.write", "no_grant")
    );
    await t.expectRefused(
      t.admin.id,
      "permissions.revoke",
      { params: { grantId } },
      { status: 404, code: "NOT_FOUND" }
    );
  });

  it("holds a deactivated user's rows inert and answers them again on reactivation", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });
    expect((await t.putAgent(t.kai.id, "kai-helper")).statusCode).toBe(200);

    await t.stores.users.updateUser({ clientInstanceId, userId: t.kai.id, status: "disabled" });
    await t.expectRefused(
      t.kai.id,
      "config_assets.put",
      {
        params: { kind: "agent", name: "kai-helper" },
        payload: { config: agent("kai-helper", { instructions: "Disabled." }) }
      },
      t.forbidden("agent.write", "holder_inactive")
    );
    // The rows stay, and the list says the holder is not active.
    const effective = z
      .object({ holderActive: z.boolean(), items: z.array(z.object({ source: z.string() })) })
      .parse(
        (
          await t.expectOk(t.admin.id, "permissions.effective", {
            query: { holderKind: "user", holderId: t.kai.id }
          })
        ).json()
      );
    expect(effective.holderActive).toBe(false);
    expect(effective.items).toEqual([{ source: "grant" }]);

    await t.stores.users.updateUser({ clientInstanceId, userId: t.kai.id, status: "active" });
    expect((await t.putAgent(t.kai.id, "kai-helper", { instructions: "Back." })).statusCode).toBe(
      200
    );
  });

  it("refuses a deactivated administrator every operation that asks a right", async () => {
    const t = await setup();
    await t.expectOk(t.admin.id, "namespaces.list");
    await t.stores.users.updateUser({ clientInstanceId, userId: t.admin.id, status: "disabled" });
    await t.expectRefused(
      t.admin.id,
      "namespaces.list",
      {},
      t.forbidden("users.manage", "holder_inactive")
    );
    await t.expectRefused(
      t.admin.id,
      "config_assets.get_overview",
      {},
      t.forbidden("agent.read", "holder_inactive")
    );
  });
});

describe("Namespace allowlists", () => {
  it("refuses an agent with a tool in a Namespace whose tool list is empty", async () => {
    const t = await setup();
    await t.createNamespace("kai-", { allowedToolNames: [] });
    await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });

    await t.expectRefused(
      t.kai.id,
      "config_assets.put",
      {
        params: { kind: "agent", name: "kai-helper" },
        payload: { config: agent("kai-helper", { toolNames: ["known.tool"] }) }
      },
      {
        status: 403,
        code: "FORBIDDEN",
        details: { reason: "tool_not_allowed", toolName: "known.tool", namespace: "kai-" }
      }
    );
    // Without a tool the same write passes.
    expect((await t.putAgent(t.kai.id, "kai-helper")).statusCode).toBe(200);
  });

  it("binds an instance administrator and the release sync as well", async () => {
    const t = await setup();
    await t.createNamespace("kai-", { allowedToolNames: ["known.tool"] });
    const details = { reason: "tool_not_allowed", toolName: "second.tool", namespace: "kai-" };

    await t.expectRefused(
      t.root.id,
      "config_assets.put",
      {
        params: { kind: "agent", name: "kai-helper" },
        payload: { config: agent("kai-helper", { toolNames: ["known.tool", "second.tool"] }) }
      },
      { status: 403, code: "FORBIDDEN", details }
    );
    expect(
      (await t.putAgent(t.root.id, "kai-helper", { toolNames: ["known.tool"] })).statusCode
    ).toBe(200);
    // Outside the Namespace the list does not apply.
    expect(
      (await t.putAgent(t.root.id, "other-helper", { toolNames: ["second.tool"] })).statusCode
    ).toBe(200);

    await t.stores.users.updateUser({
      clientInstanceId,
      userId: t.root.id,
      permissions: ["config_assets.release"]
    });
    const bundle = (toolNames: string[]) => ({
      baseVersion: null,
      defaultAgentName: "assistant",
      agents: [agent("assistant"), agent("kai-helper", { toolNames })],
      skills: []
    });
    await t.expectRefused(
      t.root.id,
      "config_assets.replace",
      { payload: bundle(["second.tool"]) },
      { status: 403, code: "FORBIDDEN", details }
    );
    await t.expectOk(t.root.id, "config_assets.replace", { payload: bundle(["known.tool"]) });
  });

  it("checks only an agent a write creates or changes", async () => {
    const t = await setup();
    expect(
      (await t.putAgent(t.admin.id, "kai-old", { toolNames: ["second.tool"] })).statusCode
    ).toBe(200);
    await t.createNamespace("kai-", { allowedToolNames: [] });
    // The agent that was there before the list keeps its tool while another agent is written.
    expect((await t.putAgent(t.admin.id, "kai-new")).statusCode).toBe(200);
    await t.expectRefused(
      t.admin.id,
      "config_assets.put",
      {
        params: { kind: "agent", name: "kai-old" },
        payload: {
          config: agent("kai-old", { toolNames: ["second.tool"], instructions: "Changed." })
        }
      },
      {
        status: 403,
        code: "FORBIDDEN",
        details: { reason: "tool_not_allowed", toolName: "second.tool", namespace: "kai-" }
      }
    );
  });

  it("refuses a model binding outside the Namespace's list and never grants the model right", async () => {
    const t = await setup();
    await t.createNamespace("kai-", { allowedModelBindingIds: ["plain"] });
    await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });
    const bound = (modelBindingId: string) => {
      const { modelProviderId: _modelProviderId, ...rest } = agent("kai-helper");
      return { ...rest, modelBindingId };
    };

    await t.expectRefused(
      t.root.id,
      "config_assets.put",
      { params: { kind: "agent", name: "kai-helper" }, payload: { config: bound("other") } },
      {
        status: 403,
        code: "FORBIDDEN",
        details: { reason: "model_not_allowed", modelBindingId: "other", namespace: "kai-" }
      }
    );
    await t.expectOk(t.root.id, "config_assets.put", {
      params: { kind: "agent", name: "kai-helper" },
      payload: { config: bound("plain") }
    });
    // A list only restricts: changing a model field still needs agent_models.manage.
    const refusal = await t.expectRefused(
      t.kai.id,
      "config_assets.put",
      {
        params: { kind: "agent", name: "kai-helper" },
        payload: { config: { ...bound("plain"), reasoningEffort: "low" } }
      },
      { status: 403, code: "FORBIDDEN" }
    );
    expect(refusal.message).toContain("agent_models.manage");
  });

  it("refuses a list entry the instance does not have and lifts a list with null", async () => {
    const t = await setup();
    await t.expectRefused(
      t.admin.id,
      "namespaces.create",
      { payload: { prefix: "kai-", displayName: "Kai", allowedToolNames: ["missing.tool"] } },
      {
        status: 422,
        code: "VALIDATION_FAILED",
        details: { reason: "unknown_tool", toolName: "missing.tool" }
      }
    );
    await t.expectRefused(
      t.admin.id,
      "namespaces.create",
      { payload: { prefix: "kai-", displayName: "Kai", allowedModelBindingIds: ["missing"] } },
      {
        status: 422,
        code: "VALIDATION_FAILED",
        details: { reason: "unknown_model_binding", modelBindingId: "missing" }
      }
    );
    await t.createNamespace("kai-", { allowedToolNames: [] });
    await t.expectRefused(
      t.admin.id,
      "config_assets.put",
      {
        params: { kind: "agent", name: "kai-helper" },
        payload: { config: agent("kai-helper", { toolNames: ["known.tool"] }) }
      },
      { status: 403, code: "FORBIDDEN" }
    );

    const updated = await t.expectOk(t.admin.id, "namespaces.update", {
      params: { prefix: "kai-" },
      payload: { displayName: "Kai's agents", allowedToolNames: null }
    });
    expect(updated.json()).toMatchObject({
      prefix: "kai-",
      displayName: "Kai's agents",
      allowedToolNames: null,
      allowedModelBindingIds: null
    });
    expect(
      (await t.putAgent(t.admin.id, "kai-helper", { toolNames: ["known.tool"] })).statusCode
    ).toBe(200);
  });
});
