// What the tests of the Page surface read. The interface itself reaches these through the
// surface renderers and the tool call card.
export {
  callResultMessage,
  contextMessage,
  createPageBridge,
  readPageMessage,
  themeMessage,
  type ArrivedMessage
} from "./bridge-host";
export {
  createFrameCalls,
  frameCallFailure,
  frameSessionProof,
  type FrameAddress,
  type FrameCallAnswer,
  type FrameCalls
} from "./frame-calls";
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
  codeColouring,
  HIGHLIGHT_MAX_CHARS,
  HIGHLIGHT_MAX_LINES,
  highlightCode
} from "../code-highlight";
export { StoredFileView } from "../stored-file-view";
export { pageSurface, pageSurfaceAfterRunCalls, readPageSave, type PageSave } from "./page-save";
export {
  pageFrameAddress,
  PageBuildErrors,
  pageSurfaceRendering,
  PageSurfaceView
} from "./page-surface";
export { PreviewPane, type PreviewPaneProps } from "./preview-pane";
