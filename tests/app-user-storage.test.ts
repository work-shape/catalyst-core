import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

  it("merges batches per key, removes keys, clears before setting, and redacts private batch data", async () => {
    const frame = await t.openApp(t.kai.id, "published");
    expectStatus(await write(t.kai.id, frame, { type: "clear" }), 200);
    expectStatus(
      await write(t.kai.id, frame, { type: "set", key: "untouched", value: "other-tab" }),
      200
    );
    const responses = await Promise.all([
      write(t.kai.id, frame, {
        type: "batch",
        clear: false,
        values: { secret: "private-batch-value" }
      }),
      write(t.kai.id, frame, { type: "batch", clear: false, values: { another: "last" } })
    ]);
    for (const response of responses) expectStatus(response, 200);
    expect(await t.stores.pages.getAppUserStorage(await key(t.kai.id))).toEqual({
      untouched: "other-tab",
      secret: "private-batch-value",
      another: "last"
    });
    const ids = responses.map((response) => response.headers["operation-run-id"]);
    const runs = (await t.stores.operationRuns.list({ clientInstanceId })).filter((run) =>
      ids.includes(run.id)
    );
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((run) => run.inputHash)).size).toBe(1);
    expect(JSON.stringify(runs)).not.toContain("private-batch-value");
    expectStatus(
      await write(t.kai.id, frame, { type: "batch", clear: false, values: { secret: null } }),
      200
    );
    expect(await t.stores.pages.getAppUserStorage(await key(t.kai.id))).toEqual({
      untouched: "other-tab",
      another: "last"
    });
    expectStatus(
      await write(t.kai.id, frame, { type: "batch", clear: true, values: { final: "only" } }),
      200
    );
    expect(await t.stores.pages.getAppUserStorage(await key(t.kai.id))).toEqual({ final: "only" });
    expectStatus(
      await write(t.kai.id, frame, { type: "batch", clear: false, values: { wrong: {} } }),
      422
    );
    expectStatus(
      await write(t.kai.id, frame, {
        type: "batch",
        clear: false,
        values: { huge: "x".repeat(APP_USER_STORAGE_MAX_BYTES) }
      }),
      422
    );
    expect(await t.stores.pages.getAppUserStorage(await key(t.kai.id))).toEqual({ final: "only" });
  });

  it("coalesces 100 rapid writes and resolves kit saves only after the batch is confirmed", async () => {
    const frame = await t.openApp(t.kai.id, "published");
    const shell = await callTestPath(
      t.instance,
      "GET",
      `/app-content/${frame.proof.fileSetId}/${frame.proof.token}/`
    );
    const html = shell.body.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
    const bootstrap = /\(function installAppStorage[\s\S]*?\}\)\(\{[^\n]*?\}\);/u.exec(html)?.[0];
    if (!bootstrap) throw new Error("The App shell must install storage before its scripts");
    const messages: { requestId: string; mutation: unknown }[] = [];
    const host = { postMessage: (message: (typeof messages)[number]) => messages.push(message) };
    const events = new Map<string, (event: unknown) => void>();
    const document = {
      visibilityState: "visible",
      addEventListener: (type: string, handler: () => void) => events.set(type, handler)
    };
    const window: {
      parent: { parent: typeof host };
      addEventListener: (type: string, handler: (event: unknown) => void) => void;
      dispatchEvent: (event: unknown) => void;
      localStorage?: Storage;
      catalystAppStorage?: { set: (key: string, value: unknown) => Promise<void> };
    } = {
      parent: { parent: host },
      addEventListener: (type, handler) => events.set(type, handler),
      dispatchEvent: vi.fn()
    };
    vi.useFakeTimers();
    try {
      runInNewContext(bootstrap, {
        window,
        document,
        TextEncoder,
        DOMException,
        setTimeout,
        clearTimeout
      });
      const storage = window.localStorage;
      const kit = window.catalystAppStorage;
      if (!storage || !kit) throw new Error("Both storage APIs must be installed");
      storage.clear();
      storage.setItem("removed", "before");
      storage.removeItem("removed");
      for (let index = 0; index < 100; index++) storage.setItem(`key-${index % 2}`, String(index));
      let saved = false;
      const pending = kit.set("json", { last: true }).then(() => {
        saved = true;
      });
      expect(storage.getItem("key-1")).toBe("99");
      expect(messages).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(240);
      expect(messages).toHaveLength(0);
      expect(saved).toBe(false);
      await vi.advanceTimersByTimeAsync(20);
      expect(messages).toHaveLength(1);
      const message = messages[0];
      expect(message?.mutation).toEqual({
        type: "batch",
        clear: true,
        values: { removed: null, "key-0": "98", "key-1": "99", json: '{"last":true}' }
      });
      expect(saved).toBe(false);
      events.get("message")?.({
        source: {},
        data: {
          catalystBridge: 1,
          type: "storage_result",
          session: frame.proof.token,
          requestId: message?.requestId,
          ok: true
        }
      });
      expect(saved).toBe(false);
      // Use the session carried by the generated bootstrap, not the content token.
      const session = /"session":"([^"]+)"/u.exec(bootstrap)?.[1];
      events.get("message")?.({
        source: host,
        data: {
          catalystBridge: 1,
          type: "storage_result",
          session,
          requestId: message?.requestId,
          ok: true
        }
      });
      await pending;
      expect(saved).toBe(true);
      storage.setItem("after", "clear-me");
      storage.clear();
      storage.setItem("last", "kept");
      events.get("pagehide")?.({});
      expect(messages.at(-1)?.mutation).toEqual({
        type: "batch",
        clear: true,
        values: { last: "kept" }
      });
      storage.removeItem("last");
      document.visibilityState = "visible";
      events.get("visibilitychange")?.({});
      expect(messages).toHaveLength(2);
      document.visibilityState = "hidden";
      events.get("visibilitychange")?.({});
      expect(messages).toHaveLength(3);
      expect(messages.at(-1)?.mutation).toEqual({
        type: "batch",
        clear: false,
        values: { last: null }
      });
      for (const sent of messages.slice(1))
        events.get("message")?.({
          source: host,
          data: {
            catalystBridge: 1,
            type: "storage_result",
            session,
            requestId: sent.requestId,
            ok: true
          }
        });
      await vi.advanceTimersByTimeAsync(500);
      expect(messages).toHaveLength(3);
      const refused = kit.set("failed", "private");
      const rejection = expect(refused).rejects.toThrow("The interface did not save App storage");
      events.get("pagehide")?.({});
      events.get("message")?.({
        source: host,
        data: {
          catalystBridge: 1,
          type: "storage_result",
          session,
          requestId: messages.at(-1)?.requestId,
          ok: false
        }
      });
      await rejection;
      const timedOut = expect(kit.set("lost-host", "private")).rejects.toThrow(
        "The interface did not save App storage"
      );
      events.get("pagehide")?.({});
      await vi.advanceTimersByTimeAsync(30_100);
      await timedOut;
    } finally {
      vi.useRealTimers();
    }
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
