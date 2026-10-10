import { describe, expect, it } from "vitest";
import type { CentralPolicySetting, PlatformEventEmitter } from "@vivd-catalyst/core";
import { agent, errorSchema, skill } from "./support/access-instance";
import { setupNamespaceHolder, type NamespaceHolderInstance } from "./support/asset-operations";

// What the policy is asked about for an asset call, and that it is asked only once the caller's
// right on every asset the call names is decided.

/** An instance with these admin settings, and the names of the events its calls emitted. */
async function setup(settings: CentralPolicySetting[]) {
  const emitted: string[] = [];
  const events: PlatformEventEmitter = {
    emit: (name) => {
      emitted.push(name);
      return Promise.resolve("allow");
    }
  };
  const approvalRequests: string[] = [];
  const t = await setupNamespaceHolder({
    operations: {
      centralPolicySettings: () => settings,
      events,
      approvals: {
        request: ({ run }) => {
          approvalRequests.push(run.id);
          return Promise.resolve({ approvalRequestId: `apr_${approvalRequests.length}` });
        }
      }
    }
  });
  for (const action of ["agent.read", "agent.write", "skill.read", "skill.write"]) {
    await t.grant(t.lena.id, action, { namespace: "lena-" });
  }
  return { t, emitted, approvalRequests };
}

const putItem = (kind: "agent" | "skill", name: string) => ({
  type: "put",
  kind,
  config: kind === "agent" ? agent(name) : skill(name)
});

async function sync(
  t: NamespaceHolderInstance,
  userId: string,
  namespace: string,
  items: unknown[]
) {
  const response = await t.call(userId, "assets.sync", { payload: { namespace, items } });
  return {
    status: response.statusCode,
    ...(response.statusCode === 200 ? {} : { code: errorSchema.parse(response.json()).error.code })
  };
}

const policyDenied = { status: 403, code: "POLICY_DENIED" };

describe("the policy of assets.sync", () => {
  it("is not asked for a batch with an item its caller may not make", async () => {
    const { t, emitted } = await setup([{ operation: "assets.sync", value: "deny" }]);

    // The batch is Kai's to make, so the policy is what refuses it.
    expect(await sync(t, t.kai.id, "kai-", [putItem("agent", "kai-intake")])).toEqual(policyDenied);
    // Lena holds nothing in `kai-`: she is told so, item by item, and never what the policy says.
    emitted.length = 0;
    const refused = await t.call(t.lena.id, "assets.sync", {
      payload: {
        namespace: "kai-",
        items: [putItem("agent", "kai-intake"), putItem("skill", "kai-guide")]
      }
    });
    expect(refused.statusCode).toBe(403);
    const { error } = errorSchema.parse(refused.json());
    expect(error.code).toBe("FORBIDDEN");
    expect(error.details).toMatchObject({
      reason: "sync_refused",
      items: [
        { index: 0, status: "refused", error: { code: "FORBIDDEN", action: "agent.write" } },
        { index: 1, status: "refused", error: { code: "FORBIDDEN", action: "skill.write" } }
      ]
    });
    // No guardrail was asked about the batch either.
    expect(emitted).not.toContain("operation.before_call");
    expect(await t.stored("agent", "kai-intake")).toBeUndefined();
  });

  it("applies a setting narrowed to a kind when one item of the batch is of that kind", async () => {
    const { t } = await setup([{ operation: "assets.sync", value: "deny", assetKind: "skill" }]);

    expect(
      await sync(t, t.kai.id, "kai-", [
        putItem("agent", "kai-intake"),
        putItem("skill", "kai-guide")
      ])
    ).toEqual(policyDenied);
    // Nothing of the batch was written.
    expect(await t.stored("agent", "kai-intake")).toBeUndefined();
    expect(await sync(t, t.kai.id, "kai-", [putItem("agent", "kai-intake")])).toEqual({
      status: 200
    });
    // A delete is a target of its kind as a put is.
    await t.put(t.admin.id, "skill", "kai-old");
    expect(
      await sync(t, t.admin.id, "kai-", [
        { type: "delete", kind: "skill", name: "kai-old", expectedRevision: 1 }
      ])
    ).toEqual(policyDenied);
    expect(await t.stored("skill", "kai-old")).toMatchObject({ status: "active" });
  });

  it("applies a setting narrowed to a Namespace to the batches of that Namespace alone", async () => {
    const { t } = await setup([{ operation: "assets.*", value: "deny", namespace: "kai-" }]);

    expect(await sync(t, t.kai.id, "kai-", [putItem("agent", "kai-intake")])).toEqual(policyDenied);
    expect(await sync(t, t.lena.id, "lena-", [putItem("agent", "lena-intake")])).toEqual({
      status: 200
    });
  });
});

