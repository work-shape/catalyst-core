import type { ChatAttachmentService } from "@vivd-catalyst/chat-server";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type {
  ClientInstanceId,
  ManagedArtifactId,
  ManagedFileId,
  PlatformStore
} from "@vivd-catalyst/core";
import type { AnyToolDefinition } from "@vivd-catalyst/tool-sdk";
import type { ClientInstanceEnv } from "./env";
import type { PlatformStoreMode } from "./store";

export interface ClientInstanceCapabilityContext {
  config: ClientInstanceConfig;
  clientInstanceId: ClientInstanceId;
  env: ClientInstanceEnv;
  store: PlatformStore;
  storeMode: PlatformStoreMode;
}

export interface ClientInstanceCapabilityContribution {
  tools?: AnyToolDefinition[];
  attachments?: ChatAttachmentService;
  managedObjects?: ClientInstanceManagedObjectReader;
  close?: () => Promise<void>;
}

export interface ClientInstanceManagedObjectReader {
  readArtifact(input: {
    clientInstanceId: ClientInstanceId;
    artifactId: ManagedArtifactId;
  }): Promise<{
    bytes: Uint8Array;
    mimeType: string;
  }>;
  readFile(input: {
    clientInstanceId: ClientInstanceId;
    fileId: ManagedFileId;
  }): Promise<{
    bytes: Uint8Array;
    mimeType?: string;
  }>;
}

export interface ClientInstanceCapability {
  name: string;
  create(
    context: ClientInstanceCapabilityContext
  ): ClientInstanceCapabilityContribution | Promise<ClientInstanceCapabilityContribution>;
}
