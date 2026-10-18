// What the tests of the Apps area read. The interface itself reaches these through the area
// route table, the surface renderers and the header of a Page.
export { ActionTestDialogView } from "./action-test-dialog";
export { AppActionsView, type AppActionsLiveOnce } from "./actions-view";
export {
  appActionInputStart,
  appActionLiveOnceOffered,
  appActionOutcome,
  appActionTestable,
  appActionTestOutcome,
  formatAppActionResult,
  keptWhileItServes,
  readAppActionInput
} from "./app-actions-model";
export {
  appPublishDataKey,
  appPublishDataRead,
  type AppActionsRead,
  type AppPublishDataRead
} from "./app-data";
export { AppEdit, AppEditFrame, appDraftIsAhead, PublishDialog, SharePublishDialog } from "./app-edit";
export { AppSavedLine } from "./app-saved-line";
export { AppAudienceChange, appPublishMaySend } from "./app-publish-question";
export {
  appPublishCall,
  appPublishConfirmationReady,
  AppPublishConfirmationView
} from "./app-publish-confirmation";
export { AppDeleteDialog, AppDetailsDialog, appLink } from "./app-header";
export {
  appManifestSummary,
  appReadsStoredData,
  appPreviewProblem,
  appPreviewProblemText,
  appDraftShown,
  appRefusalText,
  appsRowShown,
  appRowActions,
  appState,
  NO_APP_RIGHTS,
  resolveAppRights,
  type AppRights
} from "./app-model";
export { AppPreviewNotice, appPreviewState } from "./app-preview";
export { AppPublishDataView, AppStoredDataFact } from "./app-publish-data";
export { AppToolsGroup, appsOfOwner, appToolsView, type AppToolsRead } from "./app-tools-group";
export { AppView, AppViewFrame } from "./app-view";
export { AppsHostProvider, type AppsHost } from "./apps-host";
export { appRowRoute, AppsPage, AppsPageView } from "./apps-page";
export { RevisionsDrawerView } from "./revisions-drawer";
export { pageAppChoice } from "./page-app-action";
export { SaveAsAppAction, SaveAsAppDialogView, saveAsAppInput } from "./save-as-app-dialog";
export { UpdateAppAction, UpdateAppDialogView } from "./update-app-dialog";
// The address of the area and its row in the rail, which the same tests hold.
export {
  areaOfRoute,
  workspaceRouteFromPath,
  workspaceRouteNavigation,
  workspaceRoutePath
} from "../../shared/routes";
export { railSections, shownRailSections } from "../../chat/workspace/rail-sections";
export { WorkspaceRail } from "../../chat/workspace/workspace-rail";
export { parseAppOpens, railApps, RAIL_APPS_LIMIT, withAppOpen, type RailApp } from "./rail-apps";
