import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asAgentRunId,
  asConversationId,
  asToolCallId,
  asUserId,
  createAuthorizer,
  type AuthenticatedUser,
  type UserRole
} from "@vivd-catalyst/core";
import { InProcessToolExecution, ToolRegistry } from "@vivd-catalyst/tool-execution";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import {
  SERVICE_HEADER,
  agent,
  clientInstanceId,
  errorSchema,
  grantSchema,
  otherClientInstanceId,
  setupAccessInstance as setup,
  skill
} from "./support/access-instance";
import type { TestCallInput, TestOperationName } from "./support/operations";

// Administration of grants and Namespaces at the HTTP boundary: who may write what, the tenant
// and holder boundaries of the store, audit, and the reference check of a tool call. The
// grants themselves are in `chat-server-access.test.ts`.

describe("Namespace administration", () => {
  it("refuses a prefix that overlaps a registered one, in either direction", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    for (const prefix of ["kai-x-", "kai-"]) {
      await t.expectRefused(
        t.admin.id,
        "namespaces.create",
        { payload: { prefix, displayName: prefix } },
        { status: 409, code: "CONFLICT", details: { reason: "namespace_overlap", prefix: "kai-" } }
      );
    }
    await t.createNamespace("team-x-");
    await t.expectRefused(
      t.admin.id,
      "namespaces.create",
      { payload: { prefix: "team-", displayName: "Team" } },
      { status: 409, code: "CONFLICT", details: { reason: "namespace_overlap", prefix: "team-x-" } }
    );
    // A prefix that shares letters but not a whole word does not overlap.
    await t.createNamespace("kaiser-");
    await t.createNamespace("team-y-");
  });

  it("refuses a prefix that is not lowercase words ending in one hyphen", async () => {
    const t = await setup();
    for (const prefix of [
      "kai",
      "Kai-",
      "-kai-",
      "kai--",
      "k",
      "9kai-",
      "kai_x-",
      "",
      "a".repeat(32) + "-"
    ]) {
      await t.expectRefused(
        t.admin.id,
        "namespaces.create",
        { payload: { prefix, displayName: "Bad" } },
        { status: 422, code: "VALIDATION_FAILED" }
      );
    }
    await t.createNamespace("a-");
    await t.createNamespace(`${"b".repeat(31)}-`);
  });

  it("refuses to delete a Namespace a grant row names, and deletes it after the revoke", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    const grantId = await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });
    expect((await t.putAgent(t.kai.id, "kai-helper")).statusCode).toBe(200);
    await t.expectOk(t.admin.id, "config_assets.put", {
      params: { kind: "skill", name: "kai-notes" },
      payload: { config: skill("kai-notes") }
    });

    const listed = z
      .object({ items: z.array(z.object({ prefix: z.string() }).loose()) })
      .parse((await t.expectOk(t.admin.id, "namespaces.list")).json());
    expect(listed.items).toEqual([
      expect.objectContaining({ prefix: "kai-", grantCount: 1, assetCount: 2 })
    ]);

    await t.expectRefused(
      t.admin.id,
      "namespaces.delete",
      { params: { prefix: "kai-" } },
      { status: 409, code: "CONFLICT", details: { reason: "namespace_in_use", grantCount: 1 } }
    );
    await t.expectOk(t.admin.id, "permissions.revoke", { params: { grantId } });
    await t.expectOk(t.admin.id, "namespaces.delete", { params: { prefix: "kai-" } });
    await t.expectRefused(
      t.admin.id,
      "namespaces.delete",
      { params: { prefix: "kai-" } },
      { status: 404, code: "NOT_FOUND" }
    );
    await t.expectRefused(
      t.admin.id,
      "namespaces.update",
      { params: { prefix: "kai-" }, payload: { displayName: "Gone" } },
      { status: 404, code: "NOT_FOUND" }
    );
  });
});

