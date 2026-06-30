export type { ClientInstanceEnv } from "./env";
export type {
  ClientInstanceCapability,
  ClientInstanceCapabilityContext,
  ClientInstanceCapabilityContribution,
  ClientInstanceAttachmentHandler,
  ClientInstanceCapabilityFiles,
  ClientInstanceManagedObjectReaderContribution,
  ClientInstanceManagedObjectReader,
  ManagedObjectAccessFactory
} from "./capabilities";
export {
  createClientInstanceApp,
  type ClientInstanceApp,
  type CreateClientInstanceAppInput
} from "./app";
export {
  defineClientInstance,
  type DefinedClientInstance,
  type DefineClientInstanceInput
} from "./defined-client-instance";
export {
  seedStandaloneAuth,
  type SeedStandaloneAuthInput,
  type SeedStandaloneAuthResult
} from "./seed-auth";
export { createPlatformStore, type PlatformStoreMode } from "./store";
export { createToolDefinitions } from "./tools";
export {
  applyWorkspaceRunnerImageEnvOverride,
  createClientInstanceWorkspaceCommandWorker,
  runClientInstanceWorkspaceCommandWorker,
  type ClientInstanceWorkspaceCommandWorker,
  type CreateClientInstanceWorkspaceCommandWorkerInput
} from "./workspace-command-worker";
export {
  createExecutionWorkspaceManagedObjectReader,
  createExecutionWorkspaceSourceAttachmentHandler,
  detectWorkspaceSourceFileFormat,
  WORKSPACE_SOURCE_ACCEPTED_FILE_TYPES
} from "./workspace-source-attachments";
