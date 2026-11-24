import { describe, expect, it, vi, afterEach } from "vitest";
import { z } from "zod";
import { operationRunSchema } from "@work-shape/catalyst-api-contract";
import {
  asAgentRunId,
  asConversationId,
  asToolCallId,
  asUserId,
  createAuthorizer,
  type AuthenticatedUser,
  type CentralPolicySetting,
  type UserRole
} from "@work-shape/catalyst-core";
import { ToolRegistry } from "@work-shape/catalyst-tool-execution";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import {
  SERVICE_HEADER,
  agent,
  clientInstanceId,
  errorSchema,
  grantSchema,
  otherClientInstanceId,
  setupAccessInstance as setup,
  skill,
  type AccessInstance
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
      // On the instance, approving skill changes stays the legacy key's.
      [
        { ...base, action: "skill.approve", scopeKind: "instance", scopeId: undefined },
        422,
        "VALIDATION_FAILED",
        "invalid_scope"
      ],
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
        // Every `user` may add their own MCP server (PMCP).
        {
          action: "connection.add_own",
          effect: "allow",
          scopeKind: "instance",
          roleId: "user",
          source: "role"
        },
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

  it("leaves the asset's name out for a caller who may not read agents and skills, and keeps the scope id and whether the asset exists", async () => {
    const t = await setup();
    const usersOnly = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Users only",
      roles: ["user"],
      permissions: ["users.manage"]
    });
    for (const name of ["kai-secret", "kai-gone"]) {
      await t.expectOk(t.admin.id, "assets.put", {
        params: { kind: "skill", name },
        payload: { config: skill(name) }
      });
    }
    const secretId = await t.assetId("skill", "kai-secret");
    const goneId = await t.assetId("skill", "kai-gone");
    const deny = (scopeId: string) => ({
      payload: {
        holderKind: "user",
        holderId: t.kai.id,
        action: "skill.read",
        scopeKind: "asset",
        scopeId,
        effect: "deny"
      }
    });
    const row = z.object({ scopeId: z.string(), scopeAsset: z.unknown() });

    // Writing a deny asks the right it refuses (RIGHTS-1b), so the administrator writes both.
    await t.expectOk(t.admin.id, "permissions.grant", deny(secretId));
    await t.expectOk(t.admin.id, "permissions.grant", deny(goneId));
    await t.expectOk(t.admin.id, "assets.delete", {
      params: { kind: "skill", name: "kai-gone" },
      payload: {}
    });

    const list = z.object({ items: z.array(row) });
    const listed = list.parse((await t.expectOk(usersOnly.id, "permissions.list")).json());
    expect(listed.items).toEqual(
      expect.arrayContaining([
        { scopeId: secretId, scopeAsset: { kind: "skill", active: true } },
        { scopeId: goneId, scopeAsset: { kind: "skill", active: false } }
      ])
    );
    expect(JSON.stringify(listed)).not.toMatch(/kai-secret|kai-gone/u);
    // A caller who reads skills is still given the names.
    const named = list.parse((await t.expectOk(t.admin.id, "permissions.list")).json());
    expect(JSON.stringify(named)).toMatch(/kai-secret/u);
    expect(JSON.stringify(named)).toMatch(/kai-gone/u);
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
      details: {
        reason: "model_binding_required",
        allowedModelBindingIds: ["plain"],
        workspaceId: listed,
        workspace: "Kai"
      }
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
  it("lets the writer pick a binding the workspace allows without the model right, and nowhere else", async () => {
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
          allowedModelBindingIds: ["plain"],
          workspaceId: listed,
          workspace: "Kai"
        }
      }
    );
    // Editing the agent keeps working, and so does the effort of the binding it picked.
    await t.expectOk(
      t.kai.id,
      "assets.put",
      put("kai-new", bound("kai-new", "plain", { instructions: "More." }), listed)
    );
    await t.expectOk(
      t.kai.id,
      "assets.put",
      put("kai-new", { ...bound("kai-new", "plain"), reasoningEffort: "low" }, listed)
    );
    // The model fallback stays the right's.
    const fallback = await t.expectRefused(
      t.kai.id,
      "assets.put",
      put("kai-new", { ...bound("kai-new", "plain"), useModelFallback: false }, listed),
      { status: 403, code: "FORBIDDEN" }
    );
    expect(fallback.message).toContain("agent_models.manage");
    // A workspace without a list allows every binding of the instance, and its writer picks
    // one, a model listed for users with its effort included.
    await t.expectOk(
      t.kai.id,
      "assets.put",
      put(
        "free-helper",
        {
          ...bound("free-helper", "other"),
          userSelectableModelBindingIds: ["plain"],
          modelReasoningEfforts: { plain: "medium" }
        },
        free
      )
    );
    // An agent of the instance keeps the rule as it was.
    const refusal = await t.expectRefused(
      t.admin.id,
      "assets.put",
      put("plain-helper", bound("plain-helper", "plain")),
      { status: 403, code: "FORBIDDEN" }
    );
    expect(refusal.message).toContain("agent_models.manage");
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

