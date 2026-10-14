import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIONS,
  PRINCIPAL_GRANTABLE_ACTIONS,
  createAuthorizer,
  type ServicePrincipalRecord
} from "@vivd-catalyst/core";
import { runOperation } from "@vivd-catalyst/tool-execution";
import {
  SCOPES_HEADER,
  SERVICE_HEADER,
  clientInstanceId,
  errorSchema,
  grantSchema
} from "./support/access-instance";
import type { ConnectionOperationsFixture } from "./support/connection-operations";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import {
  denied,
  forWorkflows,
  keyIdentity,
  runIdentity,
  setup,
  workflowOrigin,
  type Setup
} from "./support/principal-grants";
import { withTestSql } from "./support/test-sql";

// Grant rows for a service principal on named resources, on real rows and the real call
// path: who writes one, what it may give, where and with which effect, each refusal by its
// code; that the evaluator answers for the principal from these rows beside its two legacy
// permissions; and what disabling and deleting the principal do to them.
//
// No Data Store kind is loaded on this build, so the resource is a Connection and the right
// `connection.use`. Every test here fails without the change: before it `permissions.grant`
// refused every holder but a user.

afterEach(() => {
  vi.restoreAllMocks();
});

/** The audit rows of one type that name the principal. */
async function auditOf(t: ConnectionOperationsFixture, type: string, principalId: string) {
  const events = await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 });
  return events.filter(
    (event) => event.type === type && event.metadata?.servicePrincipalId === principalId
  );
}

describe("the rights a service principal can be granted", () => {
  it("are six use rights in one list, each a registered action and none that changes or manages", () => {
    expect(PRINCIPAL_GRANTABLE_ACTIONS).toEqual([
      "connection.use",
      "data_store.read",
      "data_store.insert",
      "data_store.execute",
      "knowledge_base.use",
      "workflow.use"
    ]);
    for (const action of PRINCIPAL_GRANTABLE_ACTIONS) {
      expect(ACTIONS, action).toContain(action);
      expect(action, action).not.toMatch(/\.(?:write|publish|delete|approve|manage|release)$/u);
    }
  });
});

describe("a grant for a service principal on one Connection", () => {
  it("lets a run as the principal call that Connection and refuses a second one with the right named", async () => {
    const s = await setup();
    const { t, principal } = s;
    const crm = await t.seed("crm", forWorkflows);
    await t.seed("erp", forWorkflows);
    // Before the row the principal reaches neither.
    expect((await s.step("crm")).result).toMatchObject(denied("connection.use", "no_grant"));

    await s.grantTo(crm);

    expect((await s.step("crm")).result).toMatchObject({
      status: "done",
      output: { text: "hello" }
    });
    expect(t.executed).toHaveLength(1);
    const second = await s.step("erp");
    expect(second.result).toMatchObject(denied("connection.use", "no_grant"));
    expect(second.run).toMatchObject({
      status: "denied",
      actor: { kind: "service_principal", id: principal.id },
      origin: { kind: "workflow" }
    });
    // A Connection stored afterwards is not reachable by a principal that was not given it.
    await t.seed("later", forWorkflows);
    expect((await s.step("later")).result).toMatchObject(denied("connection.use", "no_grant"));
    // A key of the principal holds the same and nothing more.
    const byKey = await createAuthorizer(t.stores.access).forActor(keyIdentity(principal));
    expect(byKey.authorize("connection.use", { kind: "connection", assetId: crm })).toEqual({
      allowed: true,
      source: "grant"
    });
    for (const action of ["connection.read", "connection.write", "connection.delete"]) {
      expect(byKey.authorize(action, { kind: "connection", assetId: crm }), action).toEqual({
        allowed: false,
        reason: "no_grant"
      });
    }
    expect(byKey.authorize("connection.use")).toEqual({ allowed: false, reason: "no_grant" });
  });

  it("answers beside the rows of the principal's two legacy permissions and widens neither", async () => {
    const s = await setup();
    const crm = await s.t.seed("crm", forWorkflows);
    await s.grantTo(crm);

    const access = await createAuthorizer(s.t.stores.access).forActor(runIdentity(s.principal));

    expect(access.authorize("agent.read")).toEqual({ allowed: true, source: "grant" });
    expect(access.authorize("config_assets.read")).toEqual({ allowed: true, source: "grant" });
    expect(access.authorize("assets.release")).toEqual({ allowed: false, reason: "no_grant" });
    expect(access.authorize("users.manage")).toEqual({ allowed: false, reason: "no_grant" });
    const effective = await s.t.expectOk(s.t.root.id, "permissions.effective", {
      query: { holderKind: "service_principal", holderId: s.principal.id }
    });
    expect(effective.json()).toEqual({
      holderActive: true,
      items: [
        { action: "agent.read", effect: "allow", scopeKind: "instance", source: "grant" },
        { action: "skill.read", effect: "allow", scopeKind: "instance", source: "grant" },
        {
          action: "connection.use",
          effect: "allow",
          scopeKind: "asset",
          scopeId: crm,
          source: "grant"
        }
      ]
    });
  });

  it("records the holder kind, the principal, the right and the asset when it is written and revoked", async () => {
    const s = await setup();
    const { t, principal } = s;
    const crm = await t.seed("crm", forWorkflows);
    const grantId = await s.grantTo(crm);
    await t.expectOk(t.root.id, "permissions.revoke", { params: { grantId } });

    const metadata = {
      grantId,
      holderKind: "service_principal",
      holderId: principal.id,
      servicePrincipalId: principal.id,
      action: "connection.use",
      effect: "allow",
      scopeKind: "asset",
      scopeId: crm
    };
    for (const type of ["permission.granted", "permission.revoked"]) {
      const events = await auditOf(t, type, principal.id);
      expect(events, type).toHaveLength(1);
      expect(events[0], type).toMatchObject({
        status: "success",
        subject: grantId,
        actor: { userId: t.root.id },
        metadata
      });
    }
    // Revoked, the row is gone and the next step is refused.
    expect(await s.principalRows()).toEqual([]);
    expect((await s.step("crm")).result).toMatchObject(denied("connection.use", "no_grant"));
  });

  it("is removed with the Connection it names", async () => {
    const s = await setup();
    const crm = await s.t.seed("crm", forWorkflows);
    await s.grantTo(crm);

    // A Connection is deleted where it is defined, by a release, through the store.
    await applyAtCurrentRevisions(s.t.stores.configAssets, {
      clientInstanceId,
      mutations: [{ type: "delete", kind: "connection", name: "crm" }]
    });

    expect(await s.principalRows()).toEqual([]);
  });
});

