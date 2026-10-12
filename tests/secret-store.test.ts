import { createDecipheriv } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  SECRET_STORE_NONCE_BYTES,
  SECRET_VALUE_MAX_BYTES,
  SecretStoreKeyError,
  createConnectionCredentialResolver,
  createSecretStore,
  loadSecretKeyring,
  secretAssociatedData,
  type SecretKeyring
} from "@vivd-catalyst/connections";
import {
  AppError,
  SHARED_CREDENTIAL_SUBJECT,
  SecretNotResolvedError,
  asClientInstanceId,
  type SecretBinding,
  type SecretResolver
} from "@vivd-catalyst/core";
import { required } from "./support/assertions";
import { connection } from "./support/connections";
import {
  dumpDatabaseText,
  findLeak,
  generateSecretStoreKey,
  generateTestSecret
} from "./support/test-connector";
import { createTestInstance, type TestPostgresStore } from "./support/test-instance";
import { withTestSql } from "./support/test-sql";
import { applyAtCurrentRevisions } from "./support/asset-revisions";

// The Secret Store over real rows. Each test fails without the store: there is no table, no
// encryption and no resolver before it.

const clientInstanceId = asClientInstanceId("secret-store-test");

/** A resolver over named values, as the instance's secret provider is over its environment. */
function secretsOf(values: Record<string, string>): SecretResolver {
  return {
    resolve(name) {
      const value = values[name];
      return value === undefined
        ? Promise.reject(new SecretNotResolvedError(name, "is not set"))
        : Promise.resolve(value);
    }
  };
}

const keyringOf = (keys: Array<[id: string, key: string]>): Promise<SecretKeyring> =>
  loadSecretKeyring({
    keys: keys.map(([id], index) => ({ id, ref: `STORE_KEY_${index}` })),
    secrets: secretsOf(
      Object.fromEntries(keys.map(([, key], index) => [`STORE_KEY_${index}`, key]))
    )
  });

async function refusal(work: Promise<unknown>): Promise<AppError> {
  const error: unknown = await work.then(
    () => undefined,
    (caught: unknown) => caught
  );
  if (!(error instanceof AppError)) throw new Error("Expected an AppError");
  return error;
}

interface SecretRow {
  handle: string;
  connection_asset_id: string;
  subject: string;
  version: number;
  key_id: string;
  nonce: Buffer;
  ciphertext: Buffer;
  source: string;
}

const readRows = () =>
  withTestSql((sql) => sql<SecretRow[]>`select * from secrets order by connection_asset_id`);