// The three changing operations of grants and build limits as operations of the registry: the run
// each call leaves, the repeated call, the rule for a superadmin's rows asked before the
// policy, and the policy itself. What each call writes and refuses is above.

/** An instance with these admin settings, and how often a call asked for them. */
async function policyInstance(settings: CentralPolicySetting[] = []) {
  const asked = { policy: 0 };
  const t = await setup({
    operations: {
      centralPolicySettings: () => {
        asked.policy += 1;
        return settings;
      }
    }
  });
  return { t, asked };
}

const grantPayload = async (
  t: AccessInstance,
  holderId: string,
  overrides: Record<string, unknown> = {}
) => ({
  holderKind: "user",
  holderId,
  action: "agent.write",
  scopeKind: "asset",
  scopeId: await t.assetId("agent", "assistant"),
  ...overrides
});

const actorOf = (event: { actor?: { userId?: string } }) => event.actor?.userId;

/** One call under its own correlation id, with the run and the audit rows it left. */
async function traced(
  t: AccessInstance,
  userId: string,
  operation: TestOperationName,
  input: TestCallInput,
  correlationId: string
) {
  const before = await t.stores.operationRuns.list({ clientInstanceId });
  const response = await t.call(userId, operation, {
    ...input,
    headers: { ...input.headers, "x-correlation-id": correlationId }
  });
  const runs = (await t.stores.operationRuns.list({ clientInstanceId })).filter(
    (run) => !before.some((earlier) => earlier.id === run.id)
  );
  const audit = (await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 })).filter(
    (event) => event.correlationId === correlationId
  );
  return { response, runs, audit };
}

describe("the Operation Run of a grant or build limits write", () => {
  // Fails without the registration: a plain route leaves no run and sets no header.
  it("leaves one run per call with its actor, and audit rows that name what the call touched", async () => {
    const { t } = await policyInstance();
    const workspaceId = await t.sharedWorkspace("Kai");
    const granted = await traced(
      t,
      t.admin.id,
      "permissions.grant",
      { payload: await grantPayload(t, t.kai.id) },
      "corr_grant"
    );
    const grantId = grantSchema.parse(granted.response.json()).id;
    const limited = await traced(
      t,
      t.admin.id,
      "workspaces.limits.update",
      {
        params: { collaborationWorkspaceId: workspaceId },
        payload: { allowedToolNames: ["known.tool"] }
      },
      "corr_limits_update"
    );
    const revoked = await traced(
      t,
      t.root.id,
      "permissions.revoke",
      { params: { grantId } },
      "corr_revoke"
    );

    const calls = [
      { ...granted, operation: "permissions.grant", actor: t.admin.id, kind: "user", id: t.kai.id },
      {
        ...limited,
        operation: "workspaces.limits.update",
        actor: t.admin.id,
        kind: "collaboration_workspace",
        id: workspaceId
      },
      {
        ...revoked,
        operation: "permissions.revoke",
        actor: t.root.id,
        kind: "permission_grant",
        id: grantId
      }
    ];
    for (const call of calls) {
      expect(call.response.statusCode, call.operation).toBe(200);
      expect(
        call.runs.map((run) => ({
          id: run.id,
          operation: run.operation,
          actor: run.actor.id,
          effect: run.effect,
          status: run.status,
          origin: run.origin.kind
        })),
        call.operation
      ).toEqual([
        {
          id: call.response.headers["operation-run-id"],
          operation: call.operation,
          actor: call.actor,
          effect: "changing",
          status: "done",
          origin: "user"
        }
      ]);
      // The rows of the call path name the resource; the governance row names what was written.
      const ofCallPath = call.audit.filter((event) => event.type.startsWith("operation."));
      expect(ofCallPath.length, call.operation).toBeGreaterThan(0);
      for (const event of ofCallPath) {
        expect(
          { subject: event.subject, kind: event.metadata?.subjectKind, actor: actorOf(event) },
          `${call.operation} ${event.type}`
        ).toEqual({ subject: call.id, kind: call.kind, actor: call.actor });
      }
      expect(
        call.audit.filter((event) => !event.type.startsWith("operation.")).map((e) => e.type),
        call.operation
      ).toHaveLength(1);
    }
  });

  // Fails without the registration: the second call answered 409 `duplicate_grant`.
  it("answers a repeated grant with the same key from the first call and writes one row", async () => {
    const { t } = await policyInstance();
    const input = {
      payload: await grantPayload(t, t.kai.id),
      headers: { "idempotency-key": "grant-kai-once" }
    };
    const first = await t.expectOk(t.admin.id, "permissions.grant", input);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    const second = await t.expectOk(t.admin.id, "permissions.grant", input);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.headers["operation-run-id"]).toBe(first.headers["operation-run-id"]);
    expect(second.json()).toEqual(first.json());
    expect(await t.stores.access.listGrants({ clientInstanceId })).toHaveLength(1);
    expect(await t.stores.operationRuns.list({ clientInstanceId })).toHaveLength(1);

    // The key is the caller's own: another administrator's same key is another call.
    await t.expectRefused(t.root.id, "permissions.grant", input, {
      status: 409,
      code: "CONFLICT"
    });
    // The same key with another input is refused and writes nothing.
    await t.expectRefused(
      t.admin.id,
      "permissions.grant",
      { ...input, payload: await grantPayload(t, t.lena.id) },
      { status: 409, code: "IDEMPOTENCY_KEY_REUSED" }
    );
    expect(await t.stores.access.listGrants({ clientInstanceId })).toHaveLength(1);
  });
});

