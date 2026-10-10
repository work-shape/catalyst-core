export type { ClientInstanceEnv } from "./env";
export type { StructuredDataPublicationReviewer } from "@vivd-catalyst/core";
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
export type { AgentRunWorkerPlacement } from "./agent-run-jobs";
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
  createClientInstanceAgentRunWorker,
  runClientInstanceAgentRunWorker,
  type ClientInstanceAgentRunWorker,
  type CreateClientInstanceAgentRunWorkerInput
} from "./agent-run-worker";
export {
  seedStandaloneAuth,
  type SeedStandaloneAuthInput,
  type SeedStandaloneAuthResult
} from "./seed-auth";
export { createJobWorker, type CreateJobWorkerInput } from "./job-worker";
export { platformModules, resolveInstanceModules, type InstanceModules } from "./modules";
export { migrateClientInstanceDatabase } from "./migrate";
export { createPlatformStore } from "./store";
export {
  createEnvironmentSecrets,
  createInstanceInfrastructure,
  createSandbox,
  createSandboxCheckJobs,
  declaredSecretNames,
  infrastructureEntries,
  infrastructureOverview,
  PLATFORM_SECRET_NAMES,
  type InstanceInfrastructure
} from "./infrastructure";
export { createToolDefinitions } from "./tools";
export {
  applyWorkspaceRunnerImageEnvOverride,
  createClientInstanceWorkspaceCommandWorker,
  runClientInstanceWorkspaceCommandWorker,
  type ClientInstanceWorkspaceCommandWorker,
  type CreateClientInstanceWorkspaceCommandWorkerInput
} from "./workspace-command-worker";
export {
  createClientInstanceArtifactPreviewWorker,
  runClientInstanceArtifactPreviewWorker,
  type ClientInstanceArtifactPreviewWorker,
  type CreateClientInstanceArtifactPreviewWorkerInput
} from "./artifact-preview-worker";
export {
  createExecutionWorkspaceManagedObjectReader,
  createExecutionWorkspaceSourceAttachmentHandler,
  detectWorkspaceSourceFileFormat,
  WORKSPACE_SOURCE_ACCEPTED_FILE_TYPES
} from "./workspace-source-attachments";

export { createLogger } from "./logger";
// For a worker that serves HTTP beside the instance, such as the document worker.
export { createHttpRuntime } from "@vivd-catalyst/chat-server";