describe("the Secret Store", () => {
  let stores: TestPostgresStore;
  let key: string;
  let keyring: SecretKeyring;
  let first: SecretBinding;
  let second: SecretBinding;

  beforeEach(async () => {
    stores = (await createTestInstance({ postgres: {} })).stores;
    key = generateSecretStoreKey();
    keyring = await keyringOf([["k1", key]]);
    await applyAtCurrentRevisions(stores.configAssets, {
      clientInstanceId,
      mutations: ["first", "second"].map((name) => ({
        type: "upsert" as const,
        kind: "connection",
        name,
        config: connection(name, { secretHandle: undefined })
      }))
    });
    const assets = await stores.configAssets.listActiveConfigAssets({
      clientInstanceId,
      kind: "connection"
    });
    const bindingOf = (name: string): SecretBinding => ({
      connectionAssetId: required(assets.find((asset) => asset.name === name)).id,
      subject: SHARED_CREDENTIAL_SUBJECT
    });
    first = bindingOf("first");
    second = bindingOf("second");
  });

  const storeWith = (ring: SecretKeyring = keyring) =>
    createSecretStore({ clientInstanceId, keyring: ring, store: stores.connections });
  const resolverWith = (ring: SecretKeyring = keyring) =>
    createConnectionCredentialResolver({
      clientInstanceId,
      keyring: ring,
      store: stores.connections
    });

  it("holds ciphertext only: the value is in no column in any encoding", async () => {
    const value = generateTestSecret();
    const written = await storeWith().put({ binding: first, value, source: "runtime" });
    expect(written).toEqual({ handle: written.handle, version: 1, changed: true });
    expect(written.handle).toMatch(/^secret_[0-9a-f-]{36}$/u);

    const [row] = await readRows();
    expect(required(row)).toMatchObject({
      handle: written.handle,
      connection_asset_id: first.connectionAssetId,
      subject: "shared",
      version: 1,
      key_id: "k1",
      source: "runtime"
    });
    expect(required(row).nonce).toHaveLength(SECRET_STORE_NONCE_BYTES);
    const dump = await dumpDatabaseText();
    expect(dump).toContain(written.handle);
    expect(findLeak(dump, value)).toBeUndefined();
    expect(findLeak(dump, key)).toBeUndefined();
  });

  it("is AES-256-GCM with a 12-byte nonce and the associated data instance|asset|subject|version", async () => {
    const value = generateTestSecret();
    await storeWith().put({ binding: first, value, source: "runtime" });
    const row = required((await readRows())[0]);
    const associatedData = secretAssociatedData({ clientInstanceId, binding: first, version: 1 });
    expect(associatedData).toBe(`secret-store-test|${first.connectionAssetId}|shared|1`);

    // Opened here with Node's cipher alone, from what the row holds and the key.
    const open = (aad: string) => {
      const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64"), row.nonce);
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(row.ciphertext.subarray(row.ciphertext.length - 16));
      return Buffer.concat([
        decipher.update(row.ciphertext.subarray(0, row.ciphertext.length - 16)),
        decipher.final()
      ]).toString("utf8");
    };
    expect(open(associatedData)).toBe(value);
    for (const other of [
      `another-instance|${first.connectionAssetId}|shared|1`,
      `secret-store-test|${second.connectionAssetId}|shared|1`,
      `secret-store-test|${first.connectionAssetId}|someone|1`,
      `secret-store-test|${first.connectionAssetId}|shared|2`
    ]) {
      expect(() => open(other)).toThrow();
    }
    expect(() =>
      secretAssociatedData({
        clientInstanceId,
        binding: { connectionAssetId: "a|b", subject: "shared" },
        version: 1
      })
    ).toThrow(/cannot be bound/u);
  });

  it("uses a new nonce for every encryption and a new version for every new value", async () => {
    const store = storeWith();
    const nonces = new Set<string>();
    let handle: string | undefined;
    for (let version = 1; version <= 5; version += 1) {
      const written = await store.put({
        binding: first,
        value: generateTestSecret(),
        source: "runtime"
      });
      expect(written).toMatchObject({ version, changed: true });
      // The handle is the Connection's and stays across versions.
      handle ??= written.handle;
      expect(written.handle).toBe(handle);
      nonces.add(required((await readRows())[0]).nonce.toString("hex"));
    }
    expect(nonces.size).toBe(5);
    expect(await readRows()).toHaveLength(1);
  });

  it("writes nothing for the value that is stored already", async () => {
    const store = storeWith();
    const value = generateTestSecret();
    const written = await store.put({ binding: first, value, source: "bootstrap" });
    const before = required((await readRows())[0]);
    expect(await store.put({ binding: first, value, source: "bootstrap" })).toEqual({
      handle: written.handle,
      version: 1,
      changed: false
    });
    expect(required((await readRows())[0]).nonce.equals(before.nonce)).toBe(true);
  });

  it("makes the same value from another source a write, so the secret changes hands", async () => {
    // Fails without the change: the runtime put answered `changed: false` and the row
    // stayed the bootstrap's, which a later seed replaces or removes.
    const store = storeWith();
    const value = generateTestSecret();
    await store.put({ binding: first, value, source: "bootstrap" });
    expect(await store.put({ binding: first, value, source: "runtime" })).toMatchObject({
      version: 2,
      changed: true
    });
    expect(await store.status(first)).toMatchObject({ state: "set", source: "runtime" });
    expect(await store.put({ binding: first, value, source: "runtime" })).toMatchObject({
      version: 2,
      changed: false
    });
  });

  it("lets one of two writers at the same time win and tells the other of the conflict", async () => {
    // Fails without the change: both writers computed the same next version, the store
    // dropped one of them and both were told `changed: true`.
    const store = storeWith();
    await store.put({ binding: first, value: generateTestSecret(), source: "runtime" });
    for (let round = 0; round < 5; round += 1) {
      const before = required((await readRows())[0]).version;
      const values = Array.from({ length: 6 }, () => generateTestSecret());
      const results = await Promise.allSettled(
        values.map((value) => store.put({ binding: first, value, source: "runtime" }))
      );
      const won = results.flatMap((result, index) =>
        result.status === "fulfilled" ? [{ index, written: result.value }] : []
      );
      const lost = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : []
      );
      // Each success is its own version, and the stored value is the one of the last.
      const versions = won.map(({ written }) => written.version);
      expect(new Set(versions).size).toBe(versions.length);
      expect(won.length).toBeGreaterThanOrEqual(1);
      expect(won.length + lost.length).toBe(values.length);
      for (const error of lost) {
        expect(error).toMatchObject({
          code: "CONFLICT",
          details: { reason: "secret_write_conflict" }
        });
      }
      const row = required((await readRows())[0]);
      expect(row.version).toBe(before + won.length);
      const last = required(won.find(({ written }) => written.version === row.version));
      expect(await resolverWith().resolve({ handle: row.handle, binding: first })).toBe(
        values[last.index]
      );
    }
    // A first write against a first write: one row, one winner.
    const fresh = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        store.put({ binding: second, value: generateTestSecret(), source: "runtime" })
      )
    );
    expect(fresh.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await store.status(second)).toMatchObject({ state: "set", version: 1 });
  });

  it("hands the value to the resolver for the binding of the call and to nothing else", async () => {
    const store = storeWith();
    const value = generateTestSecret();
    const { handle } = await store.put({ binding: first, value, source: "runtime" });
    expect(await resolverWith().resolve({ handle, binding: first })).toBe(value);

    // The store itself has write, replace, state and delete. Nothing of it returns a value.
    expect(Object.keys(store).sort()).toEqual(["delete", "put", "status"]);
    const status = await store.status(first);
    expect(status).toEqual({ state: "set", handle, version: 1, source: "runtime" });
    expect(findLeak(JSON.stringify(status), value)).toBeUndefined();
    expect(await store.status(second)).toEqual({ state: "not_set" });
  });

  it("does not open a row copied to another Connection's handle", async () => {
    const store = storeWith();
    const value = generateTestSecret();
    const a = await store.put({ binding: first, value, source: "runtime" });
    const b = await store.put({ binding: second, value: generateTestSecret(), source: "runtime" });
    await withTestSql(
      (sql) => sql`
        update secrets set (version, key_id, nonce, ciphertext) =
          (select version, key_id, nonce, ciphertext from secrets where handle = ${a.handle})
        where handle = ${b.handle}`
    );
    const copied = await refusal(resolverWith().resolve({ handle: b.handle, binding: second }));
    expect(copied.details).toEqual({ reason: "secret_unreadable" });
    expect(await store.status(second)).toMatchObject({ state: "unreadable" });

    // A handle is no credential: the first Connection's handle opens nothing for the second.
    const borrowed = await refusal(resolverWith().resolve({ handle: a.handle, binding: second }));
    expect(borrowed.details).toEqual({ reason: "secret_unreadable" });
    for (const error of [copied, borrowed]) {
      expect(findLeak(JSON.stringify([error.message, error.details]), value)).toBeUndefined();
    }
    // The first Connection still reads its own.
    expect(await resolverWith().resolve({ handle: a.handle, binding: first })).toBe(value);
  });

  it("refuses a changed row, a missing row and a key that is gone, each without a value", async () => {
    const value = generateTestSecret();
    const { handle } = await storeWith().put({ binding: first, value, source: "runtime" });

    const otherRing = await keyringOf([["k1", generateSecretStoreKey()]]);
    const wrongKey = await refusal(resolverWith(otherRing).resolve({ handle, binding: first }));
    expect(wrongKey.details).toEqual({ reason: "secret_unreadable" });
    const unknownKeyId = await keyringOf([["k9", key]]);
    expect(
      (await refusal(resolverWith(unknownKeyId).resolve({ handle, binding: first }))).details
    ).toEqual({ reason: "secret_unreadable" });

    await withTestSql(
      (sql) =>
        sql`update secrets set ciphertext = set_byte(ciphertext, 0, get_byte(ciphertext, 0) # 1)`
    );
    const changed = await refusal(resolverWith().resolve({ handle, binding: first }));
    expect(changed.details).toEqual({ reason: "secret_unreadable" });

    await storeWith().delete(first);
    const missing = await refusal(resolverWith().resolve({ handle, binding: first }));
    expect(missing.details).toEqual({ reason: "connection_not_configured" });
    for (const error of [wrongKey, changed, missing]) {
      expect(findLeak(`${error.message}${error.stack ?? ""}`, value)).toBeUndefined();
      expect(findLeak(`${error.message}${error.stack ?? ""}`, key)).toBeUndefined();
    }
  });

  it("encrypts with the first key of the list and decrypts with every key", async () => {
    const value = generateTestSecret();
    const { handle } = await storeWith().put({ binding: first, value, source: "runtime" });
    const newKey = generateSecretStoreKey();
    const rotated = await keyringOf([
      ["k2", newKey],
      ["k1", key]
    ]);
    expect(rotated.encryptingKeyId).toBe("k2");
    expect(await resolverWith(rotated).resolve({ handle, binding: first })).toBe(value);
    expect(required((await readRows())[0]).key_id).toBe("k1");

    const next = generateTestSecret();
    await storeWith(rotated).put({ binding: first, value: next, source: "runtime" });
    expect(required((await readRows())[0])).toMatchObject({ key_id: "k2", version: 2 });
    // The old key alone no longer opens the row.
    expect(
      (await refusal(resolverWith(keyring).resolve({ handle, binding: first }))).details
    ).toEqual({ reason: "secret_unreadable" });
  });

  it("refuses an empty value and one beyond SECRET_VALUE_MAX_BYTES", async () => {
    const store = storeWith();
    for (const value of ["", "x".repeat(SECRET_VALUE_MAX_BYTES + 1)]) {
      const error = await refusal(store.put({ binding: first, value, source: "runtime" }));
      expect(error.message).toContain("SECRET_VALUE_MAX_BYTES");
    }
    expect(await readRows()).toHaveLength(0);
  });

  it("removes the secret with its Connection", async () => {
    await storeWith().put({ binding: first, value: generateTestSecret(), source: "runtime" });
    await withTestSql(
      (sql) => sql`delete from config_assets where id = ${first.connectionAssetId}`
    );
    expect(await readRows()).toHaveLength(0);
  });
});