describe("who may write a grant, and what a grant may say", () => {
  it("refuses a user without users.manage all eight operations", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    const grantId = await t.grant(t.lena.id, "agent.read", { namespace: "kai-" });
    const calls: Array<[TestOperationName, TestCallInput]> = [
      [
        "permissions.grant",
        {
          payload: {
            holderKind: "user",
            holderId: t.kai.id,
            action: "agent.write",
            scopeKind: "namespace",
            namespace: "kai-"
          }
        }
      ],
      ["permissions.revoke", { params: { grantId } }],
      ["permissions.list", {}],
      ["permissions.effective", { query: { holderKind: "user", holderId: t.kai.id } }],
      ["namespaces.create", { payload: { prefix: "mine-", displayName: "Mine" } }],
      ["namespaces.update", { params: { prefix: "kai-" }, payload: { displayName: "Mine" } }],
      ["namespaces.list", {}],
      ["namespaces.delete", { params: { prefix: "kai-" } }]
    ];
    expect(calls).toHaveLength(8);
    for (const [operation, input] of calls) {
      await t.expectRefused(t.kai.id, operation, input, t.forbidden("users.manage", "no_grant"));
    }
    // Nothing was written, and the administrator may do each of them.
    expect(await t.stores.access.listGrants({ clientInstanceId })).toHaveLength(1);
    expect(await t.stores.access.listNamespaces({ clientInstanceId })).toHaveLength(1);
    await t.expectOk(t.admin.id, "permissions.list");
    await t.expectOk(t.admin.id, "permissions.effective", {
      query: { holderKind: "user", holderId: t.kai.id }
    });
    await t.expectOk(t.admin.id, "namespaces.list");
  });

  it("refuses an administrator whose users.manage was revoked in the legacy column", async () => {
    const t = await setup();
    await t.stores.users.updateUser({
      clientInstanceId,
      userId: t.admin.id,
      permissions: ["!users.manage"]
    });
    await t.expectRefused(t.admin.id, "namespaces.list", {}, t.forbidden("users.manage", "denied"));
    await t.expectOk(t.root.id, "namespaces.list");
  });

  it("refuses a service principal: the operations are a person's", async () => {
    const t = await setup();
    for (const operation of ["permissions.list", "namespaces.list"] as const) {
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

  it("does not let a non-superadmin write or revoke a row of a superadmin", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    const payload = {
      holderKind: "user",
      holderId: t.root.id,
      action: "agent.write",
      scopeKind: "namespace",
      namespace: "kai-",
      effect: "deny"
    };
    const refusal = await t.expectRefused(
      t.admin.id,
      "permissions.grant",
      { payload },
      { status: 403, code: "FORBIDDEN" }
    );
    expect(refusal.message).toBe("Only superadmins can manage superadmin users");
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
      { query: { holderKind: "user", holderId: t.root.id } },
      { status: 404, code: "NOT_FOUND", details: { reason: "unknown_holder" } }
    );
    await t.expectOk(t.root.id, "permissions.revoke", { params: { grantId: created.id } });
  });

  it("writes a row for a user, six actions, a Namespace or an asset, and nothing else", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    expect((await t.putAgent(t.admin.id, "kai-helper")).statusCode).toBe(200);
    const helper = await t.assetId("agent", "kai-helper");
    const base = {
      holderKind: "user",
      holderId: t.kai.id,
      action: "agent.write",
      scopeKind: "namespace",
      namespace: "kai-"
    };
    const refusals: Array<[Record<string, unknown>, number, string, string]> = [
      [{ ...base, holderKind: "service_principal" }, 422, "VALIDATION_FAILED", "invalid_scope"],
      [
        { ...base, holderKind: "role", holderId: "admin" },
        422,
        "VALIDATION_FAILED",
        "invalid_scope"
      ],
      [{ ...base, holderKind: "group" }, 422, "VALIDATION_FAILED", "invalid_scope"],
      [
        { ...base, scopeKind: "instance", namespace: undefined },
        422,
        "VALIDATION_FAILED",
        "invalid_scope"
      ],
      [
        { ...base, scopeKind: "workspace", namespace: undefined, scopeId: "workspace-1" },
        422,
        "VALIDATION_FAILED",
        "invalid_scope"
      ],
      [{ ...base, namespace: undefined }, 422, "VALIDATION_FAILED", "invalid_scope"],
      [{ ...base, scopeId: helper }, 422, "VALIDATION_FAILED", "invalid_scope"],
      [
        { ...base, scopeKind: "asset", namespace: undefined },
        422,
        "VALIDATION_FAILED",
        "invalid_scope"
      ],
      [
        { ...base, scopeKind: "asset", namespace: undefined, scopeId: "asset-missing" },
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
          namespace: undefined,
          scopeId: helper
        },
        422,
        "VALIDATION_FAILED",
        "invalid_scope"
      ],
      [{ ...base, namespace: "lena-" }, 422, "VALIDATION_FAILED", "unknown_namespace"],
      [{ ...base, namespace: "kai" }, 422, "VALIDATION_FAILED", "unknown_namespace"],
      [{ ...base, action: "users.manage" }, 422, "VALIDATION_FAILED", "action_not_grantable"],
      [{ ...base, action: "assets.release" }, 422, "VALIDATION_FAILED", "action_not_grantable"],
      [{ ...base, action: "skill.approve" }, 422, "VALIDATION_FAILED", "action_not_grantable"],
      [{ ...base, action: "config_assets.write" }, 422, "VALIDATION_FAILED", "unknown_action"],
      [{ ...base, action: "ref:demo-tools" }, 422, "VALIDATION_FAILED", "unknown_action"],
      [{ ...base, action: "agent.publish" }, 422, "VALIDATION_FAILED", "unknown_action"],
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
    expect(await t.stores.access.listGrants({ clientInstanceId })).toEqual([]);

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
    await t.createNamespace("kai-");
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
          scopeKind: "namespace",
          namespace: "kai-"
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

  it("lists rows by holder and shows the sources of a holder's rights", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    const allowId = await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });
    await t.grant(t.lena.id, "skill.read", { namespace: "kai-" }, "deny");

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
        scopeKind: "namespace",
        namespace: "kai-",
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
          scopeKind: "namespace",
          namespace: "kai-",
          source: "grant"
        }
      ]
    });
    // A service principal's rights are read behind api_access.manage.
    await t.expectRefused(
      t.admin.id,
      "permissions.effective",
      { query: { holderKind: "service_principal", holderId: "sp_missing" } },
      t.forbidden("api_access.manage", "no_grant")
    );
    await t.expectRefused(
      t.root.id,
      "permissions.effective",
      { query: { holderKind: "service_principal", holderId: "sp_missing" } },
      { status: 404, code: "NOT_FOUND", details: { reason: "unknown_holder" } }
    );
  });
});