describe("the further rights of assets.sync", () => {
  it("refuses a change of a model setting without its right before the policy is asked", async () => {
    const settings: CentralPolicySetting[] = [];
    const { t, emitted, approvalRequests } = await setup(settings);
    await t.put(t.admin.id, "agent", "kai-intake");
    // From here on every batch waits for an approval.
    settings.push({ operation: "assets.sync", value: "approval" });
    const batch = (overrides: Record<string, unknown>) =>
      t.call(t.kai.id, "assets.sync", {
        payload: {
          namespace: "kai-",
          items: [
            {
              type: "put",
              kind: "agent",
              config: agent("kai-intake", overrides),
              expectedRevision: 1
            }
          ]
        }
      });

    // Kai may write the agent, so a change of its instructions reaches the policy and waits.
    expect((await batch({ instructions: "Help well." })).statusCode).toBe(202);
    expect(approvalRequests).toHaveLength(1);
    // Its model is not his to choose: he is told so, and nothing was asked about the batch.
    emitted.length = 0;
    const refused = await batch({ modelProviderId: undefined, modelBindingId: "plain" });
    expect(refused.statusCode).toBe(403);
    const { error } = errorSchema.parse(refused.json());
    expect(error.code).toBe("FORBIDDEN");
    expect(error.details).toMatchObject({
      reason: "sync_refused",
      items: [
        { index: 0, status: "refused", error: { code: "FORBIDDEN", action: "agent_models.manage" } }
      ]
    });
    expect(emitted).not.toContain("operation.before_call");
    expect(approvalRequests).toHaveLength(1);
    expect(await t.stored("agent", "kai-intake")).toMatchObject({ revision: 1 });
  });
});

describe("the policy of a call on one asset", () => {
  it("applies a setting narrowed to the Namespace of the asset the call names", async () => {
    const { t } = await setup([{ operation: "assets.*", value: "deny", namespace: "kai-" }]);
    const address = (name: string) => ({ params: { kind: "agent", name } });
    const put = (userId: string, name: string) =>
      t.call(userId, "assets.put", { ...address(name), payload: { config: agent(name) } });
    const denied = { status: 403, code: "POLICY_DENIED" };

    expect((await put(t.lena.id, "lena-intake")).statusCode).toBe(200);
    expect((await put(t.admin.id, "plain")).statusCode).toBe(200);
    await t.expectRefused(
      t.kai.id,
      "assets.put",
      { ...address("kai-intake"), payload: { config: agent("kai-intake") } },
      denied
    );
    expect(await t.stored("agent", "kai-intake")).toBeUndefined();
    // Every operation that names one asset hands its Namespace over, the reading ones too.
    await t.expectRefused(t.kai.id, "assets.get", address("kai-intake"), denied);
    await t.expectRefused(t.kai.id, "assets.revisions.list", address("kai-intake"), denied);
    await t.expectRefused(
      t.kai.id,
      "assets.validate",
      { params: { kind: "agent" }, payload: { config: agent("kai-intake") } },
      denied
    );
    await t.expectRefused(
      t.kai.id,
      "assets.delete",
      { ...address("kai-intake"), payload: { expectedRevision: 1 } },
      denied
    );
    await t.expectRefused(
      t.kai.id,
      "assets.revert",
      { ...address("kai-intake"), payload: { revision: 1, expectedRevision: 1 } },
      denied
    );
    await t.expectOk(t.lena.id, "assets.get", address("lena-intake"));
    // The right is still asked first: a caller without it is not told what the policy says.
    await t.expectRefused(
      t.lena.id,
      "assets.get",
      address("kai-intake"),
      t.forbidden("agent.read", "no_grant")
    );
  });
});
