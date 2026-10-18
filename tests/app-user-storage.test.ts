import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_USER_STORAGE_MAX_BYTES, asUserId } from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import { expectStatus } from "./support/app-instance";
import {
  appSource,
  setupAppActions,
  type AppActionsInstance,
  type Frame
} from "./support/app-actions";
import { callTestPath } from "./support/test-instance";

// Personal state uses the already authenticated frame proof. A revision is never its owner,
// and another viewer's valid session is never a proof for this caller.
describe("private App storage", () => {
  let t: AppActionsInstance;
  beforeAll(async () => {
    t = await setupAppActions();
  });
  afterAll(() => t.closeAll());

  const write = (user: string, frame: Frame, mutation: unknown) =>
    t.call(user, "apps.sessions.write_storage", {
      params: { pageSessionId: frame.pageSessionId },
      payload: { ...frame.proof, mutation }
    });
  const key = async (user: string) => ({
    clientInstanceId,
    appId: await t.assetId("app", "orders"),
    userId: asUserId(user)
  });

  it("hydrates reloads across revisions, isolates people and serializes concurrent keys", async () => {
    const frame = await t.openApp(t.kai.id, "published");
    const other = await t.openApp(t.admin.id, "draft");
    expectStatus(await write(t.kai.id, frame, { type: "clear" }), 200);
    expectStatus(await write(t.admin.id, other, { type: "clear" }), 200);
    const writes = await Promise.all([
      write(t.kai.id, frame, { type: "set", key: "leave", value: '"2026-11-01"' }),
      write(t.kai.id, frame, { type: "set", key: "notes", value: '"Cover arranged"' })
    ]);
    for (const response of writes) expectStatus(response, 200);
    expect(await t.stores.pages.getAppUserStorage(await key(t.kai.id))).toEqual({
      leave: '"2026-11-01"',
      notes: '"Cover arranged"'
    });
    expect(await t.stores.pages.getAppUserStorage(await key(t.admin.id))).toEqual({});
    const recorded = (await t.stores.operationRuns.list({ clientInstanceId })).filter(
      (run) => run.operation === "apps.sessions.write_storage"
    );
    const ids = writes.map((response) => response.headers["operation-run-id"]);
    const savedRuns = recorded.filter((run) => ids.includes(run.id));
    expect(savedRuns).toHaveLength(2);
    // Different private keys and values have the same redacted fingerprint: a retained
    // fast hash must not let an operator guess someone's low-entropy preference.
    expect(new Set(savedRuns.map((run) => run.inputHash)).size).toBe(1);
    expect(JSON.stringify(recorded)).not.toContain("Cover arranged");
    expect(JSON.stringify(recorded)).not.toContain(frame.proof.token);
    const loaded = await callTestPath(
      t.instance,
      "GET",
      `/app-content/${frame.proof.fileSetId}/${frame.proof.token}/`
    );
    expectStatus(loaded, 200);
    expect(loaded.headers["cache-control"]).toBe("no-store");
    expect(loaded.body).toContain("Cover arranged");
    const otherLoaded = await callTestPath(
      t.instance,
      "GET",
      `/app-content/${other.proof.fileSetId}/${other.proof.token}/`
    );
    expect(otherLoaded.body).not.toContain("Cover arranged");
    // The draft and published views share personal state, independently of file-set ids.
    const draft = await t.openApp(t.admin.id, "draft");
    expectStatus(
      await write(t.admin.id, draft, {
        type: "set",
        key: "private",
        value: '"private-draft-marker"'
      }),
      200
    );
    const published = await t.openApp(t.admin.id, "published");
    const reloaded = await callTestPath(
      t.instance,
      "GET",
      `/app-content/${published.proof.fileSetId}/${published.proof.token}/`
    );
    expect(reloaded.body).toContain("private-draft-marker");
  });

  it("refuses another person's proof, an invalid proof, a Page, and malformed mutations", async () => {
    const frame = await t.openApp(t.kai.id, "published");
    const mutation = { type: "set", key: "unauthorized", value: "never" };
    expectStatus(await write(t.admin.id, frame, mutation), 404);
    expectStatus(await write(t.kai.id, { ...frame, pageSessionId: "other-frame" }, mutation), 404);
    expectStatus(await write(t.kai.id, await t.openPage(t.kai.id), mutation), 404);
    expectStatus(await write(t.kai.id, frame, { type: "set", key: "wrong", value: {} }), 422);
    expectStatus(
      await write(t.kai.id, frame, { type: "set", key: "wrong", value: "x", userId: t.admin.id }),
      422
    );
    expect(await t.stores.pages.getAppUserStorage(await key(t.kai.id))).not.toHaveProperty(
      "unauthorized"
    );
  });

  it("bounds UTF-8 JSON before committing and preserves hostile keys as data", async () => {
    const frame = await t.openApp(t.kai.id, "published");
    expectStatus(await write(t.kai.id, frame, { type: "clear" }), 200);
    expectStatus(
      await write(t.kai.id, frame, { type: "set", key: "__proto__", value: "safe" }),
      200
    );
    const before = await t.stores.pages.getAppUserStorage(await key(t.kai.id));
    expect(Object.hasOwn(before, "__proto__")).toBe(true);
    const refused = await write(t.kai.id, frame, {
      type: "set",
      key: "large",
      value: "ä".repeat(APP_USER_STORAGE_MAX_BYTES)
    });
    expectStatus(refused, 422);
    expect(refused.body).toContain("APP_USER_STORAGE_MAX_BYTES");
    expect(await t.stores.pages.getAppUserStorage(await key(t.kai.id))).toEqual(before);
    expectStatus(await write(t.kai.id, frame, { type: "remove", key: "__proto__" }), 200);
    expect(await t.stores.pages.getAppUserStorage(await key(t.kai.id))).toEqual({});
  });

  it("erases private state with its account", async () => {
    const user = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Temporary builder",
      roles: ["user", "admin"]
    });
    const owned = await key(user.id);
    await t.stores.pages.mutateAppUserStorage({
      ...owned,
      mutation: { type: "set", key: "private", value: "gone" }
    });
    // A store-level cascade probe removes the temporary account's personal workspace
    // first, just as the account-erasure workflow does.
    await t.stores.workspaces.deletePersonalWorkspaceForUser({ clientInstanceId, userId: user.id });
    await t.stores.users.deleteUser({ clientInstanceId, userId: user.id });
    expect(await t.stores.pages.getAppUserStorage(owned)).toEqual({});
  });
  it("erases private state with its App", async () => {
    const name = "temporary-storage";
    expectStatus(await t.putApp(t.admin.id, name, appSource("temporary", name)), 200);
    const owned = {
      clientInstanceId,
      appId: await t.assetId("app", name),
      userId: asUserId(t.kai.id)
    };
    await t.stores.pages.mutateAppUserStorage({
      ...owned,
      mutation: { type: "set", key: "private", value: "gone" }
    });
    const removed = await t.call(t.admin.id, "assets.delete", {
      params: { kind: "app", name },
      payload: { workspaceId: t.workspaceId, expectedRevision: 1 }
    });
    expectStatus(removed, 200);
    expect(await t.stores.pages.getAppUserStorage(owned)).toEqual({});
  });
});
