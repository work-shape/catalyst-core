import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { platformContextSchema } from "@work-shape/catalyst-api-contract";
import { asUserId } from "@work-shape/catalyst-core";
import {
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";

// Access acceptance check 40 (RIGHTS-1e): deleting a user, retrying a job and seeing how the
// instance runs are the rights `users.delete`, `jobs.retry` and `system.view`, held by
// `superadmin` by default and given on by who holds them. Deleting stays under the rule on the
// account deleted, and a superadmin's account stays a superadmin's (the named list).

const instances: AccessInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((t) => t.instance.close()));
});

async function setup(): Promise<AccessInstance> {
  const t = await setupAccessInstance();
  instances.push(t);
  return t;
}

const give = (holderId: string, action: string) => ({
  payload: { holderKind: "user", holderId, action, scopeKind: "instance" }
});

async function stillThere(t: AccessInstance, userId: string): Promise<boolean> {
  const user = await t.stores.users.getUser({ clientInstanceId, userId: asUserId(userId) });
  return user !== undefined && user.status === "active";
}

describe("users.delete", () => {
  it("lets a person granted it delete an account whose rights they hold, and never a superadmin's", async () => {
    const t = await setup();
    // An admin does not hold it by default, and so cannot give it either.
    await t.expectRefused(
      t.admin.id,
      "users.delete",
      { params: { userId: t.kai.id } },
      t.forbidden("users.delete", "no_grant")
    );
    await t.expectRefused(
      t.admin.id,
      "permissions.grant",
      give(t.lena.id, "users.delete"),
      t.forbidden("users.delete", "no_grant")
    );
    expect(await stillThere(t, t.kai.id)).toBe(true);

    await t.expectOk(t.root.id, "permissions.grant", give(t.admin.id, "users.delete"));
    await t.expectOk(t.admin.id, "users.delete", { params: { userId: t.kai.id } });
    expect(await stillThere(t, t.kai.id)).toBe(false);

    const refused = await t.call(t.admin.id, "users.delete", { params: { userId: t.root.id } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      error: { message: "Only a superadmin may change a superadmin" }
    });
    expect(await stillThere(t, t.root.id)).toBe(true);
  });

  it("refuses a holder who lacks a right the account holds", async () => {
    const t = await setup();
    // Lena may manage users and delete them, and holds nothing else: the admin's account holds
    // rights she does not.
    await t.expectOk(t.root.id, "users.update", {
      params: { userId: t.lena.id },
      payload: { permissions: ["users.manage"] }
    });
    await t.expectOk(t.root.id, "permissions.grant", give(t.lena.id, "users.delete"));

    const refused = await t.call(t.lena.id, "users.delete", { params: { userId: t.admin.id } });

    expect(refused.statusCode).toBe(403);
    expect(await stillThere(t, t.admin.id)).toBe(true);
    // An account that holds nothing she lacks is hers to delete.
    await t.expectOk(t.lena.id, "users.delete", { params: { userId: t.kai.id } });
  });
});

describe("jobs.retry", () => {
  it("is given only by who holds it, and the platform context tells its holder", async () => {
    const t = await setup();
    const instanceActions = async (userId: string) =>
      platformContextSchema.parse((await t.expectOk(userId, "platform.context.get")).json())
        .instanceActions;

    expect(await instanceActions(t.admin.id)).not.toContain("jobs.retry");
    expect(await instanceActions(t.root.id)).toContain("jobs.retry");
    await t.expectRefused(
      t.admin.id,
      "permissions.grant",
      give(t.kai.id, "jobs.retry"),
      t.forbidden("jobs.retry", "no_grant")
    );

    await t.expectOk(t.root.id, "permissions.grant", give(t.kai.id, "jobs.retry"));

    expect(await instanceActions(t.kai.id)).toEqual(["jobs.retry"]);
  });
});

/** The reads behind the System pages of Settings: Jobs, Operations, Modules, Infrastructure. */
const SYSTEM_READS = [
  "instance.jobs.summary",
  "instance.jobs.list",
  "operations.list_runs",
  "instance.modules.list",
  "instance.infrastructure.get"
] as const;

describe("system.view", () => {
  it("keeps the System reads from an admin, by address too, and leaves them the audit log", async () => {
    const t = await setup();
    for (const operation of [...SYSTEM_READS, "instance.infrastructure.check"] as const) {
      await t.expectRefused(t.admin.id, operation, {}, t.forbidden("system.view", "no_grant"));
    }
    await t.expectOk(t.admin.id, "audit_events.list");
    await t.expectRefused(
      t.admin.id,
      "permissions.grant",
      give(t.kai.id, "system.view"),
      t.forbidden("system.view", "no_grant")
    );

    for (const operation of SYSTEM_READS) await t.expectOk(t.root.id, operation);
    await t.expectOk(t.root.id, "instance.infrastructure.check");
  });

  it("opens the System reads to a person granted it, and the platform context says so", async () => {
    const t = await setup();
    const instanceActions = async (userId: string) =>
      platformContextSchema.parse((await t.expectOk(userId, "platform.context.get")).json())
        .instanceActions;
    expect(await instanceActions(t.admin.id)).not.toContain("system.view");

    await t.expectOk(t.root.id, "permissions.grant", give(t.kai.id, "system.view"));

    expect(await instanceActions(t.kai.id)).toEqual(["system.view"]);
    for (const operation of SYSTEM_READS) await t.expectOk(t.kai.id, operation);
    // The audit log is not part of it.
    await t.expectRefused(t.kai.id, "audit_events.list", {}, t.forbidden("audit.view", "no_grant"));
  });

  it("leaves one Operation Run to its caller and to the audit log's readers", async () => {
    const t = await setup();
    await t.expectOk(t.root.id, "permissions.grant", give(t.kai.id, "system.view"));
    const runs = z
      .object({ items: z.array(z.object({ id: z.string() })) })
      .parse((await t.expectOk(t.root.id, "operations.list_runs")).json());
    const runId = runs.items[0]?.id;
    expect(runId).toBeDefined();

    // The admin reads it by `audit.view`, though the list is refused them.
    await t.expectOk(t.admin.id, "operations.get_run", { params: { runId: runId ?? "" } });
  });
});
