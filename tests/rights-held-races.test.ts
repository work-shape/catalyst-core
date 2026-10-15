import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatServerOptions } from "@vivd-catalyst/chat-server";
import { asUserId, type PlatformStores } from "@vivd-catalyst/core";
import { clientInstanceId, setupAccessInstance } from "./support/access-instance";
import { settled } from "./support/postgres-concurrency-harness";
import { fileTestDatabaseUrl } from "./support/test-database";

// The third review of RIGHTS-1b found three races and a deadlock: a first password created
// before the locked check, a deny of the giver committed during a grant and read from the
// call's snapshot, and a revoke or a membership that changed the account after its locked
// check, with two lock orders that waited for each other. The ruling: every write of rights
// takes the instance's access lock and then the user's row lock first, and asks its check
// again inside, of the rights as they are then. Each test fails with its guard removed.

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function observer(): Promise<postgres.Sql> {
  const sql = postgres(await fileTestDatabaseUrl(), { max: 2 });
  closers.push(() => sql.end());
  return sql;
}

/** Resolves once some statement of this database waits for a lock another holds. */
async function untilSomeoneWaits(sql: postgres.Sql): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const [row] = await sql<Array<{ waiting: number }>>`
      select count(*)::int as waiting from pg_locks where not granted`;
    if ((row?.waiting ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error("Nothing ever waited for a lock");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type Transaction = PlatformStores["transaction"];

/**
 * Wraps the transactions of `stores` until one takes the rights locks: `before` runs as it asks
 * for them, after the call was admitted and before the locks; `after` runs once its change is
 * done, with the locks still held, before its commit.
 */
function onNextRightsWrite(
  stores: PlatformStores,
  hooks: { before?: () => Promise<void>; after?: () => Promise<void> }
): void {
  const transaction: Transaction = stores.transaction.bind(stores);
  const wrapped: Transaction = (fn) =>
    transaction(async (held) => {
      let locked = false;
      const lockRights = held.access.lockRights.bind(held.access);
      const result = await fn({
        ...held,
        access: {
          ...held.access,
          async lockRights(input) {
            if (!locked) {
              locked = true;
              stores.transaction = transaction;
              await hooks.before?.();
            }
            return lockRights(input);
          }
        }
      });
      if (locked) await hooks.after?.();
      return result;
    });
  stores.transaction = wrapped;
}

/** Changes the rights as the next write of rights asks for its locks. */
function beforeNextLocks(stores: PlatformStores, between: () => Promise<void>): void {
  onNextRightsWrite(stores, { before: between });
}

/**
 * Keeps the next write of rights open after its change, before its commit: `changed` resolves
 * once it holds its locks and wrote, `release` lets it commit.
 */
function holdNextCommit(stores: PlatformStores): { changed: Promise<void>; release(): void } {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markChanged: () => void = () => undefined;
  // A write that never takes the locks fails here, rather than at the timeout of the test.
  const changed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The write never took the rights locks")),
      10_000
    );
    markChanged = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  onNextRightsWrite(stores, {
    after: async () => {
      markChanged();
      await released;
    }
  });
  return { changed, release: () => release() };
}

/** An auth store whose password sign-ins are a map of email to the sign-in's id. */
function authStore() {
  const signIns = new Map<string, string>();
  const auth: NonNullable<ChatServerOptions["standaloneAuth"]> = {
    baseUrl: "http://127.0.0.1:4100/api/auth",
    handleRequest: () => Promise.resolve(new Response(null, { status: 404 })),
    routeKind: () => undefined,
    setPassword: () => Promise.resolve(),
    setOrCreatePasswordSignIn(command) {
      const externalUserId = `auth-${command.email}`;
      signIns.set(command.email, externalUserId);
      return Promise.resolve({
        externalUserId,
        displayLabel: command.displayLabel,
        email: command.email,
        emailVerified: true
      });
    },
    changePassword: () => Promise.resolve(),
    deletePasswordSignIn({ externalUserId }) {
      for (const [email, id] of signIns) if (id === externalUserId) signIns.delete(email);
      return Promise.resolve();
    },
    findPasswordSignIn({ email }) {
      const externalUserId = signIns.get(email);
      return Promise.resolve(
        externalUserId === undefined
          ? undefined
          : { externalUserId, displayLabel: email, email, emailVerified: true }
      );
    },
    createPasswordSetupToken: () => Promise.resolve("setup-token"),
    completePasswordSetup: () => Promise.reject(new Error("Not part of these tests"))
  };
  return { signIns, auth };
}

async function setup() {
  const { signIns, auth } = authStore();
  const t = await setupAccessInstance({ server: () => ({ standaloneAuth: auth }) });
  // Manages users and holds nothing else.
  const manager = await t.stores.users.createUser({
    clientInstanceId,
    displayLabel: "Manager",
    roles: ["user"],
    permissions: ["users.manage"]
  });
  const tim = await t.stores.users.createUser({
    clientInstanceId,
    displayLabel: "Tim",
    email: "tim@example.test",
    roles: ["user"]
  });
  await t.createNamespace("kai-");
  return { ...t, manager, tim, signIns };
}

/** The manager attaches a sign-in of their own to Lena. */
const attachSignIn = (t: Awaited<ReturnType<typeof setup>>) =>
  t.call(t.manager.id, "users.identities.upsert", {
    params: { userId: t.lena.id },
    payload: { authSource: "oidc", externalUserId: "manager-own-sign-in" }
  });

// The second review: the rules were asked before the write and not with it, so a user
// promoted or given a right in between was changed by a caller who may not change them.
describe("the account checked is the account written", () => {
  // Fails without the check under the locks: the sign-in is attached.
  it("refuses a sign-in for a user who became a superadmin after the call was admitted", async () => {
    const t = await setup();
    beforeNextLocks(t.stores, async () => {
      await t.stores.users.updateUser({
        clientInstanceId,
        userId: asUserId(t.lena.id),
        roles: ["user", "superadmin"]
      });
    });
    const signIn = await attachSignIn(t);
    expect(signIn.statusCode).toBe(403);
    expect(JSON.stringify(signIn.json())).toContain("Only a superadmin may change a superadmin");
    const lena = await t.stores.users.getUser({ clientInstanceId, userId: asUserId(t.lena.id) });
    expect(lena?.identities).toEqual([]);
  });

  // Fails without the check under the locks: Lena is renamed.
  it("refuses a change of a user given a right after the call was admitted", async () => {
    const t = await setup();
    beforeNextLocks(t.stores, async () => {
      await t.grant(t.lena.id, "agent.write", { namespace: "kai-" });
    });
    const renamed = await t.call(t.manager.id, "users.update", {
      params: { userId: t.lena.id },
      payload: { displayLabel: "Renamed" }
    });
    expect(renamed.json()).toMatchObject({
      error: { details: { action: "agent.write", reason: "no_grant" } }
    });
    const lena = await t.stores.users.getUser({ clientInstanceId, userId: asUserId(t.lena.id) });
    expect(lena?.displayLabel).toBe("Lena");
  });
});

describe("a first password", () => {
  // Fails with the password created before the check under the locks: the reset answers 403
  // and the password works.
  it("is not created for a user promoted after the call was admitted", async () => {
    const t = await setup();
    beforeNextLocks(t.stores, async () => {
      await t.stores.users.updateUser({
        clientInstanceId,
        userId: asUserId(t.tim.id),
        roles: ["user", "superadmin"]
      });
    });
    const reset = await t.call(t.admin.id, "users.password.reset", {
      params: { userId: t.tim.id },
      payload: { password: "correct-horse-battery-staple" }
    });
    expect(reset.statusCode).toBe(403);
    expect(JSON.stringify(reset.json())).toContain("Only a superadmin may change a superadmin");
    expect([...t.signIns.keys()]).toEqual([]);
  });

  // Fails without the undo: the sign-in stays in the auth store, which a sign-in by verified
  // email resolves to the user, though nothing attached it.
  it("is removed again when the write after it fails", async () => {
    const t = await setup();
    const transaction: Transaction = t.stores.transaction.bind(t.stores);
    t.stores.transaction = (fn) =>
      transaction((held) =>
        fn({
          ...held,
          users: {
            ...held.users,
            upsertUserIdentity: () => Promise.reject(new Error("The attachment failed"))
          }
        })
      );
    const reset = () =>
      t.call(t.admin.id, "users.password.reset", {
        params: { userId: t.tim.id },
        payload: { password: "correct-horse-battery-staple" }
      });
    expect((await reset()).statusCode).toBe(500);
    expect([...t.signIns.keys()]).toEqual([]);
    // A sign-in that was there before is not the change's to remove.
    t.signIns.set("tim@example.test", "auth-earlier");
    expect((await reset()).statusCode).toBe(500);
    expect([...t.signIns.entries()]).toEqual([["tim@example.test", "auth-tim@example.test"]]);
  });
});

describe("a deny of the giver", () => {
  // Fails with the call's snapshot of rights asked under the locks: the grant is written.
  it("committed after the call was admitted refuses the grant", async () => {
    const t = await setup();
    beforeNextLocks(t.stores, async () => {
      await t.stores.access.createGrant({
        clientInstanceId,
        holderKind: "user",
        holderId: t.admin.id,
        action: "agent.read",
        effect: "deny",
        scopeKind: "namespace",
        namespace: "kai-",
        grantedBy: asUserId(t.root.id)
      });
    });
    await t.expectRefused(
      t.admin.id,
      "permissions.grant",
      {
        payload: {
          holderKind: "user",
          holderId: t.kai.id,
          action: "agent.read",
          effect: "allow",
          scopeKind: "namespace",
          namespace: "kai-"
        }
      },
      t.forbidden("agent.read", "denied")
    );
    expect(await t.stores.access.listGrants({ clientInstanceId, holderId: t.kai.id })).toEqual([]);
  });
});

describe("a change of an account and another write of rights", () => {
  /** Lena may write one agent in `kai-`, and a deny of the Namespace takes it away. */
  async function lenaDenied() {
    const t = await setup();
    expect((await t.putAgent(t.admin.id, "kai-helper")).statusCode).toBe(200);
    const assetId = await t.assetId("agent", "kai-helper");
    await t.grant(t.lena.id, "agent.write", { assetId });
    const deny = await t.grant(t.lena.id, "agent.write", { namespace: "kai-" }, "deny");
    return { ...t, deny };
  }

  // Fails with a revoke that takes no rights lock: the sign-in does not wait, is checked with
  // the deny still in place, and is attached as Lena gets the right back.
  it("waits for a revoke of the user's deny and counts it", async () => {
    const t = await lenaDenied();
    const sql = await observer();
    const held = holdNextCommit(t.stores);
    const revoking = settled(
      t.call(t.root.id, "permissions.revoke", { params: { grantId: t.deny } })
    );
    await held.changed;
    const attaching = settled(attachSignIn(t));
    await untilSomeoneWaits(sql);
    held.release();
    const [revoked, attached] = await Promise.all([revoking, attaching]);
    if (revoked.status !== "fulfilled") throw revoked.reason;
    if (attached.status !== "fulfilled") throw attached.reason;
    expect(revoked.value.statusCode).toBe(200);
    expect(attached.value.json()).toMatchObject({
      error: { details: { action: "agent.write", reason: "no_grant" } }
    });
    const lena = await t.stores.users.getUser({ clientInstanceId, userId: asUserId(t.lena.id) });
    expect(lena?.identities).toEqual([]);
  });

  // Fails with a revoke straight on the store that takes no rights lock: the same.
  it("waits for a revoke on the store", async () => {
    const t = await lenaDenied();
    const sql = await observer();
    const held = holdNextCommit(t.stores);
    const attaching = settled(attachSignIn(t));
    await held.changed;
    const revoking = settled(t.stores.access.deleteGrant({ clientInstanceId, grantId: t.deny }));
    await untilSomeoneWaits(sql);
    held.release();
    const [attached, revoked] = await Promise.all([attaching, revoking]);
    if (attached.status !== "fulfilled") throw attached.reason;
    if (revoked.status !== "fulfilled") throw revoked.reason;
    // The sign-in held the locks first and was checked with the deny in place: it is
    // attached, and the revoke came after it.
    expect(attached.value.statusCode).toBe(200);
    expect(revoked.value?.id).toBe(t.deny);
  });

  // Fails with a membership that takes no rights lock: the sign-in is attached as Lena
  // becomes a member of a workspace whose rights the manager does not hold.
  it("waits for a membership given to the user and counts it", async () => {
    const t = await setup();
    const sql = await observer();
    await t.stores.users.updateUser({
      clientInstanceId,
      userId: asUserId(t.lena.id),
      email: "lena@example.test"
    });
    const workspaceId = await t.sharedWorkspace("Wide");
    const held = holdNextCommit(t.stores);
    const adding = settled(
      t.call(t.admin.id, "workspaces.members.add", {
        params: { collaborationWorkspaceId: workspaceId },
        payload: { email: "lena@example.test" }
      })
    );
    await held.changed;
    const attaching = settled(attachSignIn(t));
    await untilSomeoneWaits(sql);
    held.release();
    const [added, attached] = await Promise.all([adding, attaching]);
    if (added.status !== "fulfilled") throw added.reason;
    if (attached.status !== "fulfilled") throw attached.reason;
    expect(added.value.statusCode).toBe(200);
    expect(attached.value.statusCode).toBe(403);
    expect(attached.value.json()).toMatchObject({
      error: { details: { action: "app.use", reason: "no_grant" } }
    });
  });
});

describe("the two orders of the rights locks", () => {
  // Fails with the order the account writes took before: the row of the user first, then the
  // access lock in the legacy list. A grant takes the access lock and then the row, and the
  // two wait for each other until Postgres ends one (40P01).
  it("no longer wait for each other: an account write and a grant", async () => {
    const t = await setup();
    const sql = await observer();
    let granted: () => void = () => undefined;
    const grantDone = new Promise<void>((resolve) => {
      granted = resolve;
    });
    let lockHeld: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      lockHeld = resolve;
    });
    // What `createGrant` does for Lena: the access lock, then her row.
    const granting = settled(
      sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`access:${clientInstanceId}`}, 0))`;
        lockHeld();
        await grantDone;
        await tx`select id from product_users where id = ${t.lena.id} for share`;
      })
    );
    await lockTaken;
    // An account write that changes Lena's legacy keys, as the Users page saves them.
    const updating = settled(
      t.stores.users.updateUser({
        clientInstanceId,
        userId: asUserId(t.lena.id),
        permissions: ["usage.view"],
        grantedBy: asUserId(t.root.id)
      })
    );
    await untilSomeoneWaits(sql);
    granted();
    const [grant, update] = await Promise.all([granting, updating]);
    if (grant.status !== "fulfilled") throw grant.reason;
    if (update.status !== "fulfilled") throw update.reason;
    expect(update.value.permissions).toEqual(["usage.view"]);
  });
});
