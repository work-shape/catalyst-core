import { describe, expect, it, vi, afterEach } from "vitest";
import { z } from "zod";
import {
  asAgentRunId,
  asConversationId,
  asToolCallId,
  asUserId,
  createAuthorizer,
  type AuthenticatedUser,
  type UserRole
} from "@work-shape/catalyst-core";
import { ToolRegistry } from "@work-shape/catalyst-tool-execution";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import {
  SERVICE_HEADER,
  agent,
  clientInstanceId,
  errorSchema,
  otherClientInstanceId,
  setupAccessInstance as setup,
  skill
} from "./support/access-instance";
import type { TestCallInput, TestOperationName } from "./support/operations";
import { createTestToolRunner } from "./support/tool-runner";

afterEach(() => vi.useRealTimers());

// Administration of grants at the HTTP boundary: who may write what, the tenant
// and holder boundaries of the store, audit, and the reference check of a tool call. The
// grants themselves are in `chat-server-access.test.ts`.

describe("who may write a grant, and what a grant may say", () => {
  it("refuses a user without users.manage administration of other people", async () => {
    const t = await setup();
    const workspaceId = await t.sharedWorkspace("Kai");
    const grantId = await t.grant(t.lena.id, "agent.read", { workspaceId });
    const calls: Array<[TestOperationName, TestCallInput]> = [
      [
        "permissions.grant",
        {
          payload: {
            holderKind: "user",
            holderId: t.kai.id,
            action: "agent.write",
            scopeKind: "workspace",
            scopeId: workspaceId
          }
        }
      ],
      ["permissions.revoke", { params: { grantId } }],
      ["permissions.list", {}],
      ["permissions.effective", { query: { holderKind: "user", holderId: t.lena.id } }],
      ["workspaces.limits.list", {}]
    ];
    for (const [operation, input] of calls) {
      await t.expectRefused(t.kai.id, operation, input, t.forbidden("users.manage", "no_grant"));
    }
    // Nothing was written, and the administrator may do each of them.
    expect(await t.stores.access.listGrants({ clientInstanceId })).toHaveLength(1);
    await t.expectOk(t.admin.id, "permissions.list");
    await t.expectOk(t.admin.id, "permissions.effective", {
      query: { holderKind: "user", holderId: t.kai.id }
    });
    await t.expectOk(t.admin.id, "workspaces.limits.list");
  });

  it("refuses an administrator whose users.manage was revoked in the legacy column", async () => {
    const t = await setup();
    await t.stores.users.updateUser({
      clientInstanceId,
      userId: t.admin.id,
      permissions: ["!users.manage"]
    });
    await t.expectRefused(
      t.admin.id,
      "permissions.list",
      {},
      t.forbidden("users.manage", "denied")
    );
    await t.expectOk(t.root.id, "permissions.list");
  });

  it("refuses a service principal: the operations are a person's", async () => {
    const t = await setup();
    for (const operation of ["permissions.list", "workspaces.limits.list"] as const) {
      const response = await t.instance.call(operation, {
        headers: { [SERVICE_HEADER]: "sp_test" }
      });
      expect(response.statusCode).toBe(403);
      expect(errorSchema.parse(response.json()).error.message).toBe(
        "Service principals cannot access user-scoped routes"
      );
    }
    // A service principal still reads what its keys open.
    const overview = await t.instance.call("config_assets.get_overview", {
      headers: { [SERVICE_HEADER]: "sp_test" }
    });
    expect(overview.statusCode).toBe(200);
  });

  it("writes a row for a user, six actions, a workspace or an asset, and nothing else", async () => {
    const t = await setup();
    expect((await t.putAgent(t.admin.id, "kai-helper")).statusCode).toBe(200);
    const helper = await t.assetId("agent", "kai-helper");
    const workspaceId = await t.sharedWorkspace("Grant scope");
    const base = {
      holderKind: "user",
      holderId: t.kai.id,
      action: "agent.write",
      scopeKind: "workspace",
      scopeId: workspaceId
    };
    const refusals: Array<[Record<string, unknown>, number, string, string]> = [
      [
        { ...base, holderKind: "role", holderId: "admin" },
        422,
        "VALIDATION_FAILED",
        "invalid_scope"
      ],
      [{ ...base, holderKind: "group" }, 422, "VALIDATION_FAILED", "invalid_scope"],
      [{ ...base, scopeKind: "instance" }, 422, "VALIDATION_FAILED", "invalid_scope"],
      [
        { ...base, scopeKind: "workspace", scopeId: "workspace-1" },
        422,
        "VALIDATION_FAILED",
        "invalid_scope"
      ],
      [{ ...base, scopeId: undefined }, 422, "VALIDATION_FAILED", "invalid_scope"],
      [{ ...base, scopeKind: "asset" }, 422, "VALIDATION_FAILED", "invalid_scope"],
      [
        { ...base, scopeKind: "asset", scopeId: "asset-missing" },
        422,
        "VALIDATION_FAILED",
        "invalid_scope"
      ],
      // A skill action on an agent's id could never match.
      [
        {
          ...base,
          action: "skill.write",
          scopeKind: "asset",
          scopeId: helper
        },
        422,
        "VALIDATION_FAILED",
        "invalid_scope"
      ],
      [{ ...base, action: "users.manage" }, 422, "VALIDATION_FAILED", "action_not_grantable"],
      [{ ...base, action: "assets.release" }, 422, "VALIDATION_FAILED", "action_not_grantable"],
      [{ ...base, action: "skill.approve" }, 422, "VALIDATION_FAILED", "action_not_grantable"],
      [{ ...base, action: "config_assets.write" }, 422, "VALIDATION_FAILED", "unknown_action"],
      [{ ...base, action: "ref:demo-tools" }, 422, "VALIDATION_FAILED", "unknown_action"],
      [{ ...base, action: "unregistered.action" }, 422, "VALIDATION_FAILED", "unknown_action"],
      [{ ...base, holderId: "usr_nobody" }, 404, "NOT_FOUND", "unknown_holder"]
    ];
    for (const [payload, status, code, reason] of refusals) {
      const error = await t.expectRefused(
        t.root.id,
        "permissions.grant",
        { payload },
        { status, code }
      );
      expect(error.details, JSON.stringify(payload)).toMatchObject({ reason });
    }
    // A scope kind outside instance, workspace and asset is no scope kind of the request.
    await t.expectRefused(
      t.root.id,
      "permissions.grant",
      { payload: { ...base, scopeKind: "prefix", scopeId: undefined } },
      { status: 422, code: "VALIDATION_FAILED" }
    );
    expect(await t.stores.access.listGrants({ clientInstanceId })).toEqual([]);

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
    await t.grant(t.kai.id, "agent.write", { assetId: helper });
    await t.expectRefused(
      t.admin.id,
      "permissions.grant",
      { payload: { ...base, effect: "deny" } },
      { status: 409, code: "CONFLICT", details: { reason: "duplicate_grant" } }
    );
    expect(await t.stores.access.listGrants({ clientInstanceId })).toHaveLength(7);
  });

  it("writes no row for a holder of another client instance", async () => {
    const t = await setup();
    const foreigner = await t.stores.users.createUser({
      clientInstanceId: otherClientInstanceId,
      displayLabel: "Foreign",
      roles: ["user"]
    });
    await t.expectRefused(
      t.root.id,
      "permissions.grant",
      {
        payload: {
          holderKind: "user",
          holderId: foreigner.id,
          action: "agent.write",
          scopeKind: "asset",
          scopeId: await t.assetId("agent", "assistant")
        }
      },
      { status: 404, code: "NOT_FOUND", details: { reason: "unknown_holder" } }
    );
    await t.expectRefused(
      t.root.id,
      "permissions.effective",
      { query: { holderKind: "user", holderId: foreigner.id } },
      { status: 404, code: "NOT_FOUND", details: { reason: "unknown_holder" } }
    );
  });

  it("hides the rows a superadmin holds from an administrator's list", async () => {
    const t = await setup();
    const workspaceId = await t.sharedWorkspace("Kai");
    const kaiGrant = await t.grant(t.kai.id, "agent.write", { workspaceId });
    const rootGrant = await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.root.id,
      action: "agent.read",
      effect: "allow",
      scopeKind: "workspace",
      scopeId: workspaceId,
      grantedBy: t.root.id
    });
    const page = z.object({ items: z.array(z.object({ id: z.string() })) });
    const ids = async (userId: string, query: Record<string, string> = {}) =>
      page
        .parse((await t.expectOk(userId, "permissions.list", { query })).json())
        .items.map((row) => row.id)
        .sort();

    expect(await ids(t.admin.id)).toEqual([kaiGrant]);
    expect(await ids(t.admin.id, { holderKind: "user", holderId: t.root.id })).toEqual([]);
    expect(await ids(t.root.id)).toEqual([kaiGrant, rootGrant.id].sort());
  });

  it("lists rows by holder and shows the sources of a holder's rights", async () => {
    const t = await setup();
    const workspaceId = await t.sharedWorkspace("Kai");
    const allowId = await t.grant(t.kai.id, "agent.write", { workspaceId });
    await t.grant(t.lena.id, "skill.read", { workspaceId }, "deny");

    const page = z.object({ items: z.array(z.record(z.string(), z.unknown())) });
    const all = page.parse((await t.expectOk(t.admin.id, "permissions.list")).json());
    expect(all.items).toHaveLength(2);
    const kaiOnly = page.parse(
      (
        await t.expectOk(t.admin.id, "permissions.list", {
          query: { holderKind: "user", holderId: t.kai.id }
        })
      ).json()
    );
    expect(kaiOnly.items).toEqual([
      {
        id: allowId,
        holderKind: "user",
        holderId: t.kai.id,
        action: "agent.write",
        effect: "allow",
        scopeKind: "workspace",
        scopeId: workspaceId,
        grantedBy: t.admin.id,
        createdAt: expect.any(String)
      }
    ]);

    const effective = (
      await t.expectOk(t.admin.id, "permissions.effective", {
        query: { holderKind: "user", holderId: t.kai.id }
      })
    ).json();
    expect(effective).toEqual({
      holderActive: true,
      items: [
        {
          action: "agent.write",
          effect: "allow",
          scopeKind: "workspace",
          scopeId: workspaceId,
          source: "grant"
        }
      ]
    });
    // A service principal's rights are read behind service_principals.manage, which the
    // administrator holds by the role (RIGHTS-1a).
    await t.expectRefused(
      t.kai.id,
      "permissions.effective",
      { query: { holderKind: "service_principal", holderId: "sp_missing" } },
      t.forbidden("service_principals.manage", "no_grant")
    );
    await t.expectRefused(
      t.admin.id,
      "permissions.effective",
      { query: { holderKind: "service_principal", holderId: "sp_missing" } },
      { status: 404, code: "NOT_FOUND", details: { reason: "unknown_holder" } }
    );
  });
});

