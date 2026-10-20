import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  apiOperations,
  issueSessionTokenRequestSchema,
  operationPathParamNames
} from "@work-shape/catalyst-api-contract";
import { PERSONAL_API_KEY_ACTIONS } from "@work-shape/catalyst-core";
import { errorSchema } from "./support/access-instance";
import { testOperations, type TestOperationName } from "./support/operations";
import {
  agentConfig,
  grantKaiWorkspace,
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
  it("refuses Run live once over HTTP for a superadmin's key token, while asset reads still work", async () => {
    const t = await setup();
    await t.putAgent(t.root.id, "helper");
    const { secret } = await t.issue([...PERSONAL_API_KEY_ACTIONS], t.root.id);
    const headers = await t.tokenFor(secret);
    const params = { kind: "agent", name: "helper" };
    const refused = await t.call(t.root.id, "assets.run_live_once", {
      params,
      payload: { part: "send", expectedRevision: 1 },
      headers
    });
    expect(refused.statusCode).toBe(403);
    expect(errorSchema.parse(refused.json()).error).toMatchObject({
      code: "FORBIDDEN",
      message: "Run live once needs a person signed in to the app; API keys cannot use it",
      details: { reason: "user_only" }
    });
    await t.expectOk(t.root.id, "assets.get", { params, headers });
  });

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
    await grantKaiWorkspace(t);
    const headers = await t.tokenFor((await t.issue([`agent.read:${t.kaiTeam}`])).secret);
    const started = z
      .object({ userCode: z.string(), deviceCode: z.string() })
      .parse((await t.instance.call("connect_codes.start", { payload: {} })).json());
    const confirm = await t.call(t.kai.id, "me.connect_codes.confirm", {
      params: { userCode: started.userCode },
      payload: { name: "x", scopes: [`agent.read:${t.kaiTeam}`], expiresAt: inDays(1) },
      headers
    });
    expect(confirm.statusCode).toBe(403);
    const redeem = await t.instance.call("connect_codes.redeem", {
      payload: { deviceCode: started.deviceCode }
    });
    expect(redeem.json()).toEqual({ status: "pending" });
  });

  it("reads only its workspace where the owner holds rights in more than one", async () => {
    const t = await setup();
    await grantKaiWorkspace(t);
    const lenaTeam = await t.sharedWorkspace("Lena Spezis");
    for (const action of ["agent.read", "agent.write"]) {
      await t.grant(t.kai.id, action, { workspaceId: lenaTeam });
    }
    const putIn = (workspaceId: string, name: string, headers: Record<string, string> = {}) =>
      t.call(t.kai.id, "assets.put", {
        params: { kind: "agent", name },
        payload: { config: agentConfig(name), workspaceId },
        headers
      });
    expect((await putIn(t.kaiTeam, "kai-helper")).statusCode).toBe(200);
    expect((await putIn(lenaTeam, "lena-helper")).statusCode).toBe(200);
    const headers = await t.tokenFor(
      (await t.issue([`agent.read:${t.kaiTeam}`, `agent.write:${t.kaiTeam}`])).secret
    );
    const listIn = (workspaceId: string, signedIn: Record<string, string> = headers) =>
      t.call(t.kai.id, "assets.list", {
        params: { kind: "agent" },
        query: { workspaceId },
        headers: signedIn
      });

    const listed = await listIn(t.kaiTeam);
    expect(namesSchema.parse(listed.json()).items.map((item) => item.name)).toEqual(["kai-helper"]);
    expect(namesSchema.parse((await listIn(lenaTeam)).json()).items).toEqual([]);
    for (const [operation, input] of [
      [
        "assets.get",
        { params: { kind: "agent", name: "lena-helper" }, query: { workspaceId: lenaTeam } }
      ],
      [
        "assets.revisions.list",
        { params: { kind: "agent", name: "lena-helper" }, query: { workspaceId: lenaTeam } }
      ],
      [
        "assets.delete",
        { params: { kind: "agent", name: "lena-helper" }, payload: { workspaceId: lenaTeam } }
      ],
      [
        "assets.put",
        {
          params: { kind: "agent", name: "lena-helper" },
          payload: { config: agentConfig("lena-helper"), workspaceId: lenaTeam }
        }
      ],
      ["config_assets.get_overview", {}]
    ] as const) {
      const response = await t.call(t.kai.id, operation, { ...input, headers });
      expect([403, 404], `${operation}: ${response.body}`).toContain(response.statusCode);
    }
    // The owner, signed in themself, still reaches both.
    for (const [workspaceId, name] of [
      [t.kaiTeam, "kai-helper"],
      [lenaTeam, "lena-helper"]
    ] as const) {
      const own = await listIn(workspaceId, {});
      expect(own.statusCode).toBe(200);
      expect(namesSchema.parse(own.json()).items.map((item) => item.name)).toEqual([name]);
    }
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
