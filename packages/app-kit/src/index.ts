// The App Kit as a Page imports it: `@work-shape/catalyst-app-kit`. The components of the
// shared UI library come along, so a Page needs one import name for both.
export * from "@vivd-catalyst/ui";
export {
  AppCallError,
  actions,
  createAppClient,
  createFrameTransport,
  getContext,
  navigate,
  onThemeChange,
  resize,
  workflowRuns,
  type AppCallOptions,
  type AppClient,
  type Transport
} from "./client";
export { mountApp } from "./mount";
export { useWorkflowRun, workflowRunEnded, type FollowedWorkflowRun } from "./workflow-run";
export type {
  AppActionPermission,
  AppCallFailure,
  AppCallResult,
  AppContext,
  AppTheme,
  AppThemeChange,
  AppThemeMode,
  AppWorkflowRun,
  AppWorkflowRunStatus,
  HostMessage,
  PageMessage
} from "./protocol";
