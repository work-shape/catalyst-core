import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  apiOperations,
  issueSessionTokenRequestSchema,
  operationPathParamNames
} from "@vivd-catalyst/api-contract";
import { PERSONAL_API_KEY_ACTIONS } from "@vivd-catalyst/core";
import { errorSchema } from "./support/access-instance";
import { testOperations, type TestOperationName } from "./support/operations";
import {
  agentConfig,
  grantKaiNamespace,
  inDays,
  setupPersonalKeyInstance as setup
} from "./support/personal-api-keys";

/** The operation scopes a personal key's calls may carry, whatever its own scopes name. */
const KEY_OPERATION_SCOPES = new Set([
  "me:read",
  "config_assets:read",
  "config_assets:write",
  "config_assets:publish"
]);

function isTestOperation(name: string): name is TestOperationName {
  return Object.hasOwn(testOperations, name);
}

const namesSchema = z.object({ items: z.array(z.object({ name: z.string() })) });

describe("what a personal key reaches", () => {
  it("is refused on every operation whose scope a key never carries, for a superadmin's widest key", async () => {
    const t = await setup();
    const { secret } = await t.issue([...PERSONAL_API_KEY_ACTIONS], t.root.id);
    const headers = await t.tokenFor(secret);
    const reached: string[] = [];
    let refused = 0;
    for (const [name, operation] of Object.entries(apiOperations)) {
      // A server credential is the instance's own secret, never a key.
      if (operation.auth === "public" || operation.auth === "serverCredential") continue;
      if (operation.scope === null || KEY_OPERATION_SCOPES.has(operation.scope)) continue;
      if ("personalKeyScope" in operation && KEY_OPERATION_SCOPES.has(operation.personalKeyScope))
        continue;
      if (!isTestOperation(name)) continue;
      const params = Object.fromEntries(
        operationPathParamNames(operation.path).map((param) => [param, "x"])
      );
      const response = await t.call(t.root.id, name, { params, headers });
      const error = errorSchema.safeParse(response.json());
      // A module that is off, or one this instance does not assemble, answers 404 before any
      // scope: the operation does not exist here.
      const absent =
        response.statusCode === 404 &&
        error.success &&
        (error.data.error.details?.["reason"] === "module_off" ||
          error.data.error.message === "Operation is not available");
      if (response.statusCode === 403) refused += 1;
      else if (!absent) reached.push(`${name} ${response.statusCode}`);
    }
    expect(reached).toEqual([]);
    // Users, grants, service principals, conversations, review queues, audit and more.
    expect(refused).toBeGreaterThan(80);
  });

  it("does not confirm a connect code, even with the owner signed in elsewhere", async () => {
    const t = await setup();
    await grantKaiNamespace(t);
    const headers = await t.tokenFor((await t.issue(["agent.read:kai-"])).secret);
    const started = z
      .object({ userCode: z.string(), deviceCode: z.string() })
      .parse((await t.instance.call("connect_codes.start", { payload: {} })).json());
    const confirm = await t.call(t.kai.id, "me.connect_codes.confirm", {
      params: { userCode: started.userCode },
      payload: { name: "x", scopes: ["agent.read:kai-"], expiresAt: inDays(1) },
      headers
    });
    expect(confirm.statusCode).toBe(403);
    const redeem = await t.instance.call("connect_codes.redeem", {
      payload: { deviceCode: started.deviceCode }
    });
    expect(redeem.json()).toEqual({ status: "pending" });
  });

  it("reads only its Namespace where the owner holds more than one", async () => {
    const t = await setup();
    await grantKaiNamespace(t);
    await t.createNamespace("lena-");
    for (const action of ["agent.read", "agent.write"]) {
      await t.grant(t.kai.id, action, { namespace: "lena-" });
    }
    await t.putAgent(t.kai.id, "kai-helper");
    await t.putAgent(t.kai.id, "lena-helper");
    const headers = await t.tokenFor(
      (await t.issue(["agent.read:kai-", "agent.write:kai-"])).secret
    );

    const listed = await t.call(t.kai.id, "assets.list", { params: { kind: "agent" }, headers });
    expect(namesSchema.parse(listed.json()).items.map((item) => item.name)).toEqual(["kai-helper"]);
    for (const [operation, input] of [
      ["assets.get", { params: { kind: "agent", name: "lena-helper" } }],
      ["assets.revisions.list", { params: { kind: "agent", name: "lena-helper" } }],
      ["assets.delete", { params: { kind: "agent", name: "lena-helper" } }],
      [
        "assets.put",
        {
          params: { kind: "agent", name: "lena-helper" },
          payload: { config: agentConfig("lena-helper") }
        }
      ],
      ["config_assets.get_overview", {}]
    ] as const) {
      const response = await t.call(t.kai.id, operation, { ...input, headers });
      expect([403, 404], `${operation}: ${response.body}`).toContain(response.statusCode);
    }
    // The owner, signed in themself, still reaches both.
    const own = await t.expectOk(t.kai.id, "assets.list", { params: { kind: "agent" } });
    expect(namesSchema.parse(own.json()).items.map((item) => item.name)).toEqual(
      expect.arrayContaining(["kai-helper", "lena-helper"])
    );
  });

  // A user whose delegated actor is a key is not resolved again by its sign-in; only the key's
  // own access token may name one, so a session token never does.
  it("cannot be claimed by a session token an embedding host issues", () => {
    const request = issueSessionTokenRequestSchema.safeParse({
      externalUserId: "kai",
      displayLabel: "Kai",
      delegatedActor: { kind: "api_key", id: "apic_x", displayLabel: "x", authSource: "x" }
    });
    expect(request.success).toBe(false);
  });
});
