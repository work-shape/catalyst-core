import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { posix as posixPath } from "node:path";
import type {
  ClientInstanceId,
  ConversationId,
  ExecutionWorkspaceId,
  WorkspaceCommandId
} from "@vivd-catalyst/core";

export interface WorkspaceObjectStore {
  getObject(key: string): Promise<Uint8Array>;
}

export interface WorkspaceFileByteStore extends WorkspaceObjectStore {
  putWorkspaceFile(input: PutWorkspaceFileBytesInput): Promise<{
    objectKey: string;
  }>;
  deleteObject?(key: string): Promise<void>;
}

export interface PutWorkspaceFileBytesInput {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  workspaceId: ExecutionWorkspaceId;
  commandId: WorkspaceCommandId;
  path: string;
  bytes: Uint8Array;
  checksum: string;
  mimeType?: string;
}

export interface WorkspaceObjectStorage {
  putObject(input: {
    key: string;
    body: Uint8Array;
    contentType?: string;
  }): Promise<void>;
  getObject(key: string): Promise<Uint8Array>;
  deleteObject?(key: string): Promise<void>;
}

export interface DeletableWorkspaceObjectStorage extends WorkspaceObjectStorage {
  deleteObject(key: string): Promise<void>;
}

export interface WorkspaceFileObjectKeyFactory {
  createWorkspaceFileObjectKey(input: WorkspaceFileObjectKeyInput): string;
}

export type WorkspaceFileObjectKeyInput = Omit<PutWorkspaceFileBytesInput, "bytes"> & {
  byteSize: number;
};

export function createObjectStoreWorkspaceFileByteStore(input: {
  objectStore: WorkspaceObjectStorage;
  keyFactory?: WorkspaceFileObjectKeyFactory;
}): WorkspaceFileByteStore {
  return new ObjectStoreWorkspaceFileByteStore(
    input.objectStore,
    input.keyFactory ?? DEFAULT_WORKSPACE_FILE_OBJECT_KEY_FACTORY
  );
}

export function createLocalWorkspaceFileByteStore(input: {
  rootDirectory: string;
  keyFactory?: WorkspaceFileObjectKeyFactory;
}): WorkspaceFileByteStore {
  return new LocalWorkspaceFileByteStore(
    input.rootDirectory,
    input.keyFactory ?? DEFAULT_WORKSPACE_FILE_OBJECT_KEY_FACTORY
  );
}

export function createLocalWorkspaceObjectStorage(input: {
  rootDirectory: string;
}): DeletableWorkspaceObjectStorage {
  return new LocalWorkspaceObjectStorage(input.rootDirectory);
}

export const DEFAULT_WORKSPACE_FILE_OBJECT_KEY_FACTORY: WorkspaceFileObjectKeyFactory = {
  createWorkspaceFileObjectKey(input) {
    return [
      "execution-workspaces",
      encodeObjectKeySegment(input.clientInstanceId),
      encodeObjectKeySegment(input.conversationId),
      encodeObjectKeySegment(input.workspaceId),
      encodeObjectKeySegment(input.commandId),
      encodeObjectKeySegment(input.checksum),
      ...input.path.split("/").map(encodeObjectKeySegment)
    ].join("/");
  }
};

class ObjectStoreWorkspaceFileByteStore implements WorkspaceFileByteStore {
  constructor(
    private readonly objectStore: WorkspaceObjectStorage,
    private readonly keyFactory: WorkspaceFileObjectKeyFactory
  ) {}

  async getObject(key: string): Promise<Uint8Array> {
    return this.objectStore.getObject(key);
  }

  async putWorkspaceFile(input: PutWorkspaceFileBytesInput): Promise<{ objectKey: string }> {
    const objectKey = this.keyFactory.createWorkspaceFileObjectKey({
      ...input,
      byteSize: input.bytes.byteLength
    });
    await this.objectStore.putObject({
      key: objectKey,
      body: input.bytes,
      contentType: input.mimeType
    });
    return { objectKey };
  }

  async deleteObject(key: string): Promise<void> {
    if (!this.objectStore.deleteObject) {
      throw new Error("Workspace object storage does not support object deletion");
    }
    await this.objectStore.deleteObject(key);
  }
}

class LocalWorkspaceFileByteStore implements WorkspaceFileByteStore {
  private readonly objectStorage: LocalWorkspaceObjectStorage;

  constructor(
    private readonly rootDirectory: string,
    private readonly keyFactory: WorkspaceFileObjectKeyFactory
  ) {
    this.objectStorage = new LocalWorkspaceObjectStorage(rootDirectory);
  }

  async getObject(key: string): Promise<Uint8Array> {
    return this.objectStorage.getObject(key);
  }

  async putWorkspaceFile(input: PutWorkspaceFileBytesInput): Promise<{ objectKey: string }> {
    const objectKey = this.keyFactory.createWorkspaceFileObjectKey({
      ...input,
      byteSize: input.bytes.byteLength
    });
    await this.objectStorage.putObject({
      key: objectKey,
      body: input.bytes,
      contentType: input.mimeType
    });
    return { objectKey };
  }

  async deleteObject(key: string): Promise<void> {
    await this.objectStorage.deleteObject(key);
  }
}

class LocalWorkspaceObjectStorage implements WorkspaceObjectStorage {
  constructor(private readonly rootDirectory: string) {}

  async putObject(input: { key: string; body: Uint8Array; contentType?: string }): Promise<void> {
    const objectPath = this.resolveObjectPath(input.key);
    await mkdir(dirname(objectPath), { recursive: true });
    await writeFile(objectPath, input.body);
    void input.contentType;
  }

  async getObject(key: string): Promise<Uint8Array> {
    return readFile(this.resolveObjectPath(key));
  }

  async deleteObject(key: string): Promise<void> {
    await rm(this.resolveObjectPath(key), { force: true });
  }

  private resolveObjectPath(key: string): string {
    const normalized = normalizeObjectKey(key);
    const root = resolve(this.rootDirectory);
    const target = resolve(root, ...normalized.split("/"));
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new Error(`Workspace object key '${key}' escapes the local object root`);
    }
    return target;
  }
}

function normalizeObjectKey(key: string): string {
  if (
    key.trim().length === 0 ||
    key.includes("\0") ||
    key.startsWith("/") ||
    key.startsWith("\\") ||
    key.includes("\\")
  ) {
    throw new Error(`Invalid workspace object key '${key}'`);
  }
  const normalized = posixPath.normalize(key);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Invalid workspace object key '${key}'`);
  }
  return normalized;
}

function encodeObjectKeySegment(value: string): string {
  return encodeURIComponent(value);
}
