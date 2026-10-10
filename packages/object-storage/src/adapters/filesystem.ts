import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import {
  defineProvider,
  guardObjectStorage,
  OBJECT_LIST_PAGE_SIZE,
  ObjectNotFound,
  ObjectStorageUnavailable,
  type ObjectListEntry,
  type ObjectStorage
} from "@vivd-catalyst/core";

/**
 * Keeps objects as files below one directory that the API and its workers share. A key is the
 * file's path below the root, segment for segment, so a key cannot name both an object and a
 * prefix of other objects. The content type is not kept.
 */
export const filesystemObjectStorageProvider = defineProvider({
  port: "objectStorage",
  type: "filesystem",
  configSchema: z.object({ root: z.string().min(1) }),
  external: false,
  create(config): ObjectStorage {
    return createFilesystemObjectStorage(config.root);
  },
  describe(config) {
    return { root: config.root };
  }
});

/** The store over a directory, for a tool or a test that has no instance config. */
export function createFilesystemObjectStorage(rootDirectory: string): ObjectStorage {
  return guardObjectStorage(new FilesystemObjectStorage(rootDirectory));
}

/** System error codes that may leave this adapter. Any other code is dropped. */
const REPORTED_CODES = new Set([
  "EACCES",
  "EPERM",
  "EROFS",
  "ENOSPC",
  "EDQUOT",
  "EMFILE",
  "ENFILE",
  "EIO",
  "EISDIR",
  "ENOTDIR"
]);

class FilesystemObjectStorage implements ObjectStorage {
  private readonly root: string;

  constructor(rootDirectory: string) {
    this.root = resolve(rootDirectory);
  }

  async put(key: string, body: Uint8Array | AsyncIterable<Uint8Array>): Promise<void> {
    const path = this.pathOf(key);
    try {
      await mkdir(dirname(path), { recursive: true });
      if (body instanceof Uint8Array) {
        await writeFile(path, body);
        return;
      }
      try {
        await pipeline(Readable.from(body), createWriteStream(path));
      } catch (error: unknown) {
        await rm(path, { force: true });
        throw error;
      }
    } catch (error: unknown) {
      throw toPortError(error, "write");
    }
  }

  async get(key: string) {
    const path = this.pathOf(key);
    const { size } = await this.head(key);
    return { size, body: readFileChunks(path) };
  }

  async head(key: string) {
    try {
      const stats = await stat(this.pathOf(key));
      if (!stats.isFile()) {
        throw new ObjectNotFound();
      }
      return { size: stats.size };
    } catch (error: unknown) {
      throw toPortError(error, "read");
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await rm(this.pathOf(key), { force: true });
    } catch (error: unknown) {
      throw toPortError(error, "write");
    }
  }

  async deletePrefix(prefix: string): Promise<{ deleted: number }> {
    try {
      const objects = await this.objectsBelow(prefix);
      // The prefix ends with a separator, so it names exactly this directory.
      await rm(this.pathOf(prefix), { recursive: true, force: true });
      return { deleted: objects.length };
    } catch (error: unknown) {
      throw toPortError(error, "write");
    }
  }

  async list(prefix: string, cursor?: string) {
    try {
      const after = cursor === undefined ? undefined : decodeCursor(cursor);
      const remaining = (await this.objectsBelow(prefix)).filter(
        (object) => after === undefined || compareKeys(object.key, after) > 0
      );
      const objects = remaining.slice(0, OBJECT_LIST_PAGE_SIZE);
      const last = objects.at(-1);
      return {
        objects,
        ...(remaining.length > objects.length && last ? { cursor: encodeCursor(last.key) } : {})
      };
    } catch (error: unknown) {
      throw toPortError(error, "read");
    }
  }

  /** Every object below a prefix in ascending key order, as an object store lists them. */
  private async objectsBelow(prefix: string): Promise<ObjectListEntry[]> {
    const directory = prefix === "" ? this.root : this.pathOf(prefix);
    let entries;
    try {
      entries = await readdir(directory, { recursive: true, withFileTypes: true });
    } catch (error: unknown) {
      if (codeOf(error) === "ENOENT" || codeOf(error) === "ENOTDIR") {
        return [];
      }
      throw error;
    }
    const objects: ObjectListEntry[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const path = resolve(entry.parentPath, entry.name);
      const key = path
        .slice(this.root.length + 1)
        .split(sep)
        .join("/");
      try {
        objects.push({ key, size: (await stat(path)).size });
      } catch (error: unknown) {
        // Deleted between the directory read and here: it is no longer an object.
        if (codeOf(error) !== "ENOENT") {
          throw error;
        }
      }
    }
    return objects.sort((left, right) => compareKeys(left.key, right.key));
  }

  private pathOf(key: string): string {
    const target = resolve(this.root, ...key.split("/"));
    if (target !== this.root && !target.startsWith(`${this.root}${sep}`)) {
      throw new ObjectStorageUnavailable("request_failed");
    }
    return target;
  }
}

async function* readFileChunks(path: string): AsyncIterable<Uint8Array> {
  try {
    for await (const chunk of createReadStream(path)) {
      if (chunk instanceof Uint8Array) {
        yield chunk;
      }
    }
  } catch (error: unknown) {
    throw toPortError(error, "read");
  }
}

/** Keys in the byte order of their UTF-8 form, which is how an object store orders a listing. */
function compareKeys(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function encodeCursor(key: string): string {
  return Buffer.from(key, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, "base64url").toString("utf8");
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function toPortError(error: unknown, access: "read" | "write"): Error {
  if (error instanceof ObjectNotFound || error instanceof ObjectStorageUnavailable) {
    return error;
  }
  const code = codeOf(error);
  // A path that is missing or runs through a file names no object. A write creates its
  // directories, so a missing path on a write is a failure of the store.
  if (access === "read" && (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR")) {
    return new ObjectNotFound();
  }
  const diagnostics = code && REPORTED_CODES.has(code) ? { providerErrorCode: code } : {};
  return new ObjectStorageUnavailable(
    code === "EACCES" || code === "EPERM" || code === "EROFS" ? "access_denied" : "request_failed",
    diagnostics
  );
}