describe("who writes a service principal's grant row", () => {
  it("refuses a key of the principal that grants to its own principal, whatever the principal holds", async () => {
    const s = await setup();
    const { t, principal } = s;
    const crm = await t.seed("crm", forWorkflows);

    // Over HTTP a service key is refused by the operation's own check, by name, and the
    // refusal says what refused: no right is missing that a principal could be given.
    const overHttp = await t.instance.call("permissions.grant", {
      payload: s.payload(crm),
      headers: { [SERVICE_HEADER]: principal.id }
    });
    expect(overHttp.statusCode).toBe(403);
    expect(errorSchema.parse(overHttp.json()).error).toMatchObject({
      code: "FORBIDDEN",
      message: "A service principal writes no grant row",
      details: { action: "permissions.grant", reason: "holder_not_administrable" }
    });

    // Reached as an operation of the registry, by a key or by a run, also with every right
    // an administrator holds: the operation's own check refuses before any right is read.
    const everything = ["users.manage", "api_access.manage", "config_assets.write"];
    let attempt = 0;
    for (const actor of [
      keyIdentity(principal),
      keyIdentity(principal, everything),
      runIdentity(principal, everything)
    ]) {
      for (const holderId of [principal.id, "spn_another"]) {
        const outcome = await runOperation(
          {
            operation: "permissions.grant",
            effect: "changing",
            input: s.payload(crm, { holderId }),
            actor,
            origin: "workflowRunId" in actor ? workflowOrigin : { kind: "cli" },
            correlationId: "corr_self_grant",
            idempotencyKey: `self-grant-${(attempt += 1)}`
          },
          t.operationCalls.deps
        );
        expect(outcome.result).toMatchObject(
          denied("permissions.grant", "holder_not_administrable")
        );
      }
    }
    expect(await s.principalRows()).toEqual([]);
  });

  it("refuses a key of the principal that revokes a row, its own included", async () => {
    const s = await setup();
    const { t, principal } = s;
    const grantId = await s.grantTo(await t.seed("crm", forWorkflows));

    const outcome = await runOperation(
      {
        operation: "permissions.revoke",
        effect: "changing",
        input: { grantId },
        actor: keyIdentity(principal, ["users.manage", "api_access.manage"]),
        origin: { kind: "cli" },
        correlationId: "corr_self_revoke"
      },
      t.operationCalls.deps
    );

    expect(outcome.result).toMatchObject(denied("permissions.revoke", "holder_not_administrable"));
    const overHttp = await t.instance.call("permissions.revoke", {
      params: { grantId },
      headers: { [SERVICE_HEADER]: principal.id }
    });
    expect(overHttp.statusCode).toBe(403);
    expect(errorSchema.parse(overHttp.json()).error).toMatchObject({
      code: "FORBIDDEN",
      message: "A service principal writes no grant row",
      details: { action: "permissions.revoke", reason: "holder_not_administrable" }
    });
    expect(await s.principalRows()).toHaveLength(1);
  });

  // Check 38: an administrator, no superadmin and without `api_access.manage`, gives a
  // principal a right where the administrator holds it, and only there.
  it("asks service_principals.manage and the right it gives, on the asset it names", async () => {
    const s = await setup();
    const { t } = s;
    const crm = await t.seed("crm", forWorkflows);
    const erp = await t.seed("erp", forWorkflows);

    // Managing users is no right over principals, and holding nothing is not either.
    for (const userId of [s.manager.id, t.kai.id]) {
      await t.expectRefused(
        userId,
        "permissions.grant",
        { payload: s.payload(crm) },
        t.forbidden("service_principals.manage", "no_grant")
      );
    }
    expect(await s.principalRows()).toEqual([]);

    // The administrator holds `connection.use` on the CRM and gives it.
    const written = await t.expectOk(t.admin.id, "permissions.grant", { payload: s.payload(crm) });
    const grantId = grantSchema.parse(written.json()).id;
    // A deny on the ERP takes it from the administrator, who then cannot give it there.
    await t.grant(t.admin.id, "connection.use", { assetId: erp }, "deny");
    const denied = await t.expectRefused(
      t.admin.id,
      "permissions.grant",
      { payload: s.payload(erp) },
      t.forbidden("connection.use", "denied")
    );
    expect(denied.message).toBe(
      "'connection.use' on the connection 'erp' is denied to this call, and 'Monthly check' would act with it. Only a holder of a right gives or lends it"
    );
    expect((await s.principalRows()).map((row) => row.id)).toEqual([grantId]);

    // Who may not see service principals is told of a principal's row what is told of a row
    // that does not exist, so no grant id of a principal can be told from an absent one.
    const hidden = await t.expectRefused(
      s.manager.id,
      "permissions.revoke",
      { params: { grantId } },
      { status: 404, code: "NOT_FOUND" }
    );
    const absent = await t.expectRefused(
      s.manager.id,
      "permissions.revoke",
      { params: { grantId: "grant_absent" } },
      { status: 404, code: "NOT_FOUND" }
    );
    expect({ message: hidden.message, details: hidden.details }).toEqual({
      message: absent.message,
      details: absent.details
    });
    // A caller who holds neither right that removes a row causes no read.
    await t.expectRefused(
      t.kai.id,
      "permissions.revoke",
      { params: { grantId } },
      t.forbidden("users.manage", "no_grant")
    );
    expect(await s.principalRows()).toHaveLength(1);
    // Taking a right away asks nothing of the rule: the deny does not stop the revoke.
    await t.expectOk(t.admin.id, "permissions.revoke", { params: { grantId } });
    expect(await s.principalRows()).toEqual([]);
  });

  it("asks the credential what administering service principals asks of it", async () => {
    const s = await setup();
    const { t } = s;
    const crm = await t.seed("crm", forWorkflows);
    const withScopes = (scopes: string) => ({ headers: { [SCOPES_HEADER]: scopes } });
    const missingScope = (scope: string) => ({
      status: 403,
      code: "FORBIDDEN",
      details: { action: `auth_scope:${scope}`, reason: "no_grant" }
    });

    // A key of the superadmin issued for managing users writes rows for users and none here.
    await t.expectRefused(
      t.root.id,
      "permissions.grant",
      { payload: s.payload(crm), ...withScopes("user_admin:write user_admin:read") },
      missingScope("api_access:write")
    );
    expect(await s.principalRows()).toEqual([]);
    const written = await t.expectOk(t.root.id, "permissions.grant", {
      payload: s.payload(crm),
      ...withScopes("user_admin:write api_access:write")
    });
    const grantId = grantSchema.parse(written.json()).id;
    await t.expectRefused(
      t.root.id,
      "permissions.revoke",
      { params: { grantId }, ...withScopes("user_admin:write api_access:read") },
      missingScope("api_access:write")
    );
    // Without the scope of reading API access the row is not there for the key: not to
    // revoke, not in the list, and not in what the principal is said to hold.
    await t.expectRefused(
      t.root.id,
      "permissions.revoke",
      { params: { grantId }, ...withScopes("user_admin:write") },
      { status: 404, code: "NOT_FOUND" }
    );
    const listed = await t.expectOk(t.root.id, "permissions.list", withScopes("user_admin:read"));
    expect(listed.json()).toMatchObject({ items: [] });
    const effective = { query: { holderKind: "service_principal", holderId: s.principal.id } };
    const refused = await t.expectRefused(
      t.root.id,
      "permissions.effective",
      { ...effective, ...withScopes("user_admin:read") },
      { status: 403, code: "FORBIDDEN" }
    );
    expect(refused.message).toBe("Missing auth scope 'api_access:read'");
    await t.expectOk(t.root.id, "permissions.effective", {
      ...effective,
      ...withScopes("user_admin:read api_access:read")
    });
    expect(await s.principalRows()).toHaveLength(1);
  });

  it("shows a principal's rows to who may see service principals, and to nobody else", async () => {
    const s = await setup();
    const { t, principal } = s;
    const grantId = await s.grantTo(await t.seed("crm", forWorkflows));
    const listed = async (userId: string, query: Record<string, string> = {}) =>
      grantSchema
        .array()
        .parse((await t.expectOk(userId, "permissions.list", { query })).json().items)
        .map((row) => row.id);

    expect(await listed(t.root.id)).toEqual([grantId]);
    expect(await listed(s.ops.id, { holderKind: "service_principal" })).toEqual([grantId]);
    expect(await listed(t.admin.id, { holderKind: "service_principal" })).toEqual([grantId]);
    expect(await listed(s.manager.id)).toEqual([]);
    expect(
      await listed(s.manager.id, { holderKind: "service_principal", holderId: principal.id })
    ).toEqual([]);
  });

  it("lists one principal's rows and one Connection's holders, a person's row beside a principal's", async () => {
    const s = await setup();
    const { t, principal } = s;
    const crm = await t.seed("crm", forWorkflows);
    const erp = await t.seed("erp", forWorkflows);
    const onCrm = await s.grantTo(crm);
    const onErp = await s.grantTo(erp);
    const kaiOnCrm = await t.grant(t.kai.id, "connection.use", { assetId: crm });
    const listed = async (userId: string, query: Record<string, string>) =>
      grantSchema
        .array()
        .parse((await t.expectOk(userId, "permissions.list", { query })).json().items)
        .map((row) => row.id)
        .sort();

    // The principal's page: every row the principal holds.
    expect(
      await listed(t.root.id, { holderKind: "service_principal", holderId: principal.id })
    ).toEqual([onCrm, onErp].sort());
    // The Connection's page: who holds a right on this one Connection, of either kind.
    const holdersOfCrm = { scopeKind: "asset", scopeId: crm };
    expect(await listed(t.root.id, holdersOfCrm)).toEqual([onCrm, kaiOnCrm].sort());
    expect(await listed(t.root.id, { scopeKind: "asset", scopeId: erp })).toEqual([onErp]);

    // Who is not shown service principals is shown the person and nothing of the principal.
    expect(await listed(s.manager.id, holdersOfCrm)).toEqual([kaiOnCrm]);
    // The same answer for a Connection only a principal holds, for one nobody holds and for
    // one that does not exist: the list does not say which of the three it is.
    const nobody = await t.seed("empty", forWorkflows);
    for (const scopeId of [erp, nobody, "asset_unknown"]) {
      const answer = await t.expectOk(s.manager.id, "permissions.list", {
        query: { scopeKind: "asset", scopeId }
      });
      expect(answer.statusCode, scopeId).toBe(200);
      expect(answer.json(), scopeId).toEqual({ items: [] });
    }
    // And for a principal that exists and one that does not.
    for (const holderId of [principal.id, "sp_unknown"]) {
      const answer = await t.expectOk(s.manager.id, "permissions.list", {
        query: { holderKind: "service_principal", holderId }
      });
      expect(answer.json(), holderId).toEqual({ items: [] });
    }
  });
});

