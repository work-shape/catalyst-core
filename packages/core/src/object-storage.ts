import { AppError } from "./errors";

/**
 * The longest a signed read address may stay valid. A caller that asks for longer is refused,
 * so a leaked address stops working within minutes.
 */
export const SIGNED_GET_URL_MAX_TTL_SECONDS = 300;

/** How many objects one page of `list` holds at most. */
export const OBJECT_LIST_PAGE_SIZE = 1000;

/** Bytes to store: all at once, or as a stream whose length the caller states. */
export type ObjectBody = Uint8Array | AsyncIterable<Uint8Array>;

export interface ObjectPutOptions {
  contentType?: string;
  /** The byte length. Required for a stream, so no provider has to buffer it to learn it. */
  size?: number;
}

export interface ObjectHead {
  size: number;
  /** The type the object was stored with, when the provider keeps it. */
  contentType?: string;
}

export interface StoredObject extends ObjectHead {
  /** Read it to the end or leave the loop early; both release the provider's connection. */
  body: AsyncIterable<Uint8Array>;
}

export interface ObjectListEntry {
  key: string;
  size: number;
}

export interface ObjectListPage {
  /** In ascending key order. */
  objects: ObjectListEntry[];
  /** Present while more objects follow. Opaque, and only valid for the same prefix. */
  cursor?: string;
}

/**
 * Where every stored byte of an instance goes. One instance of this port is one named store,
 * such as `files` or `workspaces`. Keys are product-owned strings with `/` between segments;
 * a provider maps them to its own layout.
 *
 * A method fails with `ObjectNotFound` or `ObjectStorageUnavailable` and with nothing else.
 */
export interface ObjectStorage {
  /** Replaces the object when the key exists. */
  put(key: string, body: ObjectBody, options?: ObjectPutOptions): Promise<void>;
  get(key: string): Promise<StoredObject>;
  head(key: string): Promise<ObjectHead>;
  /** A key that does not exist is not an error. */
  delete(key: string): Promise<void>;
  /**
   * Deletes every object below a prefix and returns how many. The prefix must end with `/`:
   * `users/usr_1/` cannot reach `users/usr_10/`, which `users/usr_1` would.
   */
  deletePrefix(prefix: string): Promise<{ deleted: number }>;
  /** One page of the objects below a prefix. The prefix ends with `/` or is empty for all. */
  list(prefix: string, cursor?: string): Promise<ObjectListPage>;
  /**
   * An address that reads the object without credentials for `ttlSeconds`, at most
   * `SIGNED_GET_URL_MAX_TTL_SECONDS`. Absent when the provider cannot sign. The address is a
   * credential: it goes to the one caller that asked and is never written to a log, an audit
   * event or a usage row.
   */
  signedGetUrl?(key: string, ttlSeconds: number): Promise<string>;
}

/** The key names no object. */
export class ObjectNotFound extends AppError {
  constructor() {
    super("NOT_FOUND", "The stored object is not available.", { stage: "store" });
    this.name = "ObjectNotFound";
  }
}

/** Why a store could not serve. A closed list, so a message never repeats provider text. */
export type ObjectStorageFailure =
  "store_missing" | "access_denied" | "unreachable" | "request_failed";

export interface ObjectStorageFailureDiagnostics {
  /** A code from the provider's own closed list, such as `AccessDenied` or `ENOSPC`. */
  providerErrorCode?: string;
  httpStatusCode?: number;
}

const FAILURE_MESSAGES: Record<ObjectStorageFailure, string> = {
  store_missing:
    "Object storage is not available: its bucket or directory does not exist. Create it or correct the entry under 'infrastructure.objectStorage'.",
  access_denied:
    "Object storage is not available: its credentials cannot access the store. Check the credentials and permissions of the entry under 'infrastructure.objectStorage'.",
  unreachable:
    "Object storage is not reachable. Check the endpoint of the entry under 'infrastructure.objectStorage' and network access.",
  request_failed: "The object storage request failed."
};

/**
 * The store did not serve the request. It carries the failure, a provider code from a closed
 * list and an HTTP status, and never the provider's message, its error object or an address.
 */
export class ObjectStorageUnavailable extends AppError {
  readonly failure: ObjectStorageFailure;

  constructor(failure: ObjectStorageFailure, diagnostics: ObjectStorageFailureDiagnostics = {}) {
    super(
      failure === "request_failed" ? "INTERNAL" : "VALIDATION_FAILED",
      FAILURE_MESSAGES[failure],
      {
        stage: "store",
        failure,
        ...(diagnostics.providerErrorCode
          ? { providerErrorCode: diagnostics.providerErrorCode }
          : {}),
        ...(diagnostics.httpStatusCode !== undefined
          ? { httpStatusCode: diagnostics.httpStatusCode }
          : {})
      }
    );
    this.name = "ObjectStorageUnavailable";
    this.failure = failure;
  }
}