describe("what a grant row says about the asset it names", () => {
  it("names the asset of an asset row, and says when a deny outlived it", async () => {
    const t = await setup();
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "skill", name: "kai-secret" },
      payload: { config: skill("kai-secret") }
    });
    const assetId = await t.assetId("skill", "kai-secret");
    const granted = await t.expectOk(t.admin.id, "permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: t.kai.id,
        action: "skill.read",
        scopeKind: "asset",
        scopeId: assetId,
        effect: "deny"
      }
    });
    const scopeAsset = z.object({
      id: z.string(),
      scopeAsset: z.object({ kind: z.string(), name: z.string(), active: z.boolean() }).optional()
    });
    expect(scopeAsset.parse(granted.json()).scopeAsset).toEqual({
      kind: "skill",
      name: "kai-secret",
      active: true
    });
    await t.grant(t.kai.id, "skill.write", { workspaceId: await t.sharedWorkspace("Kai") });

    await t.expectOk(t.admin.id, "assets.delete", {
      params: { kind: "skill", name: "kai-secret" },
      payload: {}
    });

    const listed = z
      .object({ items: z.array(scopeAsset) })
      .parse((await t.expectOk(t.admin.id, "permissions.list")).json());
    // The deny is still listed and says which name it refuses; the workspace row names no asset.
    expect(listed.items.map((row) => row.scopeAsset)).toEqual(
      expect.arrayContaining([{ kind: "skill", name: "kai-secret", active: false }, undefined])
    );
    expect(listed.items).toHaveLength(2);
  });
});

