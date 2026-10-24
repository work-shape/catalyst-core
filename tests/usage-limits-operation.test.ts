import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { apiOperations, ownUsageSchema } from "@work-shape/catalyst-api-contract";
import { runCli } from "@work-shape/catalyst-cli";
import { asUserId, type UsageRateCardConfig } from "@work-shape/catalyst-core";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import {
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { createTestFetch } from "./support/test-instance";

// The spend limits' operation (LU-2, limits spec 3.1, acceptance checks 5 to 7): one registered
// operation for the screen, the API and the CLI, the right `limits.manage`, the release config
// as the ceiling, and an audit record of each change with its old and new value.

const rateCard: UsageRateCardConfig = {
  id: "customer",
  version: "2026-10",
  currency: "EUR",
  models: [
    {
      providerId: "local",
      model: "local",
      uncachedInputPricePerMillionTokens: 2,
      cachedInputPricePerMillionTokens: 0.5,
      outputPricePerMillionTokens: 8
    }
  ]
};
const CEILING = { dailySpendLimit: 50, monthlySpendLimit: 500 };

const instances: AccessInstance[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((t) => t.instance.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function setup() {
  const t = await setupAccessInstance({
    server: (stores) => ({
      usageGovernance: new ModelUsageGovernance({
        store: stores.usage,
        costs: { customer: rateCard },
        budget: CEILING,
        safeguards: {}
      })
    })
  });
  instances.push(t);
  return t;
}

/** What the audit log holds of one type. */
async function audited(t: AccessInstance, type: string) {
  const events = await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 });
  return events.filter((event) => event.type === type);
}

/** The CLI as the named person signed in with a personal key, against the test instance. */
async function cli(t: AccessInstance, userId: string, args: string[], stdin = "") {
  const cwd = await mkdtemp(join(tmpdir(), "cli-limits-"));
  directories.push(cwd);
  const forward = createTestFetch(t.instance, {
    "x-test-user": userId,
    "x-test-key": "personal"
  });
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli([...args, "--instance", "https://catalyst.test"], {
    cwd,
    env: { CATALYST_API_KEY: "test-cli-key" },
    stdin: Readable.from([stdin]),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    fetchImpl: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === apiOperations["access_tokens.exchange"].path) {
        return Response.json({
          accessToken: "test-access-token",
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        });
      }
      // The test instance signs in by its own header and refuses a bearer token beside it.
      const headers = new Headers(request.headers);
      headers.delete("authorization");
      return forward(new Request(request, { headers }));
    }
  });
  return { code, out: out.join(""), err: err.join("") };
}

