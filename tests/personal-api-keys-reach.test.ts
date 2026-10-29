import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  apiOperations,
  issueSessionTokenRequestSchema,
  operationPathParamNames,
  type Operation
} from "@work-shape/catalyst-api-contract";
import {
  PERSONAL_API_KEY_ACTIONS,
  operationScopesOfPersonalApiKey,
  personalApiKeyCovers,
  requirePersonalApiKeyScopes
} from "@work-shape/catalyst-core";
import { errorSchema, SERVICE_HEADER } from "./support/access-instance";
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
  "config_assets:publish",
  "infrastructure:check",
  // The use level of rows (CLI-PARITY-4), asked by four operations only, and of a start.
  "data_store_rows:use",
  "workflow_runs:use",
  // The read-only instance level (CLI-PARITY-6a): usage, audit, jobs, runs, Modules, infrastructure.
  "instance:inspect"
]);

function isTestOperation(name: string): name is TestOperationName {
  return Object.hasOwn(testOperations, name);
}

const namesSchema = z.object({ items: z.array(z.object({ name: z.string() })) });

describe("what a personal key reaches", () => {
  it("adds only the infrastructure check for system.view, never administration or the rows scopes beyond the use level", () => {
    expect(requirePersonalApiKeyScopes(["system.view"])).toEqual([{ action: "system.view" }]);
    expect(operationScopesOfPersonalApiKey(["system.view"])).toEqual([
      "me:read",
      "infrastructure:check",
      "instance:inspect"
    ]);
    expect(new Set(operationScopesOfPersonalApiKey(PERSONAL_API_KEY_ACTIONS))).toEqual(
      KEY_OPERATION_SCOPES
    );
    expect(
      Object.values<Operation>(apiOperations)
        .filter(
          (operation) =>
            operation.scope === "infrastructure:check" ||
            ("personalKeyScope" in operation &&
              operation.personalKeyScope === "infrastructure:check")
        )
        .map((operation) => operation.id)
    ).toEqual(["instance.infrastructure.check"]);
    expect(
      personalApiKeyCovers(["system.view:some-workspace"], "system.view", undefined, undefined)
    ).toBe(false);
    for (const scope of ["system.view:some-workspace", "system.view:some-workspace/store"]) {
      expect(() => requirePersonalApiKeyScopes([scope])).toThrow("no scope");
      expect(operationScopesOfPersonalApiKey([scope])).toEqual(["me:read"]);
    }
  });

  it("checks as the person with their current system.view right, never from the key's scope alone", async () => {
    const t = await setup();
    const create = await t.call(t.kai.id, "me.api_keys.create", {
      payload: { name: "Model checks", scopes: ["system.view"], expiresAt: inDays(1) }
    });
    expect(create.statusCode).toBe(422);
    expect(errorSchema.parse(create.json()).error.message).toContain("system.view");
    const grant = await t.expectOk(t.root.id, "permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: t.kai.id,
        action: "system.view",
        effect: "allow",
        scopeKind: "instance"
      }
    });
    const grantId = z.object({ id: z.string() }).parse(grant.json()).id;
    const headers = await t.tokenFor((await t.issue(["system.view"])).secret);
    await t.expectOk(t.kai.id, "instance.infrastructure.check", { headers });
    await t.expectOk(t.root.id, "permissions.revoke", { params: { grantId } });
    const denied = await t.expectOk(t.root.id, "permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: t.kai.id,
        action: "system.view",
        effect: "deny",
        scopeKind: "instance"
      }
    });
    const denyId = z.object({ id: z.string() }).parse(denied.json()).id;
    const deniedCheck = await t.call(t.kai.id, "instance.infrastructure.check", { headers });
    expect(deniedCheck.statusCode).toBe(403);
    expect(errorSchema.parse(deniedCheck.json()).error.details).toMatchObject({
      action: "system.view",
      reason: "denied"
    });
    await t.expectOk(t.root.id, "permissions.revoke", { params: { grantId: denyId } });
    const refused = await t.call(t.kai.id, "instance.infrastructure.check", { headers });
    expect(refused.statusCode).toBe(403);
    expect(errorSchema.parse(refused.json()).error).toMatchObject({
      message: expect.stringContaining("system.view"),
      details: { action: "system.view", reason: "no_grant" }
    });
  });

  it("requires a personal key's scope even for a superadmin and still refuses service keys", async () => {
    const t = await setup();
    const narrow = await t.tokenFor((await t.issue(["agent.read"], t.root.id)).secret);
    const refused = await t.call(t.root.id, "instance.infrastructure.check", { headers: narrow });
    expect(refused.statusCode).toBe(403);
    const headers = await t.tokenFor((await t.issue(["system.view"], t.root.id)).secret);
    await t.expectOk(t.root.id, "instance.infrastructure.check", { headers });
    // The infrastructure and Modules reads are the instance level's (CLI-PARITY-6a); the
    // routes beside them that retry or administer stay out of reach.
    for (const operation of ["instance.infrastructure.get", "instance.modules.list"] as const) {
      expect((await t.call(t.root.id, operation, { headers })).statusCode).toBe(200);
      expect((await t.call(t.root.id, operation, { headers: narrow })).statusCode).toBe(403);
    }
    const retry = await t.call(t.root.id, "instance.jobs.retry", {
      params: { jobId: "x" },
      headers
    });
    expect(retry.statusCode).toBe(403);
    const service = await t.call(t.root.id, "instance.infrastructure.check", {
      headers: { [SERVICE_HEADER]: "model-checker" }
    });
    expect(service.statusCode).toBe(403);
    expect(errorSchema.parse(service.json()).error.message).toBe(
      "Service principals cannot access user-scoped routes"
    );
  });

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
