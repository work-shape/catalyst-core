export { shippedSkillsOf } from "./shipped-skills";
export { readRunnerPackageManifest, RUNNER_PACKAGE_MANIFEST_PATH } from "./runner-packages";
export type { ClientInstanceEnv } from "./env";
export type {
  ConnectorTypeDefinition,
  StructuredDataPublicationReviewer
} from "@work-shape/catalyst-core";
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
export {
  assertCommandWorkerServesModuleJobKinds,
  platformModules,
  resolveInstanceModules,
  type InstanceModules
} from "./modules";
export { createInstanceConnections, type InstanceConnections } from "./connections";
export { createConfigAssetSource } from "./config-asset-source";
export { createPlatformTools } from "./conversation-offer";
export { mailSendToolRights, mailSendersOf, outboundMailOf, releaseToolNames } from "./mail";
export { PLATFORM_TOOL_NAMES } from "./platform-orientation";
export { platformDocsSkill } from "./platform-docs-skill";
export {
  createInstanceWorkflows,
  workflowLimitCeilingsOf,
  type InstanceWorkflows,
  type InstanceWorkflowsParts
} from "./workflows";
// What a client that brings a Workflow as a file reads it with, as the engine does.
export { readWorkflowManifest } from "@work-shape/catalyst-workflows";
export {
  WORKFLOW_LIST_DESCRIPTION_MAX,
  WORKFLOW_LIST_NAME_MAX,
  createWorkflowAssetDefinitions,
  createWorkflowAssetKind,
  type PublishedWorkflow
} from "./workflow-assets";
export { checkWorkflowOwnRights, type WorkflowOwnRightsModules } from "./workflow-owned-account";
export {
  assertSandboxMemoryFitsHost,
  sandboxMemoryNeeded,
  sandboxMemoryTerms,
  type SandboxMemoryTerm
} from "./sandbox-memory";
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
// For a worker of a capability that calls a model, such as the document worker.
export { createWorkerCapabilityModels } from "./capability-models";
export { agentToolReferences } from "./tool-references";
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
export { createHttpRuntime } from "@work-shape/catalyst-server";
export {
  API_KEY_ENV_NAME,
  createLocalApiKey,
  runLocalKeyCli,
  writeApiKeyToEnvFile,
  type LocalApiKeyOptions,
  type LocalKeyCliRuntime
} from "./local-key";

export {
  createClientInstanceKnowledgeWorker,
  runClientInstanceKnowledgeWorker,
  type ClientInstanceKnowledgeWorker,
  type CreateClientInstanceKnowledgeWorkerInput,
  type KnowledgeWorkerPlacement
} from "./knowledge-worker";
