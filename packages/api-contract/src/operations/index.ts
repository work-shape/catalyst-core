import { accessOperations } from "./access";
import { accountOperations } from "./account";
import { apiAccessOperations } from "./api-access";
import { approvalRequestOperations } from "./approval-requests";
import { collaborationWorkspaceOperations } from "./collaboration-workspaces";
import { configAssetOperations } from "./config-assets";
import { conversationFileOperations } from "./conversation-files";
import { conversationOperations } from "./conversations";
import { credentialOperations } from "./credentials";
import { governanceOperations } from "./governance";
import { instanceOperations } from "./instance";
import { jobOperations } from "./jobs";
import { operationRunOperations } from "./operations";
import { referenceOperations } from "./reference";
import { systemOperations } from "./system";
import { userOperations } from "./users";

/** Every product operation of the HTTP API, one file per area. */
export const apiOperations = {
  ...approvalRequestOperations,
  ...accountOperations,
  ...instanceOperations,
  ...collaborationWorkspaceOperations,
  ...conversationOperations,
  ...conversationFileOperations,
  ...governanceOperations,
  ...jobOperations,
  ...operationRunOperations,
  ...configAssetOperations,
  ...userOperations,
  ...apiAccessOperations,
  ...accessOperations,
  ...credentialOperations,
  ...referenceOperations,
  ...systemOperations
} as const;

export type ApiOperationName = keyof typeof apiOperations;
