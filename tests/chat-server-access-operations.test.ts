import { describe, expect, it } from "vitest";
import { operationRunSchema } from "@work-shape/catalyst-api-contract";
import type { CentralPolicySetting } from "@work-shape/catalyst-core";
import {
  clientInstanceId,
  grantSchema,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import type { TestCallInput, TestOperationName } from "./support/operations";

// The three changing operations of grants and build limits as operations of the registry: the run
// each call leaves, the repeated call, the rule for a superadmin's rows asked before the
// policy, and the policy itself. What each call writes and refuses is in
// `chat-server-access-administration.test.ts`.

/** An instance with these admin settings, and how often a call asked for them. */
async function setup(settings: CentralPolicySetting[] = []) {
  const asked = { policy: 0 };
  const t = await setupAccessInstance({
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
    const { t } = await setup();
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
    const { t } = await setup();
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
    const { t } = await setup();
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
    const { t } = await setup();
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
    const { t, asked } = await setup();
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
    const { t, asked } = await setup();
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
    const { t } = await setup([
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
    const { t } = await setup([{ operation: "permissions.grant", value: "approval" }]);
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
