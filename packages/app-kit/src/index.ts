// The App Kit as a Page imports it: `@work-shape/catalyst-app-kit`. The components of the
// shared UI library come along, so a Page needs one import name for both.
export * from "@work-shape/catalyst-ui";
export {
  AppCallError,
  actions,
  createAppClient,
  createFrameTransport,
  feedback,
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
export { APP_FEEDBACK_MAX_LENGTH, AppFeedback, type AppFeedbackProps } from "./feedback";
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

export { storage } from "./storage";