describe("the keys of the Secret Store", () => {
  const keys = [
    { id: "current", ref: "SECRET_STORE_KEY" },
    { id: "previous", ref: "SECRET_STORE_KEY_PREVIOUS" }
  ];

  it("stops with the name of the variable when the first key does not resolve", async () => {
    const error = await refusal(
      loadSecretKeyring({
        keys,
        secrets: secretsOf({ SECRET_STORE_KEY_PREVIOUS: generateSecretStoreKey() })
      })
    );
    expect(error).toBeInstanceOf(SecretStoreKeyError);
    expect(error.message).toBe("The Secret Store key 'SECRET_STORE_KEY' is not set");
  });

  it("leaves a later key that is absent out and says which", async () => {
    const missing: string[] = [];
    const keyring = await loadSecretKeyring({
      keys,
      secrets: secretsOf({ SECRET_STORE_KEY: generateSecretStoreKey() }),
      onMissingKey: (key) => missing.push(key.ref)
    });
    expect(keyring.keyIds).toEqual(["current"]);
    expect(missing).toEqual(["SECRET_STORE_KEY_PREVIOUS"]);
  });

  it("refuses a key that is not 32 bytes in base64, and never repeats it", async () => {
    for (const bad of [
      "not base64 at all!",
      Buffer.alloc(16, 7).toString("base64"),
      Buffer.alloc(33, 7).toString("base64"),
      "correct-horse-battery-staple-correct-horse"
    ]) {
      const error = await refusal(
        loadSecretKeyring({ keys, secrets: secretsOf({ SECRET_STORE_KEY: bad }) })
      );
      expect(error.message).toBe(
        "The Secret Store key 'SECRET_STORE_KEY' must be 32 random bytes in base64"
      );
      expect(JSON.stringify([error.message, error.details ?? null])).not.toContain(bad);
    }
  });

  it("needs at least one key", async () => {
    const error = await refusal(loadSecretKeyring({ keys: [], secrets: secretsOf({}) }));
    expect(error.message).toContain("secretStore.keys");
  });
});
