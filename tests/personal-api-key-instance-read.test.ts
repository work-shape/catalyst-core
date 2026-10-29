import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PERSONAL_API_KEY_ACTIONS,
  PERSONAL_API_KEY_INSPECT_ACTIONS,
  operationScopesOfPersonalApiKey,
  parsePersonalApiKeyScope,
  requirePersonalApiKeyScopes
} from "@work-shape/catalyst-core";
import { clientInstanceId, errorSchema, type AccessInstance } from "./support/access-instance";
import { inDays, setupPersonalKeyInstance } from "./support/personal-api-keys";
import type { TestOperationName } from "./support/operations";

// CLI-PARITY-6a: the read-only instance level of a personal key. `usage.view`, `audit.view` and
// `system.view` let a key read usage, audit events, background jobs, Operation Runs, Modules and
// the infrastructure, each only while the owner holds the same right, and nothing else.

/** The read operations of the level, each with the right it needs. */
const READS = [
  ["usage.get_summary", "usage.view"],
  ["usage.breakdown.get", "usage.view"],
  ["audit_events.list", "audit.view"],
  ["audit_activities.list", "audit.view"],
  ["instance.jobs.summary", "system.view"],
  ["instance.jobs.list", "system.view"],
  ["operations.list_runs", "system.view"],
  ["instance.modules.list", "system.view"],
  ["instance.infrastructure.get", "system.view"]
] as const satisfies readonly (readonly [TestOperationName, string])[];

const BREAKDOWN = { from: "2026-10-01", to: "2026-10-08", groupBy: "model" } as const;
const queryOf = (operation: string) => (operation === "usage.breakdown.get" ? BREAKDOWN : {});

async function allow(t: AccessInstance, userId: string, action: string, effect = "allow") {
  const grant = await t.stores.access.createGrant({
    clientInstanceId,
    holderKind: "user",
    holderId: userId,
    action,
    effect: effect === "deny" ? "deny" : "allow",
    scopeKind: "instance",
    grantedBy: t.root.id
  });
  return grant.id;
}

async function read(
  t: Awaited<ReturnType<typeof setupPersonalKeyInstance>>,
  userId: string,
  operation: (typeof READS)[number][0],
  scopes: string[]
) {
  const headers = await t.tokenFor((await t.issue(scopes, userId)).secret);
  return t.call(userId, operation, { query: queryOf(operation), headers });
}

