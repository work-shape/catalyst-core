import type { GrantKindEntry } from "./entry";

export const workflowKind: GrantKindEntry<"workflow"> = {
  label: "access.kindWorkflow",
  words: {
    scopeAsset: "access.scopeWorkflow",
    object: "access.objectWorkflow",
    onAsset: "access.scopeOnWorkflow",
    onAssetDescription: "access.scopeOnWorkflowDescription",
    assetField: "access.grantWorkflow",
    chooseAsset: "access.chooseWorkflow",
    noAssets: "access.noWorkflows",
    assetsLoadFailed: "access.workflowsLoadFailed"
  },
  sentences: {
    "workflow.read": "access.actionReadWorkflowDescription",
    "workflow.use": "access.actionUseWorkflowDescription",
    "workflow.write": "access.actionWriteWorkflowDescription",
    "workflow.publish": "access.actionPublishWorkflowDescription",
    "workflow.delete": "access.actionDeleteWorkflowDescription",
    "workflow.read_run_data": "access.actionReadRunDataWorkflowDescription"
  },
  allowNotes: {
    "workflow.publish": "access.actionPublishWorkflowNote",
    "workflow.read_run_data": "access.actionReadRunDataWorkflowNote"
  }
};