describe("tenant and holder boundaries of the access store", () => {
  it("loads no row of another client instance", async () => {
    const t = await setup();
    const workspaceId = await t.sharedWorkspace("Kai");
    await t.grant(t.kai.id, "agent.write", { workspaceId });

    const own = await t.stores.access.loadPersistedAccess({
      clientInstanceId,
      holder: { kind: "user", id: t.kai.id }
    });
    expect(own.grants).toHaveLength(1);

    const foreign = await t.stores.access.loadPersistedAccess({
      clientInstanceId: otherClientInstanceId,
      holder: { kind: "user", id: t.kai.id }
    });
    expect(foreign.grants).toEqual([]);

    const actor = (instanceId: typeof clientInstanceId): AuthenticatedUser => ({
      id: t.kai.id,
      externalUserId: t.kai.id,
      displayLabel: "Kai",
      roles: ["user"],
      permissionRefs: [],
      clientInstanceId: instanceId,
      authSource: "test"
    });
    const authorizer = createAuthorizer(t.stores.access);
    expect(
      (await authorizer.forActor(actor(clientInstanceId))).authorize("agent.write", {
        name: "kai-helper",
        workspaceId
      })
    ).toEqual({ allowed: true, source: "grant" });
    expect(
      (await authorizer.forActor(actor(otherClientInstanceId))).authorize("agent.write", {
        name: "kai-helper",
        workspaceId
      })
    ).toEqual({ allowed: false, reason: "no_grant" });

    // The other instance cannot see, revoke or reuse what this one registered.
    expect(await t.stores.access.listGrants({ clientInstanceId: otherClientInstanceId })).toEqual(
      []
    );
    expect(
      await t.stores.access.deleteGrant({
        clientInstanceId: otherClientInstanceId,
        grantId: own.grants[0]?.id ?? ""
      })
    ).toBeUndefined();
    await expect(
      t.stores.access.createGrant({
        clientInstanceId: otherClientInstanceId,
        holderKind: "user",
        holderId: t.kai.id,
        action: "agent.write",
        effect: "allow",
        scopeKind: "workspace",
        scopeId: workspaceId,
        grantedBy: asUserId(t.admin.id)
      })
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { reason: "invalid_scope" }
    });
    expect(await t.stores.access.listGrants({ clientInstanceId })).toHaveLength(1);
  });

  it("loads only the holder's own rows, by kind and id", async () => {
    const t = await setup();
    await t.grant(t.kai.id, "agent.write", { workspaceId: await t.sharedWorkspace("Kai") });

    const lena = await t.stores.access.loadPersistedAccess({
      clientInstanceId,
      holder: { kind: "user", id: t.lena.id }
    });
    expect(lena.grants).toEqual([]);
    const sameIdAsService = await t.stores.access.loadPersistedAccess({
      clientInstanceId,
      holder: { kind: "service_principal", id: t.kai.id }
    });
    expect(sameIdAsService.grants).toEqual([]);
  });

  it("answers a workspace row for its workspace only", async () => {
    const t = await setup();
    // No operation writes a workspace row for an agent right; the store writes one itself.
    const workspace = { id: await t.sharedWorkspace("Team") };
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.kai.id,
      action: "agent.write",
      effect: "allow",
      scopeKind: "workspace",
      scopeId: workspace.id,
      grantedBy: asUserId(t.admin.id)
    });
    const access = await createAuthorizer(t.stores.access).forActor({
      id: t.kai.id,
      externalUserId: t.kai.id,
      displayLabel: "Kai",
      roles: ["user"],
      permissionRefs: [],
      clientInstanceId,
      authSource: "test"
    });
    expect(access.authorize("agent.write", { workspaceId: workspace.id })).toEqual({
      allowed: true,
      source: "grant"
    });
    expect(access.authorize("agent.write", { workspaceId: "workspace-2" })).toEqual({
      allowed: false,
      reason: "no_grant"
    });
    // It opens no asset call over HTTP: the config asset checks name no workspace.
    await t.expectRefused(
      t.kai.id,
      "assets.put",
      { params: { kind: "agent", name: "kai-helper" }, payload: { config: agent("kai-helper") } },
      t.forbidden("agent.write", "no_grant")
    );
  });
});

