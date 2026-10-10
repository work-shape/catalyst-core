import type { ObjectStorage, ProviderDefinition } from "@vivd-catalyst/core";
import { filesystemObjectStorageProvider } from "./adapters/filesystem";
import { s3ObjectStorageProvider } from "./adapters/s3";

export { createFilesystemObjectStorage } from "./adapters/filesystem";

/**
 * Every object storage adapter of the product. The only file that imports them. Each entry
 * under `infrastructure.objectStorage` names one of them and gets a store of its own.
 */
export const objectStorageProviderDefinitions: readonly ProviderDefinition<
  "objectStorage",
  ObjectStorage
>[] = [filesystemObjectStorageProvider, s3ObjectStorageProvider];
