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
export * from "./schema/assetRepos";
export * from "./schema/approvals";
export * from "./schema/jobs";
export * from "./schema/operationRuns";
export * from "./schema/access";
export * from "./schema/infrastructure";
export * from "./schema/pages";
export * from "./schema/connections";
export * from "./schema/workflowRuns";
export * from "./schema/dataStores";
export * from "./schema/knowledgeBases";
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
import { assetCheckouts, assetRepoBundles } from "./schema/assetRepos";
import { approvalRequests } from "./schema/approvals";
import { platformJobs } from "./schema/jobs";
import { operationRuns } from "./schema/operationRuns";
import { permissionGrants, namespaces } from "./schema/access";
import { infrastructureCheckState } from "./schema/infrastructure";
import { pages, fileSets, pageBuilds } from "./schema/pages";
import { secrets, connectionState } from "./schema/connections";
import { workflowRuns, workflowStepRuns } from "./schema/workflowRuns";
import { dataStores } from "./schema/dataStores";
import { knowledgeBaseStates } from "./schema/knowledgeBases";

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
  assetRepoBundles,
  assetCheckouts,
  platformJobs,
  operationRuns,
  permissionGrants,
  namespaces,
  infrastructureCheckState,
  pages,
  fileSets,
  pageBuilds,
  secrets,
  connectionState,
  workflowRuns,
  workflowStepRuns,
  dataStores,
  knowledgeBaseStates
};
