import type { ChatAttachmentService, UploadDraftAttachmentInput } from "@vivd-catalyst/chat-server";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { DataSourceRegistry } from "@vivd-catalyst/data-source";
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
  dataSources: DataSourceRegistry;
  env: ClientInstanceEnv;
  store: PlatformStore;
  storeMode: PlatformStoreMode;
}

export interface ClientInstanceCapabilityContribution {
  tools?: AnyToolDefinition[];
  attachments?: ClientInstanceAttachmentHandler[];
  managedObjects?: ClientInstanceManagedObjectReaderContribution[];
  close?: () => Promise<void>;
}

export interface ClientInstanceAttachmentHandler extends ChatAttachmentService {
  name: string;
  acceptsFile(input: Pick<UploadDraftAttachmentInput, "filename" | "mimeType" | "bytes">): boolean;
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

export interface ClientInstanceManagedObjectReaderContribution extends ClientInstanceManagedObjectReader {
  name: string;
}

export interface ClientInstanceCapability {
  name: string;
  create(
    context: ClientInstanceCapabilityContext
  ): ClientInstanceCapabilityContribution | Promise<ClientInstanceCapabilityContribution>;
}