describe("deleting a holder", () => {
  it("deletes the user's grant rows with the user and leaves every other holder's", async () => {
    const t = await setup();
    const workspaceId = await t.sharedWorkspace("Kai");
    await t.grant(t.kai.id, "agent.write", { workspaceId });
    await t.grant(t.kai.id, "skill.read", { workspaceId }, "deny");
    const lenaGrant = await t.grant(t.lena.id, "agent.read", { workspaceId });

    await t.expectOk(t.root.id, "users.delete", { params: { userId: t.kai.id } });

    const left = await t.stores.access.listGrants({ clientInstanceId });
    expect(left.map((row) => row.id)).toEqual([lenaGrant]);
    // Nothing answers for the id any more, whoever carries it next.
    const persisted = await t.stores.access.loadPersistedAccess({
      clientInstanceId,
      holder: { kind: "user", id: t.kai.id }
    });
    expect(persisted.grants).toEqual([]);
  });

  it("keeps the rows when the deletion is refused", async () => {
    const t = await setup();
    await t.grant(t.kai.id, "agent.write", { workspaceId: await t.sharedWorkspace("Kai") });
    await t.expectRefused(
      t.lena.id,
      "users.delete",
      { params: { userId: t.kai.id } },
      t.forbidden("users.manage", "no_grant")
    );
    expect(await t.stores.access.listGrants({ clientInstanceId })).toHaveLength(1);
  });
});