describe("what a service principal's grant row may give", () => {
  it("refuses every right that is no use right, with the code that names the limit", async () => {
    const s = await setup();
    const { t } = s;
    const crm = await t.seed("crm", forWorkflows);
    const refused = [
      // The ticket's case: a right that writes.
      "workflow.write",
      "connection.read",
      "connection.write",
      "connection.delete",
      "connection.approve",
      "agent.read",
      "agent.write",
      "app.use",
      "workflow.read_run_data",
      "data_store.write",
      "data_store.publish",
      "knowledge_base.write",
      "operations.approve",
      "users.manage",
      "api_access.manage",
      "assets.release",
      // A role, a legacy key and a name nothing registers are no use right either.
      "superadmin",
      "config_assets.release",
      "connection.use "
    ];
    for (const action of refused) {
      const error = await t.expectRefused(
        t.root.id,
        "permissions.grant",
        { payload: s.payload(crm, { action }) },
        { status: 422, code: "VALIDATION_FAILED" }
      );
      expect(error.details, action).toMatchObject({ reason: "action_not_grantable_to_principal" });
    }
    expect(await s.principalRows()).toEqual([]);
  });

  it("refuses a use right of the list whose module is off", async () => {
    const s = await setup();
    const { t } = s;
    const crm = await t.seed("crm", forWorkflows);
    // The kinds of Data Stores, Knowledge Bases and Workflows belong to modules that are off
    // here, so their rights are refused like everything else of those modules.
    const ofModule: Record<string, string> = {
      "data_store.read": "dataStores",
      "data_store.insert": "dataStores",
      "data_store.execute": "dataStores",
      "knowledge_base.use": "knowledge",
      "workflow.use": "workflows"
    };
    // Every right of the list but a Connection's belongs to one of them.
    expect(
      PRINCIPAL_GRANTABLE_ACTIONS.filter((name) => name !== "connection.use" && !(name in ofModule))
    ).toEqual([]);
    for (const [action, module] of Object.entries(ofModule)) {
      expect(PRINCIPAL_GRANTABLE_ACTIONS, action).toContain(action);
      const error = await t.expectRefused(
        t.root.id,
        "permissions.grant",
        { payload: s.payload(crm, { action }) },
        { status: 404, code: "NOT_FOUND" }
      );
      expect(error.details, action).toMatchObject({ reason: "module_off", module });
    }
    expect(await s.principalRows()).toEqual([]);
  });

  it("refuses every scope but one named asset of the right's kind", async () => {
    const s = await setup();
    const { t } = s;
    const crm = await t.seed("crm", forWorkflows);
    const workspaceId = await t.sharedWorkspace("Team");
    await t.createNamespace("crm-");
    const assistant = await t.assetId("agent", "assistant");
    const scopes: Record<string, unknown>[] = [
      // The ticket's case: a whole workspace.
      { scopeKind: "workspace", scopeId: workspaceId },
      { scopeKind: "namespace", scopeId: undefined, namespace: "crm-" },
      { scopeKind: "instance", scopeId: undefined },
      { scopeKind: "asset", scopeId: undefined },
      { scopeKind: "asset", namespace: "crm-" },
      { scopeKind: "asset", scopeId: "asset-missing" },
      // An asset of another kind is no Connection.
      { scopeKind: "asset", scopeId: assistant }
    ];
    for (const scope of scopes) {
      const error = await t.expectRefused(
        t.root.id,
        "permissions.grant",
        { payload: s.payload(crm, scope) },
        { status: 422, code: "VALIDATION_FAILED" }
      );
      expect(error.details, JSON.stringify(scope)).toMatchObject({ reason: "invalid_scope" });
    }
    expect(await s.principalRows()).toEqual([]);
  });

  it("refuses a deny, a principal the instance does not have and a second row for the same asset", async () => {
    const s = await setup();
    const { t } = s;
    const crm = await t.seed("crm", forWorkflows);

    const deny = await t.expectRefused(
      t.root.id,
      "permissions.grant",
      { payload: s.payload(crm, { effect: "deny" }) },
      { status: 422, code: "VALIDATION_FAILED" }
    );
    expect(deny.details).toMatchObject({ reason: "effect_not_grantable_to_principal" });
    // A user's id names no service principal.
    for (const holderId of ["spn_missing", t.kai.id]) {
      await t.expectRefused(
        t.root.id,
        "permissions.grant",
        { payload: s.payload(crm, { holderId }) },
        { status: 404, code: "NOT_FOUND", details: { reason: "unknown_holder" } }
      );
    }
    expect(await s.principalRows()).toEqual([]);

    await s.grantTo(crm);
    await t.expectRefused(
      t.root.id,
      "permissions.grant",
      { payload: s.payload(crm) },
      { status: 409, code: "CONFLICT", details: { reason: "duplicate_grant" } }
    );
  });
});