describe("usage.limits.set", () => {
  it("records each change with the actor, the old and the new value", async () => {
    const t = await setup();
    const set = (limits: { monthly?: number; daily?: number } | null) =>
      t.expectOk(t.admin.id, "usage.limits.set", {
        payload: { level: "user", target: t.kai.id, limits }
      });

    await set({ monthly: 50 });
    await set({ monthly: 80, daily: 5 });
    // The same value again changes nothing and records nothing.
    await set({ monthly: 80, daily: 5 });
    await set(null);

    const changes = await audited(t, "governance.usage_limit_changed");
    expect(changes).toHaveLength(3);
    expect(changes.map((event) => ({ actor: event.actor, metadata: event.metadata }))).toEqual(
      expect.arrayContaining([
        {
          actor: expect.objectContaining({ userId: t.admin.id }),
          metadata: expect.objectContaining({
            level: "user",
            target: t.kai.id,
            previous: null,
            next: { monthly: 50 }
          })
        },
        {
          actor: expect.objectContaining({ userId: t.admin.id }),
          metadata: expect.objectContaining({
            level: "user",
            target: t.kai.id,
            previous: { monthly: 50 },
            next: { daily: 5, monthly: 80 }
          })
        },
        {
          actor: expect.objectContaining({ userId: t.admin.id }),
          metadata: expect.objectContaining({
            level: "user",
            target: t.kai.id,
            previous: { daily: 5, monthly: 80 },
            next: null
          })
        }
      ])
    );
  });

  it("refuses an instance limit above the release config and takes one at it", async () => {
    const t = await setup();
    await t.expectRefused(
      t.admin.id,
      "usage.limits.set",
      { payload: { level: "instance", limits: { monthly: 501 } } },
      {
        status: 422,
        code: "VALIDATION_FAILED",
        details: { reason: "above_ceiling", period: "monthly", ceiling: 500 }
      }
    );
    await t.expectOk(t.admin.id, "usage.limits.set", {
      payload: { level: "instance", limits: { daily: 20, monthly: 500 } }
    });
    const limits = await t.expectOk(t.admin.id, "usage.limits.get");
    expect(limits.json()).toMatchObject({
      currency: "EUR",
      ceiling: { daily: 50, monthly: 500 },
      instance: { daily: 20, monthly: 500 },
      effectiveInstance: { daily: 20, monthly: 500 }
    });
  });

  it("takes a workspace value only for a shared workspace", async () => {
    const t = await setup();
    const personal = await t.stores.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: asUserId(t.kai.id)
    });
    await t.expectRefused(
      t.admin.id,
      "usage.limits.set",
      { payload: { level: "workspace", target: personal.id, limits: { daily: 1 } } },
      { status: 404, code: "NOT_FOUND", details: { reason: "workspace_not_found" } }
    );
    const team = await t.sharedWorkspace("Team");
    await t.expectOk(t.admin.id, "usage.limits.set", {
      payload: { level: "workspace", target: team, limits: { daily: 1 } }
    });
    const limits = await t.expectOk(t.admin.id, "usage.limits.get");
    expect(limits.json()).toMatchObject({
      workspaces: [{ id: team, name: "Team", daily: 1 }]
    });
  });

  it("refuses a workspace owner without limits.manage through the API and the CLI, audited", async () => {
    const t = await setup();
    const owned = await t.stores.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Kai's team",
      creatorUserId: asUserId(t.kai.id)
    });
    const change = { level: "workspace", target: owned.id, limits: { daily: 1000 } };

    for (const operation of ["usage.limits.set", "usage.limits.get"] as const) {
      await t.expectRefused(
        t.kai.id,
        operation,
        operation === "usage.limits.set" ? { payload: change } : {},
        { status: 403, code: "FORBIDDEN" }
      );
    }
    const viaCli = await cli(t, t.kai.id, ["limits", "set", "--from", "-"], JSON.stringify(change));
    expect(viaCli.code).toBe(1);
    expect(viaCli.out).toBe("");
    expect(viaCli.err).toContain("Refused by the instance (HTTP 403 FORBIDDEN)");
    const shown = await cli(t, t.kai.id, ["limits", "show"]);
    expect(shown.code).toBe(1);

    const denied = await audited(t, "operation.denied");
    expect(
      denied
        .filter((event) => event.actor?.userId === t.kai.id)
        .map((event) => event.metadata?.operation)
    ).toEqual(expect.arrayContaining(["usage.limits.set", "usage.limits.get"]));
    // The refused change from the screen (a signed-in user) and from the CLI, by their origin.
    expect(
      denied
        .filter(
          (event) =>
            event.actor?.userId === t.kai.id && event.metadata?.operation === "usage.limits.set"
        )
        .map((event) => event.metadata?.origin)
        .sort()
    ).toEqual(["cli", "user"]);
    expect(await t.stores.usage.listSpendLimits({ clientInstanceId })).toEqual([]);
    expect(await audited(t, "governance.usage_limit_changed")).toEqual([]);
  });

  it("lets an admin set and read limits through the CLI", async () => {
    const t = await setup();
    const set = await cli(
      t,
      t.admin.id,
      ["limits", "set", "--from", "-", "--json"],
      JSON.stringify({ level: "user_default", limits: { monthly: 30 } })
    );
    expect(set, set.err).toMatchObject({ code: 0 });
    expect(JSON.parse(set.out)).toEqual({ level: "user_default", limits: { monthly: 30 } });
    const shown = await cli(t, t.admin.id, ["limits", "show", "--json"]);
    expect(shown.code, shown.err).toBe(0);
    expect(JSON.parse(shown.out)).toMatchObject({ userDefault: { monthly: 30 } });

    const malformed = await cli(t, t.admin.id, ["limits", "set", "--from", "-"], "{}");
    expect(malformed.code).toBe(2);
    expect(malformed.err).toContain("Limit input must be a JSON object");
  });
});

describe("me.usage.get", () => {
  it("shows a person their own amounts and a workspace's only to its owners and admins", async () => {
    const t = await setup();
    const team = await t.stores.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Team",
      creatorUserId: asUserId(t.kai.id)
    });
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: team.id,
      userId: asUserId(t.lena.id),
      role: "member"
    });
    await t.expectOk(t.admin.id, "usage.limits.set", {
      payload: { level: "user_default", limits: { monthly: 30 } }
    });
    await t.expectOk(t.admin.id, "usage.limits.set", {
      payload: { level: "workspace", target: team.id, limits: { daily: 10 } }
    });
    const read = async (userId: string) =>
      ownUsageSchema.parse(
        (await t.expectOk(userId, "me.usage.get", { query: { workspaceId: team.id } })).json()
      );

    const lena = await read(t.lena.id);
    expect(lena.own?.month).toMatchObject({ spent: 0, limit: 30 });
    expect(lena.workspace?.day).not.toHaveProperty("limit");
    expect(lena.workspace?.day).toMatchObject({ reached: false });
    expect(lena.instance?.day).not.toHaveProperty("spent");

    const kai = await read(t.kai.id);
    expect(kai.workspace?.day).toMatchObject({ spent: 0, limit: 10 });
    expect(kai.instance?.day).not.toHaveProperty("limit");

    // An admin who is no member of the workspace reads no workspace at all.
    const admin = await read(t.admin.id);
    expect(admin).not.toHaveProperty("workspace");
    expect(admin.instance?.month).toMatchObject({ spent: 0, limit: 500 });
  });
});
