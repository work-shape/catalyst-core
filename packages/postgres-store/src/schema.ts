export * from "./schema/users";
export * from "./schema/workspaces";
export * from "./schema/apiAccess";
export * from "./schema/conversations";
export * from "./schema/agentRuns";
export * from "./schema/executionWorkspaces";
export * from "./schema/files";
export * from "./schema/structuredData";
export * from "./schema/audit";
export * from "./schema/usage";
export * from "./schema/configAssets";
export * from "./schema/approvals";
export * from "./schema/jobs";
export * from "./schema/operationRuns";
export * from "./schema/access";
export * from "./schema/infrastructure";
import { productUsers, userIdentities } from "./schema/users";
import { servicePrincipals, apiCredentials } from "./schema/apiAccess";
import { conversations, messages, modelProviderContinuations } from "./schema/conversations";
import { agentRuns, agentRunObservations, runStartCommands } from "./schema/agentRuns";
import {
  executionWorkspaces,
  workspaceCommands,
  executionWorkspaceFiles
} from "./schema/executionWorkspaces";
import {
  managedFiles,
  managedArtifacts,
  artifactPreviewJobs,
  artifactPreviewManifests,
  conversationAttachments
} from "./schema/files";
import { structuredDataResources } from "./schema/structuredData";
import { auditEvents } from "./schema/audit";
import { modelUsageEvents } from "./schema/usage";
import { configAssetState, configAssets, configAssetRevisions } from "./schema/configAssets";
import { approvalRequests } from "./schema/approvals";
import { platformJobs } from "./schema/jobs";
import { operationRuns } from "./schema/operationRuns";
import { permissionGrants, namespaces } from "./schema/access";
import { infrastructureCheckState } from "./schema/infrastructure";

export const schema = {
  approvalRequests,
  productUsers,
  userIdentities,
  servicePrincipals,
  apiCredentials,
  conversations,
  messages,
  modelProviderContinuations,
  agentRuns,
  agentRunObservations,
  runStartCommands,
  executionWorkspaces,
  workspaceCommands,
  executionWorkspaceFiles,
  managedFiles,
  managedArtifacts,
  artifactPreviewJobs,
  artifactPreviewManifests,
  conversationAttachments,
  structuredDataResources,
  auditEvents,
  modelUsageEvents,
  configAssetState,
  configAssets,
  configAssetRevisions,
  platformJobs,
  operationRuns,
  permissionGrants,
  namespaces,
  infrastructureCheckState
};