/** A caller broke the port's rules, such as a prefix that could reach a neighbour's objects. */
function refuse(reason: string): AppError {
  return new AppError("INTERNAL", `Object storage refused the request: ${reason}`);
}

/**
 * The key as every provider addresses it. The same keys are refused that the stores before
 * this port refused, so every object they wrote keeps its key. The key itself is not repeated
 * in the message: it can name a user or a file.
 */
export function normalizeObjectKey(key: string): string {
  if (key.trim().length === 0 || key.includes("\0") || key.startsWith("/") || key.includes("\\")) {
    throw refuse("the object key is empty or holds a character no key may hold");
  }
  // The normal form a POSIX path has: no empty segment, no `.`, and `..` taken out with the
  // segment before it. A key that would climb above the store's root is refused.
  const segments: string[] = [];
  for (const segment of key.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment !== "..") {
      segments.push(segment);
    } else if (segments.pop() === undefined) {
      throw refuse("the object key leaves the store");
    }
  }
  if (segments.length === 0) {
    throw refuse("the object key names no segment");
  }
  return `${segments.join("/")}${key.endsWith("/") ? "/" : ""}`;
}

/**
 * A prefix that selects whole key segments only. It must end with `/`, which is what keeps
 * `usr_1/` from matching `usr_10/`. `allowAll` admits the empty prefix, for listing a store.
 */
export function normalizeObjectPrefix(prefix: string, options: { allowAll: boolean }): string {
  if (prefix === "" && options.allowAll) {
    return "";
  }
  if (!prefix.endsWith("/")) {
    throw refuse("a prefix must end with '/', so it cannot match a neighbouring key");
  }
  return normalizeObjectKey(prefix);
}

/**
 * Puts a provider's implementation behind the port's rules, so they hold whatever the provider
 * does: keys and prefixes are checked before the provider sees them, a stream states its size,
 * a signed address has a bounded life, and an error that is not one of the port's two becomes
 * `ObjectStorageUnavailable` without its message. Every provider returns its store through
 * this function.
 */
export function guardObjectStorage(provider: ObjectStorage): ObjectStorage {
  const signedGetUrl = provider.signedGetUrl?.bind(provider);
  return {
    async put(key, body, options) {
      const normalized = normalizeObjectKey(key);
      const size = body instanceof Uint8Array ? body.byteLength : options?.size;
      if (size === undefined || !Number.isSafeInteger(size) || size < 0) {
        throw refuse("a streamed object needs its size");
      }
      await sealed(() => provider.put(normalized, body, { ...options, size }));
    },
    async get(key) {
      const normalized = normalizeObjectKey(key);
      const stored = await sealed(() => provider.get(normalized));
      return { ...stored, body: sealedBody(stored.body) };
    },
    async head(key) {
      const normalized = normalizeObjectKey(key);
      return sealed(() => provider.head(normalized));
    },
    async delete(key) {
      const normalized = normalizeObjectKey(key);
      return sealed(() => provider.delete(normalized));
    },
    async deletePrefix(prefix) {
      const normalized = normalizeObjectPrefix(prefix, { allowAll: false });
      return sealed(() => provider.deletePrefix(normalized));
    },
    async list(prefix, cursor) {
      const normalized = normalizeObjectPrefix(prefix, { allowAll: true });
      return sealed(() => provider.list(normalized, cursor));
    },
    ...(signedGetUrl
      ? {
          async signedGetUrl(key: string, ttlSeconds: number) {
            const normalized = normalizeObjectKey(key);
            if (
              !Number.isSafeInteger(ttlSeconds) ||
              ttlSeconds < 1 ||
              ttlSeconds > SIGNED_GET_URL_MAX_TTL_SECONDS
            ) {
              throw refuse(
                `a signed address lives between 1 and ${SIGNED_GET_URL_MAX_TTL_SECONDS} seconds`
              );
            }
            return sealed(() => signedGetUrl(normalized, ttlSeconds));
          }
        }
      : {})
  };
}

/** Reads a whole object into memory. For callers whose objects are bounded by an upload limit. */
export async function readObjectBytes(storage: ObjectStorage, key: string): Promise<Uint8Array> {
  const stored = await storage.get(key);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stored.body) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  // One plain byte array whatever the provider's chunks are, so callers compare like with like.
  const [only] = chunks;
  if (chunks.length === 1 && only) {
    return new Uint8Array(only.buffer, only.byteOffset, only.byteLength);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isPortError(error: unknown): error is ObjectNotFound | ObjectStorageUnavailable {
  return error instanceof ObjectNotFound || error instanceof ObjectStorageUnavailable;
}

async function sealed<Result>(run: () => Promise<Result>): Promise<Result> {
  try {
    return await run();
  } catch (error: unknown) {
    throw isPortError(error) ? error : new ObjectStorageUnavailable("request_failed");
  }
}

async function* sealedBody(body: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  try {
    yield* body;
  } catch (error: unknown) {
    throw isPortError(error) ? error : new ObjectStorageUnavailable("request_failed");
  }
}