describe("tenant and holder boundaries of the access store", () => {
  it("loads no row and no Namespace of another client instance", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });

    const own = await t.stores.access.loadPersistedAccess({
      clientInstanceId,
      holder: { kind: "user", id: t.kai.id }
    });
    expect(own.grants).toHaveLength(1);
    expect(own.namespaces).toHaveLength(1);

    const foreign = await t.stores.access.loadPersistedAccess({
      clientInstanceId: otherClientInstanceId,
      holder: { kind: "user", id: t.kai.id }
    });
    expect(foreign.grants).toEqual([]);
    expect(foreign.namespaces).toEqual([]);

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
        name: "kai-helper"
      })
    ).toEqual({ allowed: true, source: "grant" });
    expect(
      (await authorizer.forActor(actor(otherClientInstanceId))).authorize("agent.write", {
        name: "kai-helper"
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
        scopeKind: "namespace",
        namespace: "kai-",
        grantedBy: asUserId(t.admin.id)
      })
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { reason: "unknown_namespace" }
    });
    // The same prefix is free in the other instance.
    await expect(
      t.stores.access.createNamespace({
        clientInstanceId: otherClientInstanceId,
        prefix: "kai-",
        displayName: "Theirs",
        createdBy: asUserId(t.admin.id)
      })
    ).resolves.toMatchObject({ prefix: "kai-" });
    expect(await t.stores.access.listGrants({ clientInstanceId })).toHaveLength(1);
  });

  it("loads only the holder's own rows, by kind and id", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });

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
    // No operation writes a workspace row yet; the table and the evaluator already hold one.
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.kai.id,
      action: "agent.write",
      effect: "allow",
      scopeKind: "workspace",
      scopeId: "workspace-1",
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
    expect(access.authorize("agent.write", { workspaceId: "workspace-1" })).toEqual({
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
      "config_assets.put",
      { params: { kind: "agent", name: "kai-helper" }, payload: { config: agent("kai-helper") } },
      t.forbidden("agent.write", "no_grant")
    );
  });
});

