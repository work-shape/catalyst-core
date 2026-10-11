// What the tests of the Apps area read. The interface itself reaches these through the area
// route table, the surface renderers and the header of a Page.
export { AppEditFrame, appDraftIsAhead, PublishDialog } from "./app-edit";
export { appDraftFiles } from "./app-draft-files";
export { AppDeleteDialog, AppDetailsDialog, appLink } from "./app-header";
export {
  APP_ID_PATTERN,
  appIdFromName,
  appManifestSummary,
  appPreviewProblem,
  appPreviewProblemText,
  appRowActions,
  appState,
  NO_APP_RIGHTS,
  resolveAppRights,
  type AppRights
} from "./app-model";
export { AppPreviewNotice, appPreviewState } from "./app-preview";
export { AppViewFrame } from "./app-view";
export { AppsHostProvider, type AppsHost } from "./apps-host";
export { appRowRoute, AppsPageView } from "./apps-page";
export { RevisionsDrawerView } from "./revisions-drawer";
export { SaveAsAppAction, SaveAsAppDialogView } from "./save-as-app-dialog";