describe("a disabled or deleted service principal", () => {
  async function setStatus(s: Setup, status: ServicePrincipalRecord["status"]) {
    await s.t.stores.apiAccess.updateServicePrincipal({
      clientInstanceId,
      servicePrincipalId: s.principal.id,
      status
    });
  }

  it("has no use of its grants while it is disabled, and has them again when enabled", async () => {
    const s = await setup();
    const crm = await s.t.seed("crm", forWorkflows);
    await s.grantTo(crm);
    expect((await s.step("crm")).result).toMatchObject({ status: "done" });

    await setStatus(s, "disabled");

    const refusedStep = await s.step("crm");
    expect(refusedStep.result).toMatchObject(denied("connection.use", "holder_inactive"));
    expect(s.t.executed).toEqual([]);
    expect((await s.step("crm", keyIdentity(s.principal))).result).toMatchObject(
      denied("connection.use", "holder_inactive")
    );
    // The row stays recorded and is shown without effect.
    expect(await s.principalRows()).toHaveLength(1);
    const effective = await s.t.expectOk(s.t.root.id, "permissions.effective", {
      query: { holderKind: "service_principal", holderId: s.principal.id }
    });
    expect(effective.json()).toMatchObject({ holderActive: false });

    await setStatus(s, "active");
    expect((await s.step("crm")).result).toMatchObject({ status: "done" });
  });

  it("leaves no grant row and no key when it is deleted", async () => {
    const s = await setup();
    const { t, principal } = s;
    const crm = await t.seed("crm", forWorkflows);
    await s.grantTo(crm);
    await s.grantTo(await t.seed("erp", forWorkflows));
    await t.stores.apiAccess.createApiCredential({
      clientInstanceId,
      servicePrincipalId: principal.id,
      name: "key"
    });
    // A user's row for the same Connection is not the principal's and stays.
    const kaiRow = await t.grant(t.kai.id, "connection.use", { assetId: crm });

    const deleted = await t.stores.apiAccess.deleteServicePrincipal({
      clientInstanceId,
      servicePrincipalId: principal.id
    });

    expect(deleted?.id).toBe(principal.id);
    const left = await withTestSql(async (sql) => ({
      // The rows of the people who manage API access and users are theirs and stay.
      grants: await sql<{ id: string }[]>`
        select id from permission_grants
        where holder_id <> ${s.ops.id} and holder_id <> ${s.manager.id} order by id`,
      keys: await sql<{ count: number }[]>`select count(*)::int as count from api_credentials`,
      principals: await sql<
        { count: number }[]
      >`select count(*)::int as count from service_principals`
    }));
    expect(left.grants.map((row) => row.id)).toEqual([kaiRow]);
    expect(left.keys).toEqual([{ count: 0 }]);
    expect(left.principals).toEqual([{ count: 0 }]);
    // A second delete finds nothing, and no row can be written for what is gone.
    expect(
      await t.stores.apiAccess.deleteServicePrincipal({
        clientInstanceId,
        servicePrincipalId: principal.id
      })
    ).toBeUndefined();
    await t.expectRefused(
      t.root.id,
      "permissions.grant",
      { payload: s.payload(crm) },
      { status: 404, code: "NOT_FOUND", details: { reason: "unknown_holder" } }
    );
    await expect(
      t.stores.access.createGrant({
        clientInstanceId,
        holderKind: "service_principal",
        holderId: principal.id,
        action: "connection.use",
        effect: "allow",
        scopeKind: "asset",
        scopeId: crm,
        grantedBy: t.root.id
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND", details: { reason: "unknown_holder" } });
  });

  it("holds nothing through a row whose principal was removed around the store", async () => {
    const s = await setup();
    const crm = await s.t.seed("crm", forWorkflows);
    await s.grantTo(crm);
    await withTestSql((sql) => sql`delete from service_principals where id = ${s.principal.id}`);
    expect(await s.principalRows()).toHaveLength(1);

    const access = await createAuthorizer(s.t.stores.access).forActor(runIdentity(s.principal));

    expect(access.authorize("connection.use", { kind: "connection", assetId: crm })).toEqual({
      allowed: false,
      reason: "no_grant"
    });
  });
});
