// What the tests of the Apps area read. The interface itself reaches these through the area
// route table, the surface renderers and the header of a Page.
export { ActionTestDialogView } from "./action-test-dialog";
export { AppActionsView } from "./actions-view";
export {
  appActionInputStart,
  appActionOutcome,
  appActionTestable,
  appActionTestOutcome,
  formatAppActionResult,
  keptWhileItServes,
  readAppActionInput
} from "./app-actions-model";
export type { AppActionsRead } from "./app-data";
export { AppEditFrame, appDraftIsAhead, PublishDialog } from "./app-edit";
export { AppDeleteDialog, AppDetailsDialog, appLink } from "./app-header";
export {
  APP_ID_PATTERN,
  appIdFromName,
  appManifestSummary,
  appPreviewProblem,
  appPreviewProblemText,
  appDraftShown,
  appRefusalText,
  appRowActions,
  appState,
  NO_APP_RIGHTS,
  resolveAppRights,
  type AppRights
} from "./app-model";
export { AppPreviewNotice, appPreviewState } from "./app-preview";
export { AppToolsGroup, appToolsView, type AppToolsRead } from "./app-tools-group";
export { AppViewFrame } from "./app-view";
export { AppsHostProvider, type AppsHost } from "./apps-host";
export { appRowRoute, AppsPageView } from "./apps-page";
export { RevisionsDrawerView } from "./revisions-drawer";
export { SaveAsAppAction, SaveAsAppDialogView } from "./save-as-app-dialog";
// The address of the area and its row in the rail, which the same tests hold.
export {
  areaOfRoute,
  workspaceRouteFromPath,
  workspaceRouteNavigation,
  workspaceRoutePath
} from "../routes";
export { railSections, shownRailSections } from "../workspace/rail-sections";