describe("a field the query string names", () => {
  // Fails without input assembled from the declared parts: the query's holder replaced the
  // body's, and the grant went to somebody the body did not name.
  it("does not replace the field of the body: the grant is the body's", async () => {
    const { t } = await policyInstance();
    const response = await t.expectOk(t.admin.id, "permissions.grant", {
      payload: await grantPayload(t, t.kai.id),
      undeclaredQuery: { holderId: t.lena.id, action: "agent.delete", stray: "1" }
    });
    expect(grantSchema.parse(response.json())).toMatchObject({
      holderId: t.kai.id,
      action: "agent.write"
    });
    const grants = await t.stores.access.listGrants({ clientInstanceId });
    expect(grants.map((grant) => [grant.holderId, grant.action])).toEqual([
      [t.kai.id, "agent.write"]
    ]);
  });
});

describe("a superadmin's rows", () => {
  it("does not let a non-superadmin write or revoke a row of a superadmin", async () => {
    const { t } = await policyInstance();
    // Another superadmin: nobody writes a row of their own (RIGHTS-1b).
    const root = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Root two",
      roles: ["user", "admin", "superadmin"]
    });
    const payload = {
      holderKind: "user",
      holderId: root.id,
      action: "agent.write",
      scopeKind: "asset",
      scopeId: await t.assetId("agent", "assistant"),
      effect: "deny"
    };
    // The operation's own check refuses, so the refusal names the operation.
    await t.expectRefused(
      t.admin.id,
      "permissions.grant",
      { payload },
      t.forbidden("permissions.grant", "no_grant")
    );
    expect(await t.stores.access.listGrants({ clientInstanceId })).toEqual([]);

    // A superadmin may, and the other administrator cannot take the row away again.
    const created = grantSchema.parse(
      (await t.expectOk(t.root.id, "permissions.grant", { payload })).json()
    );
    await t.expectRefused(
      t.admin.id,
      "permissions.revoke",
      { params: { grantId: created.id } },
      { status: 403, code: "FORBIDDEN" }
    );
    await t.expectRefused(
      t.admin.id,
      "permissions.effective",
      { query: { holderKind: "user", holderId: root.id } },
      { status: 404, code: "NOT_FOUND", details: { reason: "unknown_holder" } }
    );
    await t.expectOk(t.root.id, "permissions.revoke", { params: { grantId: created.id } });
  });

  // Fails without the operation's own check: the policy was asked first, and the refusal came
  // from the handler as a failed run.
  it("are refused to an administrator before the policy is asked, as a denied run", async () => {
    const { t, asked } = await policyInstance();
    // Another superadmin: nobody writes a row of their own (RIGHTS-1b).
    const root = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Root two",
      roles: ["user", "admin", "superadmin"]
    });
    const held = grantSchema.parse(
      (
        await t.expectOk(t.root.id, "permissions.grant", {
          payload: await grantPayload(t, root.id)
        })
      ).json()
    );

    const attempts: Array<[TestOperationName, TestCallInput]> = [
      ["permissions.grant", { payload: await grantPayload(t, root.id, { effect: "deny" }) }],
      // The holder is decided before what the row says: an action that cannot be granted is
      // not looked at for a caller who may not write this holder's rows.
      [
        "permissions.grant",
        { payload: await grantPayload(t, root.id, { action: "users.manage" }) }
      ],
      ["permissions.revoke", { params: { grantId: held.id } }]
    ];
    for (const [index, [operation, input]] of attempts.entries()) {
      const policyAsked = asked.policy;
      const { response, runs, audit } = await traced(
        t,
        t.admin.id,
        operation,
        input,
        `corr_refused_${index}`
      );
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: {
          correlationId: `corr_refused_${index}`,
          code: "FORBIDDEN",
          message: `Missing the right '${operation}'`,
          details: { action: operation, reason: "no_grant" }
        }
      });
      expect(asked.policy, "the policy was not asked").toBe(policyAsked);
      expect(runs.map((run) => ({ status: run.status, denial: run.denial }))).toEqual([
        { status: "denied", denial: { kind: "forbidden", action: operation, reason: "no_grant" } }
      ]);
      // Assert both rows exactly; timestamps can tie and their random IDs do not encode call order.
      expect(
        audit
          .map((event) => ({ type: event.type, status: event.status, actor: actorOf(event) }))
          .sort((left, right) => left.type.localeCompare(right.type))
      ).toEqual([
        { type: "operation.authorization_checked", status: "denied", actor: t.admin.id },
        { type: "operation.denied", status: "denied", actor: t.admin.id }
      ]);
    }
    expect(await t.stores.access.listGrants({ clientInstanceId })).toHaveLength(1);
  });

  // Fails without `users.manage` inside the operation's own check: the two grant writes name
  // no right in `requires`, so nothing else would refuse this caller.
  it("and everyone's are refused to a caller without users.manage before any holder is read", async () => {
    const { t, asked } = await policyInstance();
    const grantId = await t.grant(t.lena.id, "agent.read", {
      workspaceId: await t.sharedWorkspace("Kai")
    });
    const policyAsked = asked.policy;
    for (const [operation, input] of [
      // A holder who is a superadmin answers as any other holder does.
      ["permissions.grant", { payload: await grantPayload(t, t.root.id) }],
      ["permissions.grant", { payload: await grantPayload(t, "user_missing") }],
      ["permissions.revoke", { params: { grantId } }],
      ["permissions.revoke", { params: { grantId: "missing" } }]
    ] as const) {
      await t.expectRefused(t.kai.id, operation, input, t.forbidden("users.manage", "no_grant"));
    }
    expect(asked.policy).toBe(policyAsked);
    expect(await t.stores.access.listGrants({ clientInstanceId })).toHaveLength(1);
  });
});

