import { describe, expect, it } from "vitest";
import { ApiError } from "@vivd-catalyst/api-client";
import {
  configAssetsOverviewSchema,
  effectivePermissionsSchema,
  permissionGrantSchema
} from "@vivd-catalyst/api-contract";
import { accessWriteFailure, checkAsset, checkedAssetId } from "@vivd-catalyst/chat-ui/access";
import { asUserId } from "@vivd-catalyst/core";
import { z } from "zod";
import {
  clientInstanceId,
  setupAccessInstance as setup,
  type AccessInstance
} from "./support/access-instance";

// What the Access page says, held against what the server does: the Check tab's verdicts
// against real reads, writes and deletes, and the page's reading of a refusal against the
// refusal the server sends.

const grantList = z.object({ items: z.array(permissionGrantSchema) });

/** The Check tab's verdicts for one holder and agent, from the answers the page loads. */
async function verdicts(t: AccessInstance, holderId: string, name: string) {
  const [effective, grants, overview] = await Promise.all([
    t.expectOk(t.admin.id, "permissions.effective", {
      query: { holderKind: "user", holderId }
    }),
    t.expectOk(t.admin.id, "permissions.list", { query: { holderKind: "user", holderId } }),
    t.expectOk(t.admin.id, "config_assets.get_overview")
  ]);
  const asset = { kind: "agent", name } as const;
  return checkAsset(
    effectivePermissionsSchema.parse(effective.json()),
    asset,
    checkedAssetId(
      asset,
      configAssetsOverviewSchema.parse(overview.json()).assets,
      grantList.parse(grants.json()).items
    )
  );
}

/**
 * Reads, saves and deletes the agent as the holder and holds each answer against the verdict.
 * An answer that says the agent is not there decides nothing about the right and is skipped.
 */
async function expectVerdictsHold(t: AccessInstance, holderId: string, name: string) {
  const said = await verdicts(t, holderId, name);
  const params = { kind: "agent", name };
  const calls = {
    read: () => t.call(holderId, "assets.get", { params }),
    write: () => t.putAgent(holderId, name, { instructions: `Changed for ${holderId}.` }),
    delete: () => t.call(holderId, "assets.delete", { params, payload: {} })
  };
  const compared: string[] = [];
  for (const verdict of said) {
    const response = await calls[verdict.verb]();
    if (response.statusCode === 404) {
      continue;
    }
    expect(
      { verb: verdict.verb, allowed: response.statusCode === 200 },
      `${verdict.verb} ${name}: ${response.body}`
    ).toEqual({ verb: verdict.verb, allowed: verdict.allowed });
    compared.push(verdict.verb);
  }
  return { said, compared };
}

describe("the Check tab against real asset calls", () => {
  it("agrees for a grant in a Namespace", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    for (const action of ["agent.read", "agent.write", "agent.delete"]) {
      await t.grant(t.kai.id, action, { namespace: "kai-" });
    }
    expect((await t.putAgent(t.admin.id, "kai-helper")).statusCode).toBe(200);
    expect((await t.putAgent(t.admin.id, "other-helper")).statusCode).toBe(200);

    const inside = await expectVerdictsHold(t, t.kai.id, "kai-helper");
    expect(inside.said.map((verdict) => verdict.allowed)).toEqual([true, true, true]);
    expect(inside.compared).toEqual(["read", "write", "delete"]);
    const outside = await expectVerdictsHold(t, t.kai.id, "other-helper");
    expect(outside.said.map((verdict) => verdict.reason)).toEqual([
      "no_grant",
      "no_grant",
      "no_grant"
    ]);
    expect(outside.compared).toEqual(["read", "write", "delete"]);
  });

  it("agrees for an allow on one asset", async () => {
    const t = await setup();
    expect((await t.putAgent(t.admin.id, "team-bot")).statusCode).toBe(200);
    const assetId = await t.assetId("agent", "team-bot");
    await t.grant(t.lena.id, "agent.read", { assetId });
    await t.grant(t.lena.id, "agent.write", { assetId });

    const { said, compared } = await expectVerdictsHold(t, t.lena.id, "team-bot");
    expect(said.map((verdict) => verdict.allowed)).toEqual([true, true, false]);
    expect(compared).toEqual(["read", "write", "delete"]);
  });

  it("agrees for a deny on one asset, which also refuses the delete", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    for (const action of ["agent.read", "agent.write", "agent.delete"]) {
      await t.grant(t.kai.id, action, { namespace: "kai-" });
    }
    expect((await t.putAgent(t.admin.id, "kai-helper")).statusCode).toBe(200);
    await t.grant(
      t.kai.id,
      "agent.write",
      { assetId: await t.assetId("agent", "kai-helper") },
      "deny"
    );

    const { said, compared } = await expectVerdictsHold(t, t.kai.id, "kai-helper");
    expect(said.map((verdict) => [verdict.allowed, verdict.reason])).toEqual([
      [true, "grant"],
      [false, "deny"],
      [false, "deny"]
    ]);
    expect(compared).toEqual(["read", "write", "delete"]);
  });

  it("agrees for a deny that outlived its asset", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });
    expect((await t.putAgent(t.admin.id, "kai-old")).statusCode).toBe(200);
    await t.grant(
      t.kai.id,
      "agent.write",
      { assetId: await t.assetId("agent", "kai-old") },
      "deny"
    );
    await t.expectOk(t.admin.id, "assets.delete", {
      params: { kind: "agent", name: "kai-old" },
      payload: {}
    });

    // The Namespace row would let Kai create the name again; the deny on the name refuses it.
    const { said, compared } = await expectVerdictsHold(t, t.kai.id, "kai-old");
    expect(said.find((verdict) => verdict.verb === "write")).toMatchObject({
      allowed: false,
      reason: "deny"
    });
    expect(compared).toContain("write");
  });
});

describe("the page's reading of a refused grant", () => {
  it("reads the refusal for a user being deleted as that, and shows no other sentence", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    await t.stores.users.markUserDeletionRequested({
      clientInstanceId,
      userId: asUserId(t.kai.id)
    });
    const response = await t.call(t.admin.id, "permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: t.kai.id,
        action: "agent.write",
        scopeKind: "namespace",
        namespace: "kai-"
      }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "CONFLICT", message: "User account is being deleted" }
    });
    expect(accessWriteFailure(new ApiError(response.statusCode, "refused", response.json()))).toBe(
      "userBeingDeleted"
    );
  });

  it("tells a row that exists already from every other conflict", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });
    const response = await t.call(t.admin.id, "permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: t.kai.id,
        action: "agent.write",
        scopeKind: "namespace",
        namespace: "kai-"
      }
    });
    expect(response.statusCode).toBe(409);
    expect(accessWriteFailure(new ApiError(response.statusCode, "refused", response.json()))).toBe(
      "duplicateGrant"
    );
  });
});
