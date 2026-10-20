// The tables of the store, one file per area under `schema/`. A new file is one more line in
// each list below; drizzle-kit reads the tables from the re-exports, and `schema` gives the
// query builder every table of every file.

import * as accessTables from "./schema/access";
import * as agentProposalsTables from "./schema/agentProposals";
import * as agentRunsTables from "./schema/agentRuns";
import * as agentTryConversationsTables from "./schema/agentTryConversations";
import * as apiAccessTables from "./schema/apiAccess";
import * as approvalsTables from "./schema/approvals";
import * as assetReposTables from "./schema/assetRepos";
import * as auditTables from "./schema/audit";
import * as configAssetsTables from "./schema/configAssets";
import * as connectionsTables from "./schema/connections";
import * as conversationCreatedAssetsTables from "./schema/conversationCreatedAssets";
import * as conversationsTables from "./schema/conversations";
import * as dataScopesTables from "./schema/dataScopes";
import * as dataStoresTables from "./schema/dataStores";
import * as executionWorkspacesTables from "./schema/executionWorkspaces";
import * as feedbackTables from "./schema/feedback";
import * as filesTables from "./schema/files";
import * as followUpsTables from "./schema/followUps";
import * as guardrailsTables from "./schema/guardrails";
import * as infrastructureTables from "./schema/infrastructure";
import * as jobsTables from "./schema/jobs";
import * as knowledgeBasesTables from "./schema/knowledgeBases";
import * as liveOnceSwitchesTables from "./schema/liveOnceSwitches";
import * as noticeMailTables from "./schema/noticeMail";
import * as operationRunsTables from "./schema/operationRuns";
import * as pagesTables from "./schema/pages";
import * as scheduledStartsTables from "./schema/scheduledStarts";
import * as structuredDataTables from "./schema/structuredData";
import * as usageTables from "./schema/usage";
import * as usersTables from "./schema/users";
import * as workflowDatasetsTables from "./schema/workflowDatasets";
import * as workflowRunsTables from "./schema/workflowRuns";
import * as workspacesTables from "./schema/workspaces";

export * from "./schema/access";
export * from "./schema/agentProposals";
export * from "./schema/agentRuns";
export * from "./schema/agentTryConversations";
export * from "./schema/apiAccess";
export * from "./schema/approvals";
export * from "./schema/assetRepos";
export * from "./schema/audit";
export * from "./schema/configAssets";
export * from "./schema/connections";
export * from "./schema/conversationCreatedAssets";
export * from "./schema/conversations";
export * from "./schema/dataScopes";
export * from "./schema/dataStores";
export * from "./schema/executionWorkspaces";
export * from "./schema/feedback";
export * from "./schema/files";
export * from "./schema/followUps";
export * from "./schema/guardrails";
export * from "./schema/infrastructure";
export * from "./schema/jobs";
export * from "./schema/knowledgeBases";
export * from "./schema/liveOnceSwitches";
export * from "./schema/noticeMail";
export * from "./schema/operationRuns";
export * from "./schema/pages";
export * from "./schema/scheduledStarts";
export * from "./schema/structuredData";
export * from "./schema/usage";
export * from "./schema/users";
export * from "./schema/workflowDatasets";
export * from "./schema/workflowRuns";
export * from "./schema/workspaces";

export const schema = {
  ...accessTables,
  ...agentProposalsTables,
  ...agentRunsTables,
  ...agentTryConversationsTables,
  ...apiAccessTables,
  ...approvalsTables,
  ...assetReposTables,
  ...auditTables,
  ...configAssetsTables,
  ...connectionsTables,
  ...conversationCreatedAssetsTables,
  ...conversationsTables,
  ...dataScopesTables,
  ...dataStoresTables,
  ...executionWorkspacesTables,
  ...feedbackTables,
  ...filesTables,
  ...followUpsTables,
  ...guardrailsTables,
  ...infrastructureTables,
  ...jobsTables,
  ...knowledgeBasesTables,
  ...liveOnceSwitchesTables,
  ...noticeMailTables,
  ...operationRunsTables,
  ...pagesTables,
  ...scheduledStartsTables,
  ...structuredDataTables,
  ...usageTables,
  ...usersTables,
  ...workflowDatasetsTables,
  ...workflowRunsTables,
  ...workspacesTables
};