describe("the policy of a grant or build limits write", () => {
  // Fails without the registration: a plain route asks no policy and wrote the row.
  it("refuses a write the instance denies and writes nothing", async () => {
    const { t } = await policyInstance([
      { operation: "permissions.grant", value: "deny" },
      { operation: "workspaces.limits.update", value: "deny" }
    ]);
    const workspaceId = await t.sharedWorkspace("Kai");
    await t.expectRefused(
      t.admin.id,
      "permissions.grant",
      { payload: await grantPayload(t, t.kai.id) },
      { status: 403, code: "POLICY_DENIED" }
    );
    await t.expectRefused(
      t.root.id,
      "workspaces.limits.update",
      {
        params: { collaborationWorkspaceId: workspaceId },
        payload: { allowedToolNames: ["known.tool"] }
      },
      { status: 403, code: "POLICY_DENIED" }
    );
    expect(await t.stores.access.listGrants({ clientInstanceId })).toEqual([]);
    expect(
      (await t.stores.workspaces.getWorkspace(clientInstanceId, workspaceId))?.allowedToolNames
    ).toBeUndefined();
  });

  // Fails without the registration: the grant was written at once.
  it("holds a grant for another person's approval with 202 and writes nothing meanwhile", async () => {
    const { t } = await policyInstance([{ operation: "permissions.grant", value: "approval" }]);
    const held = await t.call(t.admin.id, "permissions.grant", {
      payload: await grantPayload(t, t.kai.id)
    });
    expect(held.statusCode).toBe(202);
    const run = operationRunSchema.parse(held.json());
    expect(run).toMatchObject({ operation: "permissions.grant", status: "pending_approval" });
    expect(held.headers.location).toContain(run.id);
    expect(await t.stores.access.listGrants({ clientInstanceId })).toEqual([]);
  });
});
