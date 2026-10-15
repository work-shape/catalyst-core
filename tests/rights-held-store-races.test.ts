import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import type { PlatformStores } from "@vivd-catalyst/core";
import { clientInstanceId, setupAccessInstance } from "./support/access-instance";
import { holdTransaction, settled } from "./support/postgres-concurrency-harness";
import { fileTestDatabaseUrl } from "./support/test-database";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function observer(): Promise<postgres.Sql> {
  const sql = postgres(await fileTestDatabaseUrl(), { max: 2 });
  closers.push(() => sql.end());
  return sql;
}

/** Wait for this database's writer, or fail immediately if it bypasses the held lock. */
async function untilBlocked(sql: postgres.Sql, finished: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [row] = await sql<Array<{ waiting: number }>>`
      select count(*)::int as waiting from pg_stat_activity
      where datname = current_database() and cardinality(pg_blocking_pids(pid)) > 0`;
    if ((row?.waiting ?? 0) > 0) return;
    if (finished()) throw new Error("The writer completed without waiting for the rights lock");
    if (Date.now() > deadline) throw new Error("The writer never waited for the rights lock");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("deletion admission under the rights locks", () => {
  it.each(["superadmin", "users.manage"] as const)(
    "refuses deletion when the caller lost %s before the marking transaction",
    async (lost) => {
      const t = await setupAccessInstance();
      const transaction: PlatformStores["transaction"] = t.stores.transaction.bind(t.stores);
      t.stores.transaction = async (fn) => {
        t.stores.transaction = transaction;
        if (lost === "superadmin") {
          // Keep users.manage so that the fresh actor, rather than only the access read, matters.
          await t.stores.users.updateUser({
            clientInstanceId,
            userId: t.root.id,
            roles: ["user", "admin"]
          });
        } else {
          // Keep the superadmin role so only reloading access can see this refusal.
          await t.stores.access.createGrant({
            clientInstanceId,
            holderKind: "user",
            holderId: t.root.id,
            action: "users.manage",
            effect: "deny",
            scopeKind: "instance",
            grantedBy: t.root.id
          });
        }
        return transaction(fn);
      };
      const response = await t.call(t.root.id, "users.delete", { params: { userId: t.lena.id } });
      expect(response.statusCode).toBe(403);
      expect(await t.stores.users.getUser({ clientInstanceId, userId: t.lena.id })).toMatchObject({
        status: "active"
      });
    }
  );
});

describe("an identity keeps its owner", () => {
  it.each(["manager", "superadmin"] as const)(
    "refuses a silent move from a superadmin even for a %s",
    async (caller) => {
      const t = await setupAccessInstance();
      const manager = await t.stores.users.createUser({
        clientInstanceId,
        displayLabel: "Manager",
        roles: ["user"],
        permissions: ["users.manage"]
      });
      const identity = { authSource: "oidc", externalUserId: "existing-root-sign-in" };
      await t.stores.users.upsertUserIdentity({ clientInstanceId, userId: t.root.id, ...identity });
      const response = await t.call(
        caller === "manager" ? manager.id : t.root.id,
        "users.identities.upsert",
        {
          params: { userId: t.lena.id },
          payload: identity
        }
      );
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: "CONFLICT", details: { reason: "identity_already_linked" } }
      });
      expect(
        (await t.stores.users.getUser({ clientInstanceId, userId: t.root.id }))?.identities
      ).toHaveLength(1);
      expect(
        (await t.stores.users.getUser({ clientInstanceId, userId: t.lena.id }))?.identities
      ).toEqual([]);
    }
  );

  it("refuses a direct store move and still updates an identity on the same user", async () => {
    const t = await setupAccessInstance();
    const identity = { clientInstanceId, authSource: "oidc", externalUserId: "lena-sign-in" };
    await t.stores.users.upsertUserIdentity({ ...identity, userId: t.lena.id });
    await expect(
      t.stores.users.upsertUserIdentity({ ...identity, userId: t.kai.id })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "identity_already_linked" }
    });
    const updated = await t.stores.users.upsertUserIdentity({
      ...identity,
      userId: t.lena.id,
      displayLabel: "Updated identity"
    });
    expect(updated.identities).toMatchObject([
      {
        authSource: identity.authSource,
        externalUserId: identity.externalUserId,
        displayLabel: "Updated identity"
      }
    ]);
  });
});

describe("sign-in and identity writes use the same lock order", () => {
  it("resolves a sign-in beside a guarded identity write without 40P01", async () => {
    const t = await setupAccessInstance();
    const sql = await observer();
    const identity = {
      clientInstanceId,
      userId: t.lena.id,
      authSource: "oidc",
      externalUserId: "same-sign-in"
    };
    await t.stores.users.upsertUserIdentity(identity);
    let ready: () => void = () => undefined;
    const prepared = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let resume: () => void = () => undefined;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const writing = settled(
      t.stores.transaction(async (held) => {
        await held.access.lockRights({ clientInstanceId, userId: t.lena.id });
        ready();
        await resumed;
        return held.users.upsertUserIdentity(identity);
      })
    );
    await prepared;
    let finished = false;
    const resolving = settled(
      t.stores.users.resolveUserIdentity({
        clientInstanceId,
        authSource: identity.authSource,
        externalUserId: identity.externalUserId,
        displayLabel: "Lena",
        roles: ["user"],
        permissionRefs: [],
        permissions: []
      })
    ).then((result) => {
      finished = true;
      return result;
    });
    try {
      await untilBlocked(sql, () => finished);
    } finally {
      resume();
    }
    const results = await Promise.all([writing, resolving]);
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
  });
});

describe("direct membership writes hold the rights locks", () => {
  it.each(["add", "role", "remove", "personal", "create"] as const)(
    "%s waits for the instance access lock before writing",
    async (change) => {
      const t = await setupAccessInstance();
      const sql = await observer();
      const workspace = await t.sharedWorkspace("Shared");
      const input = { clientInstanceId, collaborationWorkspaceId: workspace, userId: t.lena.id };
      if (change === "role" || change === "remove") {
        await t.stores.workspaces.addMembership({ ...input, role: "member" });
      }
      // createUser already provisions a Personal Workspace, so provision a fresh one only
      // after removing its empty predecessor through the supported cleanup operation.
      if (change === "personal") {
        await t.stores.workspaces.deletePersonalWorkspaceForUser({
          clientInstanceId,
          userId: t.lena.id
        });
      }
      const blocker = await holdTransaction(
        sql,
        (tx) =>
          tx`select pg_advisory_xact_lock(hashtextextended(${`access:${clientInstanceId}`}, 0))`
      );
      let finished = false;
      const write = settled(
        (async () => {
          switch (change) {
            case "add":
              return t.stores.workspaces.addMembership({ ...input, role: "member" });
            case "role":
              return t.stores.workspaces.updateMembershipRole({ ...input, role: "admin" });
            case "remove":
              return t.stores.workspaces.removeMembership(input);
            case "personal":
              return t.stores.workspaces.ensurePersonalWorkspace({
                clientInstanceId,
                userId: t.lena.id
              });
            case "create":
              return t.stores.workspaces.createWorkspace({
                clientInstanceId,
                creatorUserId: t.lena.id,
                kind: "shared",
                name: "New"
              });
          }
        })()
      ).then((result) => {
        finished = true;
        return result;
      });
      try {
        await untilBlocked(sql, () => finished);
      } finally {
        await blocker.rollback();
        await write;
      }
      const result = await write;
      if (result.status === "rejected") throw result.reason;
    }
  );
});
