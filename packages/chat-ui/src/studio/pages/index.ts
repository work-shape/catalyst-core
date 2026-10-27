// What the tests of the Page surface read. The interface itself reaches these through the
// surface renderers and the tool call card.
export {
  callResultMessage,
  contextMessage,
  createPageBridge,
  readPageMessage,
  themeMessage,
  workflowRunResultMessage,
  type ArrivedMessage
} from "./bridge-host";
export {
  AssetPreviewCardView,
  assetPreviewSurfaceAfterRunCalls,
  previewedDraftOfCall
} from "./asset-preview";
export {
  createFrameCalls,
  frameCallFailure,
  frameSessionProof,
  type FrameAddress,
  type FrameCallAnswer,
  type FrameCalls,
  type FrameTestRun,
  type FrameWorkflowRunAnswer
} from "./frame-calls";
export { useFrameCallTexts } from "./frame-call-texts";
export { FrameTestRunView, frameTestRunTitle } from "./frame-test-run";
export {
  PAGE_ADDRESS_LIFETIME_MS,
  PAGE_ADDRESS_RENEWAL_MARGIN_MS,
  PAGE_ADDRESS_RETRY_MAX_MS,
  PAGE_ADDRESS_RETRY_MS,
  heldPageAddress,
  keepPageAddress,
  pageAddressRetryDelay,
  pageAddressToShow,
  pageIsGone,
  type PageAddressState
} from "./page-address";
export { PageSaveCardView } from "./page-card";
export { changedSourcePaths, defaultOpenPath, PageFilesView } from "./page-files";
export { PageHostProvider } from "./page-host";
export {
  PREVIEW_GREETING_MS,
  PREVIEW_KEEP_ALIVE_MS,
  PREVIEW_REPORT_INTERVAL_MS,
  PREVIEW_SETTLE_FALLBACK_MS,
  createPreviewReporter,
  type PreviewReporter
} from "./preview-report";
export {
  codeColouring,
  HIGHLIGHT_MAX_CHARS,
  HIGHLIGHT_MAX_LINES,
  highlightCode
} from "../../shared/code-highlight";
export { StoredFileView } from "../../shared/stored-file-view";
export {
  pageBuildingSurface,
  pageSurface,
  pageSurfaceAfterRunCalls,
  readPageSave,
  type PageSave
} from "./page-save";
export {
  pageBuildingSurfaceRendering,
  pageFrameAddress,
  PageBuildErrors,
  pageSurfaceRendering,
  PageSurfaceView
} from "./page-surface";
export { DraftHostsNotice } from "./draft-hosts-notice";
export { PreviewPane, type PreviewPaneProps } from "./preview-pane";
