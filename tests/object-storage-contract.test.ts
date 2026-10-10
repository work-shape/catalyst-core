import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  asConversationId,
  asExecutionWorkspaceId,
  asWorkspaceCommandId,
  createProvider,
  guardObjectStorage,
  OBJECT_LIST_PAGE_SIZE,
  ObjectNotFound,
  ObjectStorageUnavailable,
  readObjectBytes,
  SIGNED_GET_URL_MAX_TTL_SECONDS,
  type Logger,
  type ObjectStorage
} from "@vivd-catalyst/core";
import { objectStorageProviderDefinitions } from "@vivd-catalyst/object-storage";
import { DEFAULT_WORKSPACE_FILE_OBJECT_KEY_FACTORY } from "@vivd-catalyst/tool-execution";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { startS3Mock, type S3Mock } from "./support/s3-mock";

/**
 * One suite for every store. A provider passes when it behaves as the port says, so a caller
 * cannot tell the stores apart. The S3 half talks to the S3 mock the deployments run locally.
 */

const MEBIBYTE = 1024 * 1024;
const LARGE_OBJECT_BYTES = 64 * MEBIBYTE;
/** A store that buffered the large object would hold all 64 MB of it; a stream holds chunks. */
const LARGE_OBJECT_MEMORY_BUDGET_BYTES = 16 * MEBIBYTE;

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => logger
};
const context = { logger, secrets: { resolve: async () => "s3mock" } };

/** Keys in the layouts the release before this port wrote, one per holder of bytes. */
const PREVIOUS_RELEASE_KEYS = [
  "execution-workspaces/client_a/conv_1/ews_1/wcmd_1/sha256%3Aabc/reports/Q3%20plan.csv",
  "execution-workspace-source-files/client_a/conv_1/sha256%3Aabc/Angebot%20(final).pdf",
  "artifact-previews/client_a/conv_1/art_1/apj_1/lease-1/sha256%3Aabc/page-1.png",
  "artifact-previews/client_a/conv_1/art_1/apj_1/lease-1/sha256%3Aabc/page-1.model.jpg",
  "documents/client_a/conversations/conv_1/original/obj_1.pdf",
  "documents/client_a/conversations/conv_1/document-page-image/file_1/sha256:abc/page-000001-dpi-110.jpg"
];

interface Subject {
  name: string;
  /** Whether a read returns the content type the object was written with. */
  keepsContentType: boolean;
  signs: boolean;
  /** Whether the large object runs. The store in memory holds every object by design. */
  streams: boolean;
  storage(): ObjectStorage;
  /** Writes an object the way the release before the port did, without the port. */
  writeAsPreviousRelease(key: string, bytes: Uint8Array): Promise<void>;
}

let s3Mock: S3Mock;
let directory: string;
const stores = new Map<string, ObjectStorage>();
const bucket = `contract-${randomUUID()}`;

function s3Storage(overrides: Record<string, unknown> = {}): Promise<ObjectStorage> {
  return createProvider(
    objectStorageProviderDefinitions,
    "objectStorage",
    {
      path: "infrastructure.objectStorage.files",
      entry: {
        provider: "s3",
        region: "eu",
        bucket,
        endpoint: s3Mock.endpoint,
        forcePathStyle: true,
        accessKeySecret: "TEST_ACCESS_KEY",
        secretKeySecret: "TEST_SECRET_KEY",
        ...overrides
      }
    },
    context
  );
}

function filesystemStorage(root: string): Promise<ObjectStorage> {
  return createProvider(
    objectStorageProviderDefinitions,
    "objectStorage",
    { path: "infrastructure.objectStorage.workspaces", entry: { provider: "filesystem", root } },
    context
  );
}

beforeAll(async () => {
  s3Mock = await startS3Mock();
  directory = await mkdtemp(join(tmpdir(), "catalyst-object-storage-"));
  stores.set("filesystem", await filesystemStorage(join(directory, "objects")));
  stores.set("s3", await s3Storage());
  stores.set("memory", guardObjectStorage(new MemoryObjectStorage()));
  // The bucket exists before the first object is written past the port.
  await required(stores.get("s3")).list("");
}, 120_000);

