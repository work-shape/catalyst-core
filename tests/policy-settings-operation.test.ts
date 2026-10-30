import { afterEach, describe, expect, it } from "vitest";
import { policiesSchema } from "@work-shape/catalyst-api-contract";
import {
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";

// Settings > Instance > Policies (OP-2): the central setting of an operation and the locks of
// "Always allow" are set through `policies.set` and `policies.set_always_allow_lock`, which
// require `policy.manage`. The next call reads them, without a restart. Each change is audited
// as a minimized event, and a lock of the release config cannot be lifted.

const instances: AccessInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((t) => t.instance.close()));
});

async function setup(locked: string[] = []) {
  const t = await setupAccessInstance({
    server: (_stores, config) => ({
      config: { ...config, policy: { ...config.policy, alwaysAllow: { locked } } }
    })
  });
  instances.push(t);
  return t;
}

async function audited(t: AccessInstance, type: string) {
  const events = await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 });
  return events.filter((event) => event.type === type);
}

const policies = async (t: AccessInstance) =>
  policiesSchema.parse((await t.expectOk(t.admin.id, "policies.get")).json());

describe("policies.set", () => {
  it("lists every operation in its kind, and a stored setting holds from the next call", async () => {
    const t = await setup();
    const before = await policies(t);
    expect(before.settings).toEqual([]);
    const row = before.operations.find(
      (operation) => operation.operation === "platform.context.get"
    );
    expect(row).toMatchObject({ kind: "platform", effect: "reading", value: "allow" });
    expect(before.operations.some((operation) => operation.operation === "policies.set")).toBe(
      true
    );

    await t.expectOk(t.kai.id, "platform.context.get");
    await t.expectOk(t.admin.id, "policies.set", {
      payload: { operation: "platform.context.get", value: "deny" }
    });
    await t.expectRefused(
      t.kai.id,
      "platform.context.get",
      {},
      { status: 403, code: "POLICY_DENIED" }
    );
    const after = await policies(t);
    expect(after.settings).toEqual([
      expect.objectContaining({ operation: "platform.context.get", value: "deny" })
    ]);
    expect(
      after.operations.find((operation) => operation.operation === "platform.context.get")
    ).toMatchObject({ value: "deny", source: "central_setting" });

    // Setting it again changes and records nothing; removing it lets the call run again.
    await t.expectOk(t.admin.id, "policies.set", {
      payload: { operation: "platform.context.get", value: "deny" }
    });
    await t.expectOk(t.admin.id, "policies.set", {
      payload: { operation: "platform.context.get", value: null }
    });
    await t.expectOk(t.kai.id, "platform.context.get");

    const changes = await audited(t, "governance.policy_setting_changed");
    expect(
      changes.map((event) => ({ actor: event.actor?.userId, metadata: event.metadata }))
    ).toEqual(
      expect.arrayContaining([
        {
          actor: t.admin.id,
          metadata: expect.objectContaining({
            operation: "platform.context.get",
            before: "default",
            after: "deny"
          })
        },
        {
          actor: t.admin.id,
          metadata: expect.objectContaining({
            operation: "platform.context.get",
            before: "deny",
            after: "default"
          })
        }
      ])
    );
    expect(changes).toHaveLength(2);
  });

  it("narrows a setting to a shared workspace and names it", async () => {
    const t = await setup();
    const team = await t.sharedWorkspace("Team");
    await t.expectOk(t.admin.id, "policies.set", {
      payload: { operation: "assets.*", workspaceId: team, value: "approval" }
    });
    expect((await policies(t)).settings).toEqual([
      expect.objectContaining({
        operation: "assets.*",
        workspaceId: team,
        workspaceName: "Team",
        value: "approval"
      })
    ]);
    await t.expectRefused(
      t.admin.id,
      "policies.set",
      { payload: { operation: "assets.*", workspaceId: "cws_missing", value: "deny" } },
      { status: 404, code: "NOT_FOUND" }
    );
  });

  it("refuses an unknown operation, a wait on a reading one, and the screen's own", async () => {
    const t = await setup();
    const refused = (operation: string, value: string, reason: string) =>
      t.expectRefused(
        t.admin.id,
        "policies.set",
        { payload: { operation, value } },
        { status: 422, code: "VALIDATION_FAILED", details: expect.objectContaining({ reason }) }
      );
    await refused("nothing.here", "deny", "unknown_operation");
    await refused("platform.context.get", "confirm", "reading_operation_waits");
    await refused("policies.set", "deny", "policy_names_itself");
    await refused("policies.*", "deny", "policy_names_itself");
    expect(await t.stores.centralPolicySettings.list({ clientInstanceId })).toEqual([]);
  });

  it("refuses a person without policy.manage", async () => {
    const t = await setup();
    await t.expectRefused(t.kai.id, "policies.get", {}, { status: 403, code: "FORBIDDEN" });
    await t.expectRefused(
      t.kai.id,
      "policies.set",
      { payload: { operation: "platform.context.get", value: "deny" } },
      { status: 403, code: "FORBIDDEN" }
    );
    await t.expectRefused(
      t.kai.id,
      "policies.set_always_allow_lock",
      { payload: { operation: "me.chat_skills.set", locked: true } },
      { status: 403, code: "FORBIDDEN" }
    );
    expect(await t.stores.centralPolicySettings.list({ clientInstanceId })).toEqual([]);
    expect(await audited(t, "governance.policy_setting_changed")).toEqual([]);
  });
});

describe("policies.set_always_allow_lock", () => {
  it("locks and lifts an instance lock, audited, and cannot lift one of the release config", async () => {
    const t = await setup(["me.chat_skills.set"]);
    const first = await policies(t);
    expect(first.locks).toEqual([{ operation: "me.chat_skills.set", source: "release" }]);

    await t.expectRefused(
      t.admin.id,
      "policies.set_always_allow_lock",
      { payload: { operation: "me.chat_skills.set", locked: false } },
      {
        status: 403,
        code: "FORBIDDEN",
        details: expect.objectContaining({ reason: "locked_by_release" })
      }
    );

    await t.expectOk(t.admin.id, "policies.set_always_allow_lock", {
      payload: { operation: "me.*", locked: true }
    });
    expect((await policies(t)).locks).toEqual(
      expect.arrayContaining([
        { operation: "me.chat_skills.set", source: "release" },
        expect.objectContaining({ operation: "me.*", source: "instance" })
      ])
    );
    await t.expectOk(t.admin.id, "policies.set_always_allow_lock", {
      payload: { operation: "me.*", locked: false }
    });
    expect(await t.stores.centralPolicySettings.listLocks({ clientInstanceId })).toEqual([]);

    const changes = await audited(t, "governance.always_allow_lock_changed");
    expect(changes.map((event) => event.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "me.*", locked: true }),
        expect.objectContaining({ operation: "me.*", locked: false })
      ])
    );
    expect(changes).toHaveLength(2);
  });
});
