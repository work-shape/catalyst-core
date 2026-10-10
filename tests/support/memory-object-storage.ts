import {
  normalizeObjectKey,
  normalizeObjectPrefix,
  OBJECT_LIST_PAGE_SIZE,
  ObjectNotFound,
  type ObjectBody,
  type ObjectHead,
  type ObjectListPage,
  type ObjectPutOptions,
  type ObjectStorage,
  type StoredObject
} from "@vivd-catalyst/core";

/**
 * An object store in memory, for tests that need a store and not a provider. It keeps the
 * port's rules, and the contract suite runs against it beside the two providers, so a test
 * that passes on it says something about them.
 */
export class MemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();

  async put(key: string, body: ObjectBody, options?: ObjectPutOptions): Promise<void> {
    const bytes = body instanceof Uint8Array ? body : await collect(body);
    this.objects.set(normalizeObjectKey(key), {
      bytes,
      ...(options?.contentType ? { contentType: options.contentType } : {})
    });
  }

  async get(key: string): Promise<StoredObject> {
    const object = this.stored(key);
    return {
      ...(await this.head(key)),
      body: (async function* () {
        yield object.bytes;
      })()
    };
  }

  async head(key: string): Promise<ObjectHead> {
    const object = this.stored(key);
    return {
      size: object.bytes.byteLength,
      ...(object.contentType ? { contentType: object.contentType } : {})
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(normalizeObjectKey(key));
  }

  async deletePrefix(prefix: string): Promise<{ deleted: number }> {
    const normalized = normalizeObjectPrefix(prefix, { allowAll: false });
    const keys = this.keys().filter((key) => key.startsWith(normalized));
    for (const key of keys) {
      this.objects.delete(key);
    }
    return { deleted: keys.length };
  }

  async list(prefix: string, cursor?: string): Promise<ObjectListPage> {
    const normalized = normalizeObjectPrefix(prefix, { allowAll: true });
    const remaining = this.keys()
      .filter((key) => key.startsWith(normalized))
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .filter(
        (key) => cursor === undefined || Buffer.compare(Buffer.from(key), Buffer.from(cursor)) > 0
      );
    const page = remaining.slice(0, OBJECT_LIST_PAGE_SIZE);
    const last = page.at(-1);
    return {
      objects: page.map((key) => ({ key, size: this.stored(key).bytes.byteLength })),
      ...(remaining.length > page.length && last ? { cursor: last } : {})
    };
  }

  /** Stores bytes at once, for a test that sets a store up outside an async step. */
  seed(key: string, bytes: Uint8Array): void {
    this.objects.set(normalizeObjectKey(key), { bytes });
  }

  /** Whether an object is stored under the key. */
  has(key: string): boolean {
    return this.objects.has(key);
  }

  /** Every stored key, in the order the objects were first written. */
  keys(): string[] {
    return [...this.objects.keys()];
  }

  get size(): number {
    return this.objects.size;
  }

  /** The bytes under a key, for an assertion. Fails when nothing is stored there. */
  bytes(key: string): Uint8Array {
    return this.stored(key).bytes;
  }

  /** The type an object was stored with. */
  contentType(key: string): string | undefined {
    return this.objects.get(key)?.contentType;
  }

  private stored(key: string): { bytes: Uint8Array; contentType?: string } {
    const object = this.objects.get(normalizeObjectKey(key));
    if (!object) {
      throw new ObjectNotFound();
    }
    return object;
  }
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