afterAll(async () => {
  s3Mock.stop();
  await rm(directory, { recursive: true, force: true });
});

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

const subjects: Subject[] = [
  {
    name: "filesystem",
    keepsContentType: false,
    signs: false,
    streams: true,
    storage: () => required(stores.get("filesystem")),
    async writeAsPreviousRelease(key, bytes) {
      const path = join(directory, "objects", ...key.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
  },
  {
    name: "s3",
    keepsContentType: true,
    signs: true,
    streams: true,
    storage: () => required(stores.get("s3")),
    async writeAsPreviousRelease(key, bytes) {
      // The key is the object's key in the bucket; only its place in the address is escaped.
      const path = key.split("/").map(encodeURIComponent).join("/");
      const response = await fetch(`${s3Mock.endpoint}/${bucket}/${path}`, {
        method: "PUT",
        body: new Blob([Uint8Array.from(bytes)])
      });
      expect(response.status).toBe(200);
    }
  },
  {
    name: "memory",
    keepsContentType: true,
    signs: false,
    streams: false,
    storage: () => required(stores.get("memory")),
    async writeAsPreviousRelease(key, bytes) {
      await required(stores.get("memory")).put(key, bytes);
    }
  }
];

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function text(storage: ObjectStorage, key: string): Promise<string> {
  return new TextDecoder().decode(await readObjectBytes(storage, key));
}

async function listAll(storage: ObjectStorage, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await storage.list(prefix, cursor);
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.cursor;
  } while (cursor !== undefined);
  return keys;
}

/**
 * What the process still refers to, inside and outside the JavaScript heap. Garbage is
 * collected first, so chunks that were already let go do not count as held.
 */
function heldBytes(): number {
  collectGarbage();
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

/** The collector, switched on for this process; a test runner does not expose it. */
const collectGarbage = (() => {
  setFlagsFromString("--expose-gc");
  const collect: unknown = runInNewContext("gc");
  if (typeof collect !== "function") throw new Error("The garbage collector is not exposed");
  return () => {
    collect();
  };
})();

describe.each(subjects)("object storage contract: $name", (subject) => {
  /** A prefix of this test's own, so tests of one store do not see each other's objects. */
  const scope = () => `contract/${randomUUID()}/`;

  it("returns the bytes, the size and the type an object was stored with", async () => {
    const storage = subject.storage();
    const key = `${scope()}reports/Q3 plan (final).csv`;
    const bytes = encode("name,total\nAda,42\n");

    await storage.put(key, bytes, { contentType: "text/csv" });

    await expect(readObjectBytes(storage, key)).resolves.toEqual(bytes);
    const head = await storage.head(key);
    const stored = await storage.get(key);
    for await (const chunk of stored.body) void chunk;
    expect(head.size).toBe(bytes.byteLength);
    expect(stored.size).toBe(bytes.byteLength);
    if (subject.keepsContentType) {
      expect(head.contentType).toBe("text/csv");
      expect(stored.contentType).toBe("text/csv");
    }
  });

  it("replaces an object written again under its key and stores an empty one", async () => {
    const storage = subject.storage();
    const key = `${scope()}notes.txt`;
    await storage.put(key, encode("first, and longer"));

    await storage.put(key, encode("second"));
    await storage.put(`${key}.empty`, new Uint8Array());

    await expect(text(storage, key)).resolves.toBe("second");
    await expect(storage.head(`${key}.empty`)).resolves.toMatchObject({ size: 0 });
    await expect(readObjectBytes(storage, `${key}.empty`)).resolves.toHaveLength(0);
  });

  it("stores a stream whose size the caller states and refuses one without", async () => {
    const storage = subject.storage();
    const key = `${scope()}stream.bin`;
    async function* chunks(): AsyncIterable<Uint8Array> {
      yield encode("one ");
      yield encode("two ");
      yield encode("three");
    }

    await storage.put(key, chunks(), { size: 13 });

    await expect(text(storage, key)).resolves.toBe("one two three");
    await expect(storage.put(`${key}.unsized`, chunks())).rejects.toThrow(
      "a streamed object needs its size"
    );
    await expect(storage.head(`${key}.unsized`)).rejects.toBeInstanceOf(ObjectNotFound);
  });

  it("answers a missing key with ObjectNotFound and deletes one without an error", async () => {
    const storage = subject.storage();
    const key = `${scope()}never/written.txt`;

    await expect(storage.get(key)).rejects.toBeInstanceOf(ObjectNotFound);
    await expect(storage.head(key)).rejects.toBeInstanceOf(ObjectNotFound);
    await expect(readObjectBytes(storage, key)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(storage.delete(key)).resolves.toBeUndefined();

    await storage.put(key, encode("now it is there"));
    await storage.delete(key);
    await expect(storage.get(key)).rejects.toBeInstanceOf(ObjectNotFound);
  });

  it("deletes below a prefix and leaves the neighbour whose name starts the same", async () => {
    const storage = subject.storage();
    const base = scope();
    await storage.put(`${base}users/usr_x1/a.txt`, encode("a"));
    await storage.put(`${base}users/usr_x1/deep/b.txt`, encode("b"));
    await storage.put(`${base}users/usr_x10/c.txt`, encode("c"));
    await storage.put(`${base}users/usr_x1.txt`, encode("d"));

    // Without its separator the prefix would also match `usr_x10/` and `usr_x1.txt`.
    await expect(storage.deletePrefix(`${base}users/usr_x1`)).rejects.toThrow(
      "a prefix must end with '/'"
    );
    await expect(storage.deletePrefix("")).rejects.toThrow("a prefix must end with '/'");
    await expect(storage.deletePrefix("/")).rejects.toThrow("Object storage refused");
    expect((await listAll(storage, base)).sort()).toEqual(
      [
        `${base}users/usr_x1.txt`,
        `${base}users/usr_x1/a.txt`,
        `${base}users/usr_x1/deep/b.txt`,
        `${base}users/usr_x10/c.txt`
      ].sort()
    );

    await expect(storage.deletePrefix(`${base}users/usr_x1/`)).resolves.toEqual({ deleted: 2 });

    expect((await listAll(storage, base)).sort()).toEqual(
      [`${base}users/usr_x1.txt`, `${base}users/usr_x10/c.txt`].sort()
    );
    await expect(text(storage, `${base}users/usr_x10/c.txt`)).resolves.toBe("c");
    await expect(storage.deletePrefix(`${base}users/usr_x1/`)).resolves.toEqual({ deleted: 0 });
  });

  it("refuses a prefix that is not in its normal form instead of rewriting it", async () => {
    const storage = subject.storage();
    const base = scope();
    await storage.put(`${base}u/usr_1/a.txt`, encode("a"));
    await storage.put(`${base}u/usr_10/b.txt`, encode("b"));

    // Rewritten, `u/usr_1/../` is `u/`: the delete would take the neighbour `usr_10` with it.
    const unsafe = [
      `${base}u/usr_1/../`,
      `${base}u/./`,
      `${base}u//usr_1/`,
      `${base}u/usr_1//`,
      `/${base}u/usr_1/`,
      `${base}u\\usr_1/`,
      `${base}u/usr_1\0/`,
      "../",
      "./"
    ];
    for (const prefix of unsafe) {
      await expect(storage.deletePrefix(prefix)).rejects.toThrow("Object storage refused");
      await expect(storage.list(prefix)).rejects.toThrow("Object storage refused");
    }

    expect((await listAll(storage, base)).sort()).toEqual([
      `${base}u/usr_1/a.txt`,
      `${base}u/usr_10/b.txt`
    ]);
  });

  it("keeps the object whose key is the prefix without its separator", async () => {
    const storage = subject.storage();
    const base = scope();
    await storage.put(`${base}u/file`, encode("kept"));
    await storage.put(`${base}u/other/a.txt`, encode("a"));

    // `u/file/` names what lies below `u/file`. Nothing does, so nothing is deleted.
    await expect(storage.deletePrefix(`${base}u/file/`)).resolves.toEqual({ deleted: 0 });
    await expect(storage.list(`${base}u/file/`)).resolves.toEqual({ objects: [] });

    await expect(text(storage, `${base}u/file`)).resolves.toBe("kept");
    expect((await listAll(storage, base)).sort()).toEqual([
      `${base}u/file`,
      `${base}u/other/a.txt`
    ]);
    await expect(storage.deletePrefix(`${base}u/other/`)).resolves.toEqual({ deleted: 1 });
    await expect(text(storage, `${base}u/file`)).resolves.toBe("kept");
  });

  it("lists a prefix in pages, in key order, with sizes", async () => {
    const storage = subject.storage();
    const base = scope();
    const count = OBJECT_LIST_PAGE_SIZE + 5;
    const keys = Array.from(
      { length: count },
      (_, index) => `${base}items/${String(index).padStart(5, "0")}.txt`
    );
    const WRITES_AT_ONCE = 50;
    for (let start = 0; start < keys.length; start += WRITES_AT_ONCE) {
      await Promise.all(
        keys.slice(start, start + WRITES_AT_ONCE).map((key) => storage.put(key, encode("x")))
      );
    }
    await storage.put(`${base}items-archive/old.txt`, encode("not listed"));

    const first = await storage.list(`${base}items/`);
    expect(first.objects).toHaveLength(OBJECT_LIST_PAGE_SIZE);
    expect(first.cursor).toEqual(expect.any(String));
    const second = await storage.list(`${base}items/`, first.cursor);
    expect(second.objects).toHaveLength(5);
    expect(second.cursor).toBeUndefined();

    expect([...first.objects, ...second.objects].map((object) => object.key)).toEqual(keys);
    expect(first.objects[0]).toEqual({ key: keys[0], size: 1 });
    await expect(storage.list(`${base}nothing-here/`)).resolves.toEqual({ objects: [] });
    await expect(storage.list(`${base}items`)).rejects.toThrow("a prefix must end with '/'");
  }, 120_000);

  it("refuses a key that leaves the store", async () => {
    const storage = subject.storage();

    for (const key of ["", "../outside.txt", "a/../../outside.txt", "/absolute.txt", "a\\b"]) {
      await expect(storage.put(key, encode("x"))).rejects.toThrow("Object storage refused");
      await expect(storage.get(key)).rejects.toThrow("Object storage refused");
    }
  });

  it("reads objects written under the previous release's keys", async () => {
    const storage = subject.storage();
    // The same keys in every run, so the objects are written once per store.
    for (const key of PREVIOUS_RELEASE_KEYS) {
      await subject.writeAsPreviousRelease(key, encode(`bytes of ${key}`));
    }

    for (const key of PREVIOUS_RELEASE_KEYS) {
      await expect(text(storage, key)).resolves.toBe(`bytes of ${key}`);
      await expect(storage.head(key)).resolves.toMatchObject({
        size: encode(`bytes of ${key}`).byteLength
      });
    }
    // A listing gives the keys back unchanged, which is what a deletion by key relies on.
    expect(await listAll(storage, "execution-workspaces/client_a/")).toEqual([
      PREVIOUS_RELEASE_KEYS[0]
    ]);
    expect(await listAll(storage, "documents/client_a/conversations/conv_1/")).toEqual([
      PREVIOUS_RELEASE_KEYS[5],
      PREVIOUS_RELEASE_KEYS[4]
    ]);
  });

  it.runIf(subject.streams)(
    "moves a 64 MB object in and out without holding it",
    async () => {
      const storage = subject.storage();
      const key = `${scope()}large.bin`;
      const chunk = new Uint8Array(MEBIBYTE).fill(7);
      const baseline = heldBytes();
      let peak = baseline;
      const sample = () => {
        peak = Math.max(peak, heldBytes());
      };
      async function* body(): AsyncIterable<Uint8Array> {
        for (let sent = 0; sent < LARGE_OBJECT_BYTES; sent += chunk.byteLength) {
          sample();
          yield chunk;
        }
      }

      await storage.put(key, body(), { size: LARGE_OBJECT_BYTES });
      sample();
      const stored = await storage.get(key);
      let received = 0;
      let sampledAt = 0;
      for await (const part of stored.body) {
        received += part.byteLength;
        if (received - sampledAt >= MEBIBYTE) {
          sampledAt = received;
          sample();
        }
      }

      expect(stored.size).toBe(LARGE_OBJECT_BYTES);
      expect(received).toBe(LARGE_OBJECT_BYTES);
      expect(peak - baseline).toBeLessThan(LARGE_OBJECT_MEMORY_BUDGET_BYTES);
      await storage.delete(key);
    },
    120_000
  );

  it.runIf(subject.signs)("signs a read address that lives for a bounded time", async () => {
    const storage = subject.storage();
    const key = `${scope()}signed.txt`;
    await storage.put(key, encode("read me"));
    const signedGetUrl = required(storage.signedGetUrl?.bind(storage));

    const url = await signedGetUrl(key, 60);
    const response = await fetch(url);

    expect(await response.text()).toBe("read me");
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("60");
    for (const ttl of [0, 1.5, SIGNED_GET_URL_MAX_TTL_SECONDS + 1]) {
      await expect(signedGetUrl(key, ttl)).rejects.toThrow("a signed address lives between 1 and");
    }
  });

  it.runIf(!subject.signs)("offers no signed address when it cannot sign", () => {
    expect(subject.storage().signedGetUrl).toBeUndefined();
  });
});

/** What a vendor writes into an error and what must not leave the port. */
const VENDOR_TEXT = "vendor-internal-detail";

/** An S3 endpoint that answers every request with one error, as a vendor words it. */
async function vendorAnswering(
  status: number,
  code: string
): Promise<{ endpoint: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    request.resume();
    // The bucket check passes, so the failure comes from the request under test.
    if (request.method === "HEAD") {
      response.writeHead(200).end();
      return;
    }
    response.writeHead(status, { "content-type": "application/xml" });
    response.end(
      `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${VENDOR_TEXT}</Message><RequestId>req-1</RequestId></Error>`
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No port was assigned");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

describe("object storage failures", () => {
  it("reports an S3 endpoint nobody answers on without its address or the vendor's text", async () => {
    // Port 1 is reserved and closed, so the connection is refused at once.
    const storage = await s3Storage({ endpoint: "http://127.0.0.1:1", bucket: "unreachable" });

    const failures = await Promise.all([
      storage.put("a.txt", encode("x")).catch((error: unknown) => error),
      storage.get("a.txt").catch((error: unknown) => error),
      storage.list("").catch((error: unknown) => error)
    ]);

    for (const failure of failures) {
      expect(failure).toBeInstanceOf(ObjectStorageUnavailable);
      expect(failure).toMatchObject({
        failure: "unreachable",
        code: "VALIDATION_FAILED",
        details: { stage: "store", failure: "unreachable", providerErrorCode: "ECONNREFUSED" }
      });
      expect(JSON.stringify(failure) + String(failure)).not.toMatch(/127\.0\.0\.1|unreachable\//u);
      expect(failure).not.toHaveProperty("cause");
      expect(failure).not.toHaveProperty("$metadata");
    }
  });

  it("tells a missing bucket and refused credentials apart, without the vendor's text", async () => {
    const missingBucket = await vendorAnswering(404, "NoSuchBucket");
    const refused = await vendorAnswering(403, "AccessDenied");
    try {
      const noBucket = await (
        await s3Storage({ endpoint: missingBucket.endpoint })
      )
        .put("a.txt", encode("x"))
        .catch((error: unknown) => error);
      const noBucketOnRead = await (
        await s3Storage({ endpoint: missingBucket.endpoint })
      )
        .get("a.txt")
        .catch((error: unknown) => error);
      const denied = await (
        await s3Storage({ endpoint: refused.endpoint })
      )
        .put("a.txt", encode("x"))
        .catch((error: unknown) => error);

      expect(noBucket).toBeInstanceOf(ObjectStorageUnavailable);
      expect(noBucket).toMatchObject({
        failure: "store_missing",
        code: "VALIDATION_FAILED",
        statusCode: 422,
        details: { stage: "store", providerErrorCode: "NoSuchBucket", httpStatusCode: 404 }
      });
      // The answer names the store's own config entry, so the operator knows which of the
      // two stores to repair.
      expect(noBucket).toMatchObject({
        message: expect.stringContaining("the entry 'infrastructure.objectStorage.files'"),
        details: { entry: "infrastructure.objectStorage.files" }
      });
      expect(denied).toMatchObject({
        message: expect.stringContaining("the entry 'infrastructure.objectStorage.files'")
      });
      // A bucket that is gone is not reported as an object that is gone.
      expect(noBucketOnRead).toMatchObject({ failure: "store_missing" });
      expect(denied).toMatchObject({
        failure: "access_denied",
        code: "VALIDATION_FAILED",
        details: { providerErrorCode: "AccessDenied", httpStatusCode: 403 }
      });
      for (const failure of [noBucket, noBucketOnRead, denied]) {
        expect(JSON.stringify(failure) + String(failure)).not.toMatch(
          new RegExp(`${VENDOR_TEXT}|${bucket}|127\\.0\\.0\\.1`, "u")
        );
        expect(failure).not.toHaveProperty("cause");
      }
    } finally {
      await missingBucket.close();
      await refused.close();
    }
  });

  it("keeps only a vendor code it knows, so a code cannot carry a secret out", async () => {
    const marker = "AKIAIOSFODNN7EXAMPLE";
    const vendor = await vendorAnswering(400, marker);
    try {
      const storage = await s3Storage({ endpoint: vendor.endpoint });

      const failure = await storage.put("a.txt", encode("x")).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ObjectStorageUnavailable);
      expect(failure).toMatchObject({ failure: "request_failed", code: "INTERNAL" });
      expect(JSON.stringify(failure) + String(failure)).not.toContain(marker);
      expect(failure).not.toHaveProperty("cause");
    } finally {
      await vendor.close();
    }
  });

  it("reports a filesystem root that cannot hold objects as unavailable, not as missing", async () => {
    const root = join(directory, "not-a-directory");
    await writeFile(root, "a file where the root should be");
    const storage = await filesystemStorage(root);

    const failure = await storage.put("a/b.txt", encode("x")).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ObjectStorageUnavailable);
    expect(failure).toMatchObject({
      details: { entry: "infrastructure.objectStorage.workspaces" }
    });
    expect(String(failure)).not.toContain(root);
    expect(failure).not.toHaveProperty("cause");
    await expect(storage.get("a/b.txt")).rejects.toBeInstanceOf(ObjectNotFound);
    await expect(readFile(root, "utf8")).resolves.toBe("a file where the root should be");
  });

  it("turns whatever a provider throws into the port's error, without its message", async () => {
    const leaking = new MemoryObjectStorage();
    const secret = "https://bucket.example.test/key?X-Amz-Signature=abc123";
    leaking.delete = async () => {
      throw Object.assign(new Error(`request to ${secret} failed`), { $metadata: { secret } });
    };
    leaking.get = async () => ({
      size: 1,
      body: (async function* (): AsyncIterable<Uint8Array> {
        yield encode("x");
        throw new Error(`stream from ${secret} broke`);
      })()
    });
    const storage = guardObjectStorage(leaking);

    const deleted = await storage.delete("a.txt").catch((error: unknown) => error);
    const read = await readObjectBytes(storage, "a.txt").catch((error: unknown) => error);

    for (const failure of [deleted, read]) {
      expect(failure).toBeInstanceOf(ObjectStorageUnavailable);
      expect(JSON.stringify(failure) + String(failure)).not.toContain("X-Amz-Signature");
      expect(failure).not.toHaveProperty("cause");
    }
  });
});

describe("object keys", () => {
  it("keeps the key layout of workspace files", () => {
    expect(
      DEFAULT_WORKSPACE_FILE_OBJECT_KEY_FACTORY.createWorkspaceFileObjectKey({
        clientInstanceId: asClientInstanceId("client_a"),
        conversationId: asConversationId("conv_1"),
        workspaceId: asExecutionWorkspaceId("ews_1"),
        commandId: asWorkspaceCommandId("wcmd_1"),
        path: "reports/Q3 plan.csv",
        checksum: "sha256:abc",
        byteSize: 18
      })
    ).toBe(PREVIOUS_RELEASE_KEYS[0]);
  });
});
