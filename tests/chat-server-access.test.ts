import { publishAgentDraft } from "./support/agent-draft-publication";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  agent,
  clientInstanceId,
  setupAccessInstance as setup,
  skill
} from "./support/access-instance";

// Grants at the HTTP boundary. Every refusal the rights model names is proven
// here beside the neighbouring call that is allowed. Who may write a grant, the tenant
// boundary, audit and tool calls are in `chat-server-access-administration.test.ts`.

describe("narrow grants on agents and skills", () => {
  it("lets a holder of agent.write on one agent write it and nothing else", async () => {
    const t = await setup();
    expect((await t.putAgent(t.admin.id, "kai-helper")).statusCode).toBe(200);
    // Before the grant the same call is refused: the grant is what allows it.
    await t.expectRefused(
      t.kai.id,
      "assets.put",
      { params: { kind: "agent", name: "kai-helper" }, payload: { config: agent("kai-helper") } },
      t.forbidden("agent.write", "no_grant")
    );
    await t.grant(t.kai.id, "agent.write", { assetId: await t.assetId("agent", "kai-helper") });

    expect(
      (await t.putAgent(t.kai.id, "kai-helper", { instructions: "Help more." })).statusCode
    ).toBe(200);

    // Another agent: a new name, and an agent that exists. A name that starts the same way is
    // no other agent's right.
    for (const name of ["other-helper", "assistant", "kai-helper-two", "kai-"]) {
      await t.expectRefused(
        t.kai.id,
        "assets.put",
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
    const workspaceId = await t.sharedWorkspace("Kai");
    const inWorkspace = { workspaceId };
    await t.grant(t.kai.id, "agent.write", { workspaceId });
    await t.expectOk(t.kai.id, "assets.put", {
      params: { kind: "agent", name: "kai-helper" },
      payload: { config: agent("kai-helper"), expectedRevision: null, workspaceId }
    });

    await t.expectRefused(
      t.kai.id,
      "assets.get",
      { params: { kind: "agent", name: "kai-helper" }, query: inWorkspace },
      t.forbidden("agent.read", "no_grant")
    );
    await t.expectRefused(
      t.kai.id,
      "assets.revisions.list",
      { params: { kind: "agent", name: "kai-helper" }, query: inWorkspace },
      t.forbidden("agent.read", "no_grant")
    );
    await t.expectRefused(
      t.kai.id,
      "assets.delete",
      { params: { kind: "agent", name: "kai-helper" }, payload: inWorkspace },
      t.forbidden("agent.delete", "no_grant")
    );
    await t.expectRefused(
      t.kai.id,
      "assets.put",
      {
        params: { kind: "skill", name: "kai-notes" },
        payload: { config: skill("kai-notes"), expectedRevision: null, workspaceId }
      },
      t.forbidden("skill.write", "no_grant")
    );

    await t.grant(t.kai.id, "agent.read", { workspaceId });
    await t.grant(t.kai.id, "agent.delete", { workspaceId });
    await t.grant(t.kai.id, "skill.write", { workspaceId });
    await t.expectOk(t.kai.id, "assets.get", {
      params: { kind: "agent", name: "kai-helper" },
      query: inWorkspace
    });
    await t.expectOk(t.kai.id, "assets.revisions.list", {
      params: { kind: "agent", name: "kai-helper" },
      query: inWorkspace
    });
    await t.expectOk(t.kai.id, "assets.put", {
      params: { kind: "skill", name: "kai-notes" },
      payload: { config: skill("kai-notes"), expectedRevision: null, workspaceId }
    });
    await t.expectOk(t.kai.id, "assets.delete", {
      params: { kind: "agent", name: "kai-helper" },
      payload: inWorkspace
    });
    // The read grant is no read outside the workspace.
    await t.expectRefused(
      t.kai.id,
      "assets.get",
      { params: { kind: "agent", name: "assistant" } },
      t.forbidden("agent.read", "no_grant")
    );
  });

  it("lets an asset write grant revert that asset and not another", async () => {
    const t = await setup();
    expect((await t.putAgent(t.admin.id, "kai-helper")).statusCode).toBe(200);
    await t.grant(t.kai.id, "agent.write", { assetId: await t.assetId("agent", "kai-helper") });
    expect(
      (await t.putAgent(t.kai.id, "kai-helper", { instructions: "Changed." })).statusCode
    ).toBe(200);
    expect(
      (await t.putAgent(t.admin.id, "assistant", { instructions: "Changed." })).statusCode
    ).toBe(200);

    await publishAgentDraft(t, "kai-helper");
    // A revert restores content its guardrails answer about: it needs the read right too.
    await t.expectRefused(
      t.kai.id,
      "assets.revert",
      { params: { kind: "agent", name: "kai-helper" }, payload: { revision: 1 } },
      t.forbidden("agent.read", "no_grant")
    );
    await t.grant(t.kai.id, "agent.read", { assetId: await t.assetId("agent", "kai-helper") });
    await t.expectOk(t.kai.id, "assets.revert", {
      params: { kind: "agent", name: "kai-helper" },
      payload: { revision: 1 }
    });
    await t.expectRefused(
      t.kai.id,
      "assets.revert",
      { params: { kind: "agent", name: "assistant" }, payload: { revision: 1 } },
      t.forbidden("agent.write", "no_grant")
    );
  });

  it("gives the same refusal for an asset that exists and one that does not", async () => {
    const t = await setup();
    const existing = await t.expectRefused(
      t.kai.id,
      "assets.get",
      { params: { kind: "agent", name: "assistant" } },
      t.forbidden("agent.read", "no_grant")
    );
    const missing = await t.expectRefused(
      t.kai.id,
      "assets.get",
      { params: { kind: "agent", name: "nobody" } },
      t.forbidden("agent.read", "no_grant")
    );
    expect(missing.message).toBe(existing.message);
    // The administrator, who may read, learns that it is missing.
    await t.expectRefused(
      t.admin.id,
      "assets.get",
      { params: { kind: "agent", name: "nobody" } },
      { status: 404, code: "NOT_FOUND" }
    );
  });

  it("opens no overview and no naming of the default with a batch", async () => {
    const t = await setup();
    const workspaceId = await t.sharedWorkspace("Kai");
    for (const action of ["agent.read", "agent.write", "agent.delete", "skill.read"]) {
      await t.grant(t.kai.id, action, { workspaceId });
    }

    await t.expectRefused(
      t.kai.id,
      "config_assets.get_overview",
      {},
      t.forbidden("agent.read", "no_grant")
    );
    // Naming the default agent with a batch is the release holder's. The default-agent and
    // the availability call are held in tests/asset-placement.test.ts.
    await t.expectRefused(
      t.kai.id,
      "assets.sync",
      { payload: { workspaceId, items: [], defaultAgentName: "assistant" } },
      t.forbidden("assets.release", "no_grant")
    );
    await t.expectOk(t.admin.id, "config_assets.get_overview");
  });

  it("keeps the legacy keys of me.get unchanged by narrow grants", async () => {
    const t = await setup();
    const workspaceId = await t.sharedWorkspace("Kai");
    for (const action of [
      "agent.read",
      "agent.write",
      "agent.delete",
      "skill.read",
      "skill.write",
      "skill.delete"
    ]) {
      await t.grant(t.kai.id, action, { workspaceId });
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

  it("does not let a holder of rights on one agent drop the default agent", async () => {
    const t = await setup();
    // With no agent left, the next one written becomes the default.
    await t.expectOk(t.admin.id, "assets.delete", {
      params: { kind: "agent", name: "assistant" },
      payload: {}
    });
    expect((await t.putAgent(t.admin.id, "kai-helper")).statusCode).toBe(200);
    const helper = await t.assetId("agent", "kai-helper");
    await t.grant(t.kai.id, "agent.write", { assetId: helper });
    await t.grant(t.kai.id, "agent.delete", { assetId: helper });
    // The last agent takes the default with it.
    await t.expectRefused(
      t.kai.id,
      "assets.delete",
      { params: { kind: "agent", name: "kai-helper" }, payload: {} },
      t.forbidden("agent.write", "no_grant")
    );
    expect((await t.putAgent(t.admin.id, "assistant", {}, "all")).statusCode).toBe(200);
    await t.expectOk(t.admin.id, "assets.set_default", {
      params: { kind: "agent" },
      payload: { name: "assistant" }
    });
    await t.expectOk(t.kai.id, "assets.delete", {
      params: { kind: "agent", name: "kai-helper" },
      payload: {}
    });
  });
});

/** Writes an agent the workspace owns. */
function putInWorkspace(
  t: Awaited<ReturnType<typeof setup>>,
  userId: string,
  name: string,
  workspaceId: string,
  overrides: Record<string, unknown> = {}
) {
  return t.call(userId, "assets.put", {
    params: { kind: "agent", name },
    payload: { config: agent(name, overrides), workspaceId }
  });
}

describe("deny rows and asset grants", () => {
  it("lets a deny on one asset win over the workspace allow", async () => {
    const t = await setup();
    const workspaceId = await t.sharedWorkspace("Kai");
    await t.grant(t.kai.id, "agent.write", { workspaceId });
    expect((await putInWorkspace(t, t.kai.id, "kai-helper", workspaceId)).statusCode).toBe(200);
    expect((await putInWorkspace(t, t.kai.id, "kai-second", workspaceId)).statusCode).toBe(200);

    const denyId = await t.grant(
      t.kai.id,
      "agent.write",
      { assetId: await t.assetId("agent", "kai-helper") },
      "deny"
    );
    await t.expectRefused(
      t.kai.id,
      "assets.put",
      {
        params: { kind: "agent", name: "kai-helper" },
        payload: {
          config: agent("kai-helper", { instructions: "Denied." }),
          workspaceId
        }
      },
      t.forbidden("agent.write", "denied")
    );
    // The neighbouring asset of the same workspace stays writable.
    expect(
      (
        await putInWorkspace(t, t.kai.id, "kai-second", workspaceId, {
          instructions: "Still mine."
        })
      ).statusCode
    ).toBe(200);

    // Revoking the deny restores the allow.
    await t.expectOk(t.admin.id, "permissions.revoke", { params: { grantId: denyId } });
    expect(
      (
        await putInWorkspace(t, t.kai.id, "kai-helper", workspaceId, {
          instructions: "Allowed again."
        })
      ).statusCode
    ).toBe(200);
  });

  it("refuses the delete of an asset whose write is denied, so the deny cannot be shed", async () => {
    const t = await setup();
    const workspaceId = await t.sharedWorkspace("Kai");
    await t.grant(t.kai.id, "agent.write", { workspaceId });
    await t.grant(t.kai.id, "agent.delete", { workspaceId });
    expect((await putInWorkspace(t, t.kai.id, "kai-helper", workspaceId)).statusCode).toBe(200);
    expect((await putInWorkspace(t, t.kai.id, "kai-second", workspaceId)).statusCode).toBe(200);
    const denyId = await t.grant(
      t.kai.id,
      "agent.write",
      { assetId: await t.assetId("agent", "kai-helper") },
      "deny"
    );

    await t.expectRefused(
      t.kai.id,
      "assets.delete",
      { params: { kind: "agent", name: "kai-helper" }, payload: { workspaceId } },
      t.forbidden("agent.write", "denied")
    );
    // The asset and the deny row are both still there.
    await t.assetId("agent", "kai-helper");
    const rows = await t.stores.access.listGrants({ clientInstanceId });
    expect(rows.filter((row) => row.id === denyId)).toHaveLength(1);
    await t.expectRefused(
      t.kai.id,
      "assets.put",
      {
        params: { kind: "agent", name: "kai-helper" },
        payload: { config: agent("kai-helper", { instructions: "Denied." }), workspaceId }
      },
      t.forbidden("agent.write", "denied")
    );
    // The neighbour without a deny is deleted as before.
    await t.expectOk(t.kai.id, "assets.delete", {
      params: { kind: "agent", name: "kai-second" },
      payload: { workspaceId }
    });
  });

  it("lets a workspace deny win over an asset allow, and over an administrator's role", async () => {
    const t = await setup();
    const workspaceId = await t.sharedWorkspace("Kai");
    expect((await putInWorkspace(t, t.admin.id, "kai-helper", workspaceId)).statusCode).toBe(200);
    const helper = await t.assetId("agent", "kai-helper");
    await t.grant(t.kai.id, "agent.write", { assetId: helper });
    expect(
      (await putInWorkspace(t, t.kai.id, "kai-helper", workspaceId, { instructions: "One." }))
        .statusCode
    ).toBe(200);

    await t.grant(t.kai.id, "agent.write", { workspaceId }, "deny");
    await t.expectRefused(
      t.kai.id,
      "assets.put",
      {
        params: { kind: "agent", name: "kai-helper" },
        payload: { config: agent("kai-helper", { instructions: "Two." }), workspaceId }
      },
      t.forbidden("agent.write", "denied")
    );

    await t.grant(t.lena.id, "agent.write", { workspaceId }, "deny");
    await t.stores.users.updateUser({
      clientInstanceId,
      userId: t.lena.id,
      roles: ["user", "admin"]
    });
    await t.expectRefused(
      t.lena.id,
      "assets.put",
      {
        params: { kind: "agent", name: "kai-helper" },
        payload: { config: agent("kai-helper", { instructions: "Three." }), workspaceId }
      },
      t.forbidden("agent.write", "denied")
    );
    // The role still answers outside the denied workspace.
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
      "assets.put",
      { params: { kind: "agent", name: "shared-two" }, payload: { config: agent("shared-two") } },
      t.forbidden("agent.write", "no_grant")
    );
    // Lena holds nothing on the asset Kai was granted.
    await t.expectRefused(
      t.lena.id,
      "assets.put",
      { params: { kind: "agent", name: "shared-one" }, payload: { config: agent("shared-one") } },
      t.forbidden("agent.write", "no_grant")
    );
  });

  it("removes the asset's allow rows when the asset is deleted, so a new asset of the name inherits no right", async () => {
    const t = await setup();
    expect((await t.putAgent(t.admin.id, "shared-one")).statusCode).toBe(200);
    const first = await t.assetId("agent", "shared-one");
    await t.grant(t.kai.id, "agent.write", { assetId: first });
    await t.grant(t.lena.id, "agent.write", { assetId: first }, "deny");

    await t.expectOk(t.admin.id, "assets.delete", {
      params: { kind: "agent", name: "shared-one" },
      payload: {}
    });
    // The deny stays with the name; see `chat-server-access-boundaries.test.ts`.
    const left = await t.stores.access.listGrants({ clientInstanceId });
    expect(left.map((row) => [row.holderId, row.effect])).toEqual([[t.lena.id, "deny"]]);

    expect((await t.putAgent(t.admin.id, "shared-one")).statusCode).toBe(200);
    await t.expectRefused(
      t.kai.id,
      "assets.put",
      { params: { kind: "agent", name: "shared-one" }, payload: { config: agent("shared-one") } },
      t.forbidden("agent.write", "no_grant")
    );
  });

  it("stops answering a revoked grant on the next call", async () => {
    const t = await setup();
    expect((await t.putAgent(t.admin.id, "kai-helper")).statusCode).toBe(200);
    const grantId = await t.grant(t.kai.id, "agent.write", {
      assetId: await t.assetId("agent", "kai-helper")
    });
    expect((await t.putAgent(t.kai.id, "kai-helper", { instructions: "Before." })).statusCode).toBe(
      200
    );

    await t.expectOk(t.admin.id, "permissions.revoke", { params: { grantId } });
    await t.expectRefused(
      t.kai.id,
      "assets.put",
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
    expect((await t.putAgent(t.admin.id, "kai-helper")).statusCode).toBe(200);
    await t.grant(t.kai.id, "agent.write", { assetId: await t.assetId("agent", "kai-helper") });
    expect((await t.putAgent(t.kai.id, "kai-helper", { instructions: "Mine." })).statusCode).toBe(
      200
    );

    await t.stores.users.updateUser({ clientInstanceId, userId: t.kai.id, status: "disabled" });
    await t.expectRefused(
      t.kai.id,
      "assets.put",
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
    await t.expectOk(t.admin.id, "permissions.list");
    await t.stores.users.updateUser({ clientInstanceId, userId: t.admin.id, status: "disabled" });
    await t.expectRefused(
      t.admin.id,
      "permissions.list",
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

// The build limits themselves, who sets them and the refusal of every writer, are in
// `workspace-bundles.test.ts`. These are the cases beside them.
describe("the build limits of a workspace", () => {
  const limit = (
    t: Awaited<ReturnType<typeof setup>>,
    workspaceId: string,
    lists: Record<string, unknown>
  ) =>
    t.expectOk(t.admin.id, "workspaces.limits.update", {
      params: { collaborationWorkspaceId: workspaceId },
      payload: lists
    });

  it("answers a synced agent that fails the selectable models and the list with the list's refusal", async () => {
    const t = await setup();
    const workspaceId = await t.sharedWorkspace("Kai");
    await limit(t, workspaceId, { allowedToolNames: ["known.tool"] });
    const config = agent("kai-both", {
      toolNames: ["second.tool"],
      userSelectableModelBindingIds: ["unbound.model"]
    });

    // Neither refusal hides the other's: the one of the workspace is the answer of the call.
    await t.expectRefused(
      t.root.id,
      "assets.sync",
      {
        payload: {
          workspaceId,
          items: [{ type: "put", kind: "agent", config, expectedRevision: null }]
        }
      },
      {
        status: 403,
        code: "FORBIDDEN",
        details: {
          reason: "tool_not_allowed",
          toolName: "second.tool",
          workspaceId,
          workspace: "Kai"
        }
      }
    );
  });

  it("checks only an agent a write creates or changes", async () => {
    const t = await setup();
    const workspaceId = await t.sharedWorkspace("Kai");
    expect(
      (
        await putInWorkspace(t, t.admin.id, "kai-old", workspaceId, {
          toolNames: ["second.tool"]
        })
      ).statusCode
    ).toBe(200);
    await limit(t, workspaceId, { allowedToolNames: [] });
    // The agent that was there before the list keeps its tool while another agent is written.
    expect((await putInWorkspace(t, t.admin.id, "kai-new", workspaceId)).statusCode).toBe(200);
    await t.expectRefused(
      t.admin.id,
      "assets.put",
      {
        params: { kind: "agent", name: "kai-old" },
        payload: {
          config: agent("kai-old", { toolNames: ["second.tool"], instructions: "Changed." }),
          workspaceId
        }
      },
      {
        status: 403,
        code: "FORBIDDEN",
        details: {
          reason: "tool_not_allowed",
          toolName: "second.tool",
          workspaceId,
          workspace: "Kai"
        }
      }
    );
  });

  it("lets a writer pick a listed model and never grants the rest of the model right", async () => {
    const t = await setup();
    const workspaceId = await t.sharedWorkspace("Kai");
    await limit(t, workspaceId, { allowedModelBindingIds: ["plain"] });
    await t.grant(t.kai.id, "agent.write", { workspaceId });
    const bound = (modelBindingId: string) => {
      const { modelProviderId: _modelProviderId, ...rest } = agent("kai-helper");
      return { ...rest, modelBindingId };
    };

    await t.expectOk(t.kai.id, "assets.put", {
      params: { kind: "agent", name: "kai-helper" },
      payload: { config: bound("plain"), workspaceId }
    });
    // A list only restricts: changing another model field still needs agent_models.manage.
    const refusal = await t.expectRefused(
      t.kai.id,
      "assets.put",
      {
        params: { kind: "agent", name: "kai-helper" },
        payload: { config: { ...bound("plain"), reasoningEffort: "low" }, workspaceId }
      },
      { status: 403, code: "FORBIDDEN" }
    );
    expect(refusal.message).toContain("agent_models.manage");
  });

  it("refuses a list entry the instance does not have", async () => {
    const t = await setup();
    const workspaceId = await t.sharedWorkspace("Kai");
    const params = { collaborationWorkspaceId: workspaceId };
    await t.expectRefused(
      t.admin.id,
      "workspaces.limits.update",
      { params, payload: { allowedToolNames: ["missing.tool"] } },
      {
        status: 422,
        code: "VALIDATION_FAILED",
        details: { reason: "unknown_tool", toolName: "missing.tool" }
      }
    );
    await t.expectRefused(
      t.admin.id,
      "workspaces.limits.update",
      { params, payload: { allowedModelBindingIds: ["missing"] } },
      {
        status: 422,
        code: "VALIDATION_FAILED",
        details: { reason: "unknown_model_binding", modelBindingId: "missing" }
      }
    );
  });
});