describe("audit of grants and build limits", () => {
  it("records each write with holder id, action and scope, and no name or list", async () => {
    const t = await setup();
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
    const workspaceId = await t.sharedWorkspace("Audit scope");
    const grantId = await t.grant(t.kai.id, "agent.write", { workspaceId });
    await t.expectOk(t.admin.id, "workspaces.limits.update", {
      params: { collaborationWorkspaceId: workspaceId },
      payload: { allowedToolNames: ["known.tool"], allowedModelBindingIds: ["plain"] }
    });
    await t.expectOk(t.admin.id, "permissions.revoke", { params: { grantId } });
    // A refused write records no governance event of these types.
    await t.expectRefused(
      t.kai.id,
      "workspaces.limits.update",
      { params: { collaborationWorkspaceId: workspaceId }, payload: { allowedToolNames: null } },
      t.forbidden("users.manage", "no_grant")
    );

    const events = (await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 }))
      .filter(
        (event) =>
          event.type.startsWith("permission.") || event.type === "collaboration_workspace.updated"
      )
      .sort((left, right) => left.type.localeCompare(right.type));
    const grantMetadata = {
      grantId,
      holderKind: "user",
      holderId: t.kai.id,
      action: "agent.write",
      effect: "allow",
      scopeKind: "workspace",
      scopeId: workspaceId
    };
    expect(
      events.map((event) => ({
        type: event.type,
        status: event.status,
        subject: event.subject,
        metadata: event.metadata
      }))
    ).toEqual(
      [
        {
          type: "permission.granted",
          status: "success",
          subject: grantId,
          metadata: grantMetadata
        },
        {
          type: "collaboration_workspace.updated",
          status: "success",
          subject: workspaceId,
          metadata: {
            changedFields: ["allowedToolNames", "allowedModelBindingIds"],
            restrictsTools: true,
            restrictsModels: true
          }
        },
        {
          type: "permission.revoked",
          status: "success",
          subject: grantId,
          metadata: grantMetadata
        }
      ].sort((left, right) => left.type.localeCompare(right.type))
    );
    const written = JSON.stringify(events);
    for (const payload of ["known.tool", "plain", '"Kai"', '"Lena"']) {
      expect(written).not.toContain(payload);
    }
    for (const event of events) {
      expect(event.actor).toMatchObject({ userId: t.admin.id });
    }
  });
});

describe("tool calls and permission references", () => {
  const tool = defineTool({
    name: "demo.echo",
    description: "Echo text for tests.",
    effect: "reading",
    inputSchema: z.object({ text: z.string().min(1) }),
    outputSchema: z.object({ echoed: z.string() }),
    permission: { mode: "allow", requiredPermissionRefs: ["demo-tools"] },
    execute: (input) => Promise.resolve(toolSuccess({ echoed: input.text }))
  });
  const request = {
    toolName: "demo.echo",
    toolCallId: asToolCallId("toolcall_1"),
    agentRunId: asAgentRunId("run_1"),
    conversationId: asConversationId("conv_1"),
    agentName: "assistant",
    input: { text: "hello" }
  };

  it("allows a holder of the reference and refuses everyone else, a superadmin included", async () => {
    const t = await setup();
    const runTool = createTestToolRunner({
      registry: new ToolRegistry({ tools: [tool] }),
      getAgentToolNames: () => ["demo.echo"],
      authorizer: createAuthorizer(t.stores.access)
    });
    const user = (id: string, roles: UserRole[], permissionRefs: string[]): AuthenticatedUser => ({
      id,
      externalUserId: id,
      displayLabel: id,
      roles,
      permissionRefs,
      clientInstanceId,
      authSource: "test"
    });
    const authorize = (actor: AuthenticatedUser) =>
      runTool(request, { clientInstanceId, correlationId: "corr_access_tool", user: actor });

    expect(await authorize(user(t.kai.id, ["user"], ["demo-tools"]))).toMatchObject({
      status: "success",
      output: { echoed: "hello" }
    });
    for (const actor of [
      user(t.lena.id, ["user"], []),
      user(t.lena.id, ["user"], ["other-tools"]),
      user(t.root.id, ["user", "admin", "superadmin"], [])
    ]) {
      expect(await authorize(actor)).toMatchObject({
        status: "failed",
        error: {
          code: "not_allowed",
          message:
            "You do not have the right needed for this action here. Nothing ran. Ask an instance administrator; no contact person is currently listed."
        }
      });
    }

    // A deactivated holder of the reference is refused too.
    await t.stores.users.updateUser({ clientInstanceId, userId: t.kai.id, status: "disabled" });
    expect(await authorize(user(t.kai.id, ["user"], ["demo-tools"]))).toMatchObject({
      status: "failed",
      error: { code: "not_allowed" }
    });
  });
});
