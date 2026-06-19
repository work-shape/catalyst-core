import type { ClientInstanceCapability } from "@vivd-catalyst/client-assembly";

export type {
  ClientInstanceAttachmentHandler,
  ClientInstanceCapability,
  ClientInstanceCapabilityContext,
  ClientInstanceCapabilityContribution,
  ClientInstanceManagedObjectReader,
  ClientInstanceManagedObjectReaderContribution
} from "@vivd-catalyst/client-assembly";
export type { ClientInstanceEnv, PlatformStoreMode } from "@vivd-catalyst/client-assembly";
export type {
  DataSourceQueryInput,
  DataSourceQueryResult,
  DataSourceRegistry,
  DataSourceRegistration
} from "@vivd-catalyst/data-source";
export { defineTool, defineConfiguredTool, toolFailed, toolSuccess } from "@vivd-catalyst/tool-sdk";
export type {
  AnyConfiguredToolDefinition,
  AnyToolDefinition,
  ConfiguredToolDefinition,
  ToolAssemblyDefinition,
  ToolDefinition
} from "@vivd-catalyst/tool-sdk";

export function defineCapability(capability: ClientInstanceCapability): ClientInstanceCapability {
  return capability;
}
