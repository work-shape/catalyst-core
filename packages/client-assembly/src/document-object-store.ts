import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  InMemoryObjectStore,
  S3ObjectStore,
  type ObjectStore
} from "@vivd-catalyst/document-processing";
import type { ClientInstanceEnv } from "./env";
import type { PlatformStoreMode } from "./store";

export function createDocumentObjectStore(input: {
  config: ClientInstanceConfig;
  env: ClientInstanceEnv;
  storeMode?: PlatformStoreMode;
}): ObjectStore {
  if ((input.storeMode ?? input.env.STORE) === "memory") {
    return new InMemoryObjectStore();
  }

  return new S3ObjectStore({
    config: {
      ...input.config.documents.objectStorage,
      bucket:
        nonEmptyEnv(input.env.DOCUMENT_OBJECT_STORE_BUCKET) ?? input.config.documents.objectStorage.bucket,
      region:
        nonEmptyEnv(input.env.DOCUMENT_OBJECT_STORE_REGION) ?? input.config.documents.objectStorage.region,
      endpoint:
        nonEmptyEnv(input.env.DOCUMENT_OBJECT_STORE_ENDPOINT) ?? input.config.documents.objectStorage.endpoint
    },
    env: input.env
  });
}

function nonEmptyEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
