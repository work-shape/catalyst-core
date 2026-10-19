import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import type { PlatformStores } from "@work-shape/catalyst-core";
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

/** Observe completion or a real database lock wait, without choosing a race by sleeping. */
async function finishedOrBlocked(
  sql: postgres.Sql,
  finished: () => boolean
): Promise<"completed" | "blocked"> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [row] = await sql<Array<{ waiting: number }>>`
      select count(*)::int as waiting from pg_stat_activity
      where datname = current_database() and cardinality(pg_blocking_pids(pid)) > 0`;
    if ((row?.waiting ?? 0) > 0) return "blocked";
    if (finished()) return "completed";
    if (Date.now() > deadline) throw new Error("The writer never waited for the rights lock");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function untilBlocked(sql: postgres.Sql, finished: () => boolean): Promise<void> {
  expect(await finishedOrBlocked(sql, finished)).toBe("blocked");
}

describe("deletion admission under the rights locks", () => {
  // A deny never takes `users.manage` from a superadmin (ADR-0028); a disabled account is
  // what only reloading the caller's access sees.
  it.each(["superadmin", "active status"] as const)(
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
          await t.stores.users.updateUser({
            clientInstanceId,
            userId: t.root.id,
            status: "disabled"
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
  it("resolves an existing sign-in while another transaction holds the access lock", async () => {
    const t = await setupAccessInstance();
    const sql = await observer();
    const identity = {
      clientInstanceId,
      userId: t.lena.id,
      authSource: "oidc",
      externalUserId: "ordinary-sign-in"
    };
    await t.stores.users.upsertUserIdentity(identity);
    const blocker = await holdTransaction(
      sql,
      (tx) => tx`select pg_advisory_xact_lock(hashtextextended(${`access:${clientInstanceId}`}, 0))`
    );
    let finished = false;
    const resolving = settled(
      t.stores.users.resolveUserIdentity({
        clientInstanceId,
        authSource: identity.authSource,
        externalUserId: identity.externalUserId,
        displayLabel: "Updated sign-in label",
        email: "lena@example.test",
        emailVerified: true,
        // An existing sign-in refreshes metadata, never the user's rights from these claims.
        roles: ["superadmin"],
        permissionRefs: ["unheld-reference"],
        permissions: ["users.manage"]
      })
    ).then((result) => {
      finished = true;
      return result;
    });
    try {
      expect(await finishedOrBlocked(sql, () => finished)).toBe("completed");
    } finally {
      await blocker.rollback();
      await resolving;
    }
    const result = await resolving;
    if (result.status === "rejected") throw result.reason;
    expect(result.value.id).toBe(t.lena.id);
    const user = await t.stores.users.getUser({ clientInstanceId, userId: t.lena.id });
    expect(user).toMatchObject({
      roles: ["user"],
      permissionRefs: [],
      permissions: [],
      identities: [
        { displayLabel: "Updated sign-in label", email: "lena@example.test", emailVerified: true }
      ]
    });
    expect(user?.lastAuthenticatedAt).toBeDefined();
  });

  it.each(["user", "identity"] as const)(
    "waits for the access lock to create a new %s",
    async (created) => {
      const t = await setupAccessInstance();
      const sql = await observer();
      const blocker = await holdTransaction(
        sql,
        (tx) =>
          tx`select pg_advisory_xact_lock(hashtextextended(${`access:${clientInstanceId}`}, 0))`
      );
      let finished = false;
      const resolving = settled(
        t.stores.users.resolveUserIdentity({
          clientInstanceId,
          authSource: "oidc",
          externalUserId: `new-${created}`,
          ...(created === "identity" ? { sourceUserId: t.lena.id } : {}),
          displayLabel: "New sign-in",
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
        await blocker.rollback();
        await resolving;
      }
      const result = await resolving;
      if (result.status === "rejected") throw result.reason;
      if (created === "identity") expect(result.value.id).toBe(t.lena.id);
    }
  );

  it("rechecks the owner after waiting for a mapping that was removed and linked elsewhere", async () => {
    const t = await setupAccessInstance();
    const sql = await observer();
    const address = { clientInstanceId, authSource: "oidc", externalUserId: "linked-elsewhere" };
    await t.stores.users.upsertUserIdentity({ ...address, userId: t.lena.id });
    let ready: () => void = () => undefined;
    const changed = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const moving = settled(
      t.stores.transaction(async (held) => {
        await held.users.deleteUserIdentity({ ...address, userId: t.lena.id });
        await held.users.upsertUserIdentity({ ...address, userId: t.kai.id });
        ready();
        await released;
      })
    );
    await changed;
    let finished = false;
    const resolving = settled(
      t.stores.users.resolveUserIdentity({
        ...address,
        displayLabel: "Current owner",
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
      release();
      await Promise.all([moving, resolving]);
    }
    const moved = await moving;
    if (moved.status === "rejected") throw moved.reason;
    const resolved = await resolving;
    if (resolved.status === "rejected") throw resolved.reason;
    expect(resolved.value.id).toBe(t.kai.id);
    expect(
      (await t.stores.users.getUser({ clientInstanceId, userId: t.lena.id }))?.identities
    ).toEqual([]);
  });

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