describe("the instance level of a personal key", () => {
  it("is three whole-instance read rights, in the scopes a key may name and never in a workspace", () => {
    expect([...PERSONAL_API_KEY_INSPECT_ACTIONS]).toEqual([
      "usage.view",
      "audit.view",
      "system.view"
    ]);
    for (const action of PERSONAL_API_KEY_INSPECT_ACTIONS) {
      expect(PERSONAL_API_KEY_ACTIONS).toContain(action);
      expect(requirePersonalApiKeyScopes([action])).toEqual([{ action }]);
      expect(operationScopesOfPersonalApiKey([action])).toContain("instance:inspect");
      // A workspace or an asset cannot narrow an instance right: such a scope is no scope.
      for (const narrowed of [`${action}:ws-1`, `${action}:ws-1/store`]) {
        expect(parsePersonalApiKeyScope(narrowed)).toBeUndefined();
        expect(() => requirePersonalApiKeyScopes([narrowed])).toThrow("no scope");
        expect(operationScopesOfPersonalApiKey([narrowed])).toEqual(["me:read"]);
      }
    }
    // Rights that decide, retry, change or administer stay out of a key's reach.
    for (const action of [
      "jobs.retry",
      "limits.manage",
      "usage.view_users",
      "users.manage",
      "api_access.manage",
      "agent_models.manage",
      "service_principals.manage",
      "operations.approve"
    ]) {
      expect(PERSONAL_API_KEY_ACTIONS).not.toContain(action);
      expect(operationScopesOfPersonalApiKey([action])).toEqual(["me:read"]);
    }
  });

  it("answers every read to a key that names its right, for a person who holds it", async () => {
    const t = await setupPersonalKeyInstance();
    for (const [operation, right] of READS) {
      const response = await read(t, t.root.id, operation, [right]);
      expect(response.statusCode, `${operation}: ${response.body}`).toBe(200);
    }
    // The page feeds keep their paging for the CLI.
    const headers = await t.tokenFor((await t.issue(["audit.view"], t.root.id)).secret);
    const page = await t.call(t.root.id, "audit_events.list", { query: { limit: 1 }, headers });
    expect(
      z.object({ items: z.array(z.object({ id: z.string() })) }).parse(page.json()).items
    ).toHaveLength(1);
  });

  it("refuses a key without the instance level, naming the right the read needs", async () => {
    const t = await setupPersonalKeyInstance();
    for (const [operation, right] of READS) {
      for (const scopes of [["agent.read"], ["agent.read", "agent.write"]]) {
        const response = await read(t, t.root.id, operation, scopes);
        expect(response.statusCode, `${operation}: ${response.body}`).toBe(403);
        const { error } = errorSchema.parse(response.json());
        expect(error.message).toContain(`'${right}'`);
        expect(error.message).toContain("instance level");
        expect(error.details).toEqual({ action: right, reason: "outside_key_scope" });
      }
    }
  });

  it("refuses a key that names another right of the level than the read needs", async () => {
    const t = await setupPersonalKeyInstance();
    for (const [operation, right] of READS) {
      const other = PERSONAL_API_KEY_INSPECT_ACTIONS.filter((action) => action !== right);
      const response = await read(t, t.root.id, operation, other);
      expect(response.statusCode, `${operation}: ${response.body}`).toBe(403);
      expect(errorSchema.parse(response.json()).error.details).toMatchObject({
        action: right,
        reason: "outside_key_scope"
      });
    }
  });

  it("gives a key no right its owner lacks: issuing it is refused, and a right lost ends the read", async () => {
    const t = await setupPersonalKeyInstance();
    // Kai holds none of the three rights.
    for (const right of PERSONAL_API_KEY_INSPECT_ACTIONS) {
      const create = await t.call(t.kai.id, "me.api_keys.create", {
        payload: { name: "Reader", scopes: [right], expiresAt: inDays(1) }
      });
      expect(create.statusCode, create.body).toBe(422);
      expect(errorSchema.parse(create.json()).error.message).toContain(right);
    }
    // Granted usage.view alone, Kai's key may name it and no other.
    const usageGrant = await allow(t, t.kai.id, "usage.view");
    const audit = await t.call(t.kai.id, "me.api_keys.create", {
      payload: { name: "Reader", scopes: ["usage.view", "audit.view"], expiresAt: inDays(1) }
    });
    expect(audit.statusCode, audit.body).toBe(422);
    const headers = await t.tokenFor((await t.issue(["usage.view"], t.kai.id)).secret);
    const summary = () => t.call(t.kai.id, "usage.get_summary", { headers });
    expect((await summary()).statusCode).toBe(200);
    // Audit events stay out of reach of that key and of that person.
    const events = await t.call(t.kai.id, "audit_events.list", { headers });
    expect(events.statusCode).toBe(403);
    // Losing the right takes it from the key on the very next call.
    await t.stores.access.deleteGrant({ clientInstanceId, grantId: usageGrant });
    const lost = await summary();
    expect(lost.statusCode, lost.body).toBe(403);
    expect(errorSchema.parse(lost.json()).error.details).toMatchObject({ action: "usage.view" });
    // A deny wins as it does for the person: the administrator holds usage.view by default.
    const admin = await t.tokenFor((await t.issue(["usage.view"], t.admin.id)).secret);
    const adminSummary = () => t.call(t.admin.id, "usage.get_summary", { headers: admin });
    expect((await adminSummary()).statusCode).toBe(200);
    await allow(t, t.admin.id, "usage.view", "deny");
    expect((await adminSummary()).statusCode).toBe(403);
  });

  it("is refused to a person who lacks the right even when the key was issued while they held it", async () => {
    const t = await setupPersonalKeyInstance();
    const grant = await allow(t, t.kai.id, "system.view");
    const headers = await t.tokenFor((await t.issue(["system.view"], t.kai.id)).secret);
    for (const operation of [
      "instance.jobs.list",
      "instance.jobs.summary",
      "operations.list_runs",
      "instance.modules.list",
      "instance.infrastructure.get"
    ] as const) {
      expect((await t.call(t.kai.id, operation, { headers })).statusCode).toBe(200);
    }
    await t.stores.access.deleteGrant({ clientInstanceId, grantId: grant });
    for (const operation of [
      "instance.jobs.list",
      "instance.jobs.summary",
      "operations.list_runs",
      "instance.modules.list",
      "instance.infrastructure.get"
    ] as const) {
      const response = await t.call(t.kai.id, operation, { headers });
      expect(response.statusCode, operation).toBe(403);
    }
  });

  it("reads and changes nothing beyond the nine reads, for the widest key a superadmin can issue", async () => {
    const t = await setupPersonalKeyInstance();
    const headers = await t.tokenFor(
      (await t.issue([...PERSONAL_API_KEY_INSPECT_ACTIONS], t.root.id)).secret
    );
    // Neither the retry of a job, nor a limit, nor the per-person usage, nor a decision.
    const refused: [TestOperationName, Record<string, string>][] = [
      ["instance.jobs.retry", { jobId: "x" }],
      ["usage.limits.get", {}],
      ["usage.limits.set", {}],
      ["usage.users.list", {}],
      ["operations.decide", { runId: "x" }],
      ["operations.list_callable", {}],
      ["users.list", {}],
      ["permissions.list", {}],
      ["service_principals.list", {}]
    ];
    for (const [operation, params] of refused) {
      const response = await t.call(t.root.id, operation, { params, headers });
      expect([403, 404], `${operation}: ${response.statusCode} ${response.body}`).toContain(
        response.statusCode
      );
      expect(response.statusCode, operation).not.toBe(200);
    }
  });

  it("shows governance events and never a payload in the audit feed", async () => {
    const t = await setupPersonalKeyInstance();
    const secretText = "PAYLOAD-MARKER-do-not-leak-4711";
    await t.putAgent(t.root.id, "reporter", { instructions: secretText });
    const headers = await t.tokenFor((await t.issue(["audit.view"], t.root.id)).secret);
    const events = await t.call(t.root.id, "audit_events.list", { query: { limit: 200 }, headers });
    expect(events.statusCode, events.body).toBe(200);
    const parsed = z
      .object({
        items: z.array(
          z.object({ type: z.string(), metadata: z.record(z.string(), z.unknown()).optional() })
        )
      })
      .parse(events.json());
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(events.body).not.toContain(secretText);
    const activities = await t.call(t.root.id, "audit_activities.list", { headers });
    expect(activities.statusCode, activities.body).toBe(200);
    expect(activities.body).not.toContain(secretText);
    // Reading the feed is itself an event, attributed to the owner and to the key.
    const after = await t.call(t.root.id, "audit_events.list", { query: { limit: 200 }, headers });
    expect(after.body).toContain("governance.audit_events_viewed");
  });

  it("lets a key with audit.view follow another person's Operation Run, and no other key", async () => {
    const t = await setupPersonalKeyInstance();
    // A run of Root's, read by the instance's list with system.view.
    const rootHeaders = await t.tokenFor((await t.issue(["system.view"], t.root.id)).secret);
    const runs = await t.call(t.root.id, "operations.list_runs", { headers: rootHeaders });
    expect(runs.statusCode, runs.body).toBe(200);
    const [first] = z
      .object({ items: z.array(z.object({ id: z.string() })) })
      .parse(runs.json()).items;
    expect(first, "the instance has at least one Operation Run").toBeDefined();
    const runId = first?.id ?? "";
    // Another person's key (the administrator holds audit.view by default): without audit.view
    // on the key the run does not exist for it.
    const plain = await t.tokenFor((await t.issue(["agent.read"], t.admin.id)).secret);
    const hidden = await t.call(t.admin.id, "operations.get_run", {
      params: { runId },
      headers: plain
    });
    expect(hidden.statusCode, hidden.body).toBe(404);
    const audit = await t.tokenFor((await t.issue(["audit.view"], t.admin.id)).secret);
    const seen = await t.call(t.admin.id, "operations.get_run", {
      params: { runId },
      headers: audit
    });
    expect(seen.statusCode, seen.body).toBe(200);
    expect(z.object({ id: z.string(), inputHash: z.string() }).parse(seen.json()).id).toBe(runId);
    // The owner's right decides: a person who lost audit.view reads no other person's run.
    const grant = await allow(t, t.kai.id, "audit.view");
    const kai = await t.tokenFor((await t.issue(["audit.view"], t.kai.id)).secret);
    const kaiSees = await t.call(t.kai.id, "operations.get_run", {
      params: { runId },
      headers: kai
    });
    expect(kaiSees.statusCode, kaiSees.body).toBe(200);
    await t.stores.access.deleteGrant({ clientInstanceId, grantId: grant });
    const kaiLost = await t.call(t.kai.id, "operations.get_run", {
      params: { runId },
      headers: kai
    });
    expect(kaiLost.statusCode, kaiLost.body).toBe(403);
    expect(errorSchema.parse(kaiLost.json()).error.details).toMatchObject({ action: "audit.view" });
    // No input and no result, only the hash of the input.
    expect(seen.json()).not.toHaveProperty("input");
    expect(seen.json()).not.toHaveProperty("result");
  });
});