describe("deleting a holder", () => {
  it("deletes the user's grant rows with the user and leaves every other holder's", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });
    await t.grant(t.kai.id, "skill.read", { namespace: "kai-" }, "deny");
    const lenaGrant = await t.grant(t.lena.id, "agent.read", { namespace: "kai-" });

    await t.expectOk(t.root.id, "users.delete", { params: { userId: t.kai.id } });

    const left = await t.stores.access.listGrants({ clientInstanceId });
    expect(left.map((row) => row.id)).toEqual([lenaGrant]);
    // Nothing answers for the id any more, whoever carries it next.
    const persisted = await t.stores.access.loadPersistedAccess({
      clientInstanceId,
      holder: { kind: "user", id: t.kai.id }
    });
    expect(persisted.grants).toEqual([]);
    // The Namespace is held by Lena's row alone, and is free after its revoke.
    await t.expectOk(t.admin.id, "permissions.revoke", { params: { grantId: lenaGrant } });
    await t.expectOk(t.admin.id, "namespaces.delete", { params: { prefix: "kai-" } });
  });

  it("keeps the rows when the deletion is refused", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });
    await t.expectRefused(
      t.lena.id,
      "users.delete",
      { params: { userId: t.kai.id } },
      t.forbidden("users.manage", "no_grant")
    );
    expect(await t.stores.access.listGrants({ clientInstanceId })).toHaveLength(1);
  });
});

describe("audit of grants and Namespaces", () => {
  it("records each write with holder id, action and scope, and no name or list", async () => {
    const t = await setup();
    await t.createNamespace("kai-", { allowedToolNames: ["known.tool"] });
    const grantId = await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });
    await t.expectOk(t.admin.id, "namespaces.update", {
      params: { prefix: "kai-" },
      payload: { displayName: "Kai Private Name", allowedModelBindingIds: ["plain"] }
    });
    await t.expectOk(t.admin.id, "permissions.revoke", { params: { grantId } });
    await t.expectOk(t.admin.id, "namespaces.delete", { params: { prefix: "kai-" } });
    // A refused write records no governance event of these types.
    await t.expectRefused(
      t.kai.id,
      "namespaces.create",
      { payload: { prefix: "mine-", displayName: "Mine" } },
      t.forbidden("users.manage", "no_grant")
    );

    const events = (await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 }))
      .filter(
        (event) => event.type.startsWith("permission.") || event.type.startsWith("namespace.")
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const grantMetadata = {
      grantId,
      holderKind: "user",
      holderId: t.kai.id,
      action: "agent.write",
      effect: "allow",
      scopeKind: "namespace",
      namespace: "kai-"
    };
    expect(
      events.map((event) => ({
        type: event.type,
        status: event.status,
        subject: event.subject,
        metadata: event.metadata
      }))
    ).toEqual([
      {
        type: "namespace.created",
        status: "success",
        subject: "kai-",
        metadata: { prefix: "kai-", restrictsTools: true, restrictsModels: false }
      },
      { type: "permission.granted", status: "success", subject: grantId, metadata: grantMetadata },
      {
        type: "namespace.updated",
        status: "success",
        subject: "kai-",
        metadata: { prefix: "kai-", restrictsTools: true, restrictsModels: true }
      },
      { type: "permission.revoked", status: "success", subject: grantId, metadata: grantMetadata },
      {
        type: "namespace.deleted",
        status: "success",
        subject: "kai-",
        metadata: { prefix: "kai-", restrictsTools: true, restrictsModels: true }
      }
    ]);
    const written = JSON.stringify(events);
    for (const payload of ["Kai Private Name", "known.tool", "plain", '"Kai"', '"Lena"']) {
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
    const execution = new InProcessToolExecution({
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
      execution.authorize(request, {
        clientInstanceId,
        correlationId: "corr_access_tool",
        user: actor
      });

    expect(await authorize(user(t.kai.id, ["user"], ["demo-tools"]))).toMatchObject({
      status: "allowed"
    });
    for (const actor of [
      user(t.lena.id, ["user"], []),
      user(t.lena.id, ["user"], ["other-tools"]),
      user(t.root.id, ["user", "admin", "superadmin"], [])
    ]) {
      expect(await authorize(actor)).toEqual({
        status: "denied",
        reason: "User is missing permission 'demo-tools'"
      });
    }

    // A deactivated holder of the reference is refused too.
    await t.stores.users.updateUser({ clientInstanceId, userId: t.kai.id, status: "disabled" });
    expect(await authorize(user(t.kai.id, ["user"], ["demo-tools"]))).toMatchObject({
      status: "denied"
    });
  });
});
