export { ChatShell } from "./chat-shell";
export { defineToolDisplayWidget, toolDisplayWidgetRegistry } from "./shared/domain-ui-widgets";
export { renderStandaloneChatApp } from "./standalone-chat-app";
export type { ChatShellProps } from "./chat-shell";
export type {
  ChatShellAdministration,
  PageDefinition,
  SettingsGroupId,
  SettingsPageDefinition,
  SettingsScope,
  SettingsViewer
} from "./shared/page-definition";
export { useSettingsPage, type SettingsPageContextValue } from "./shared/settings-page-context";
export type {
  StandardSchemaV1,
  ToolDisplayActions,
  ToolDisplayRenderInput,
  ToolDisplayWidget,
  ToolDisplayWidgetRegistry
} from "./shared/domain-ui-widgets";
export type { StandaloneChatAppOptions } from "./standalone-chat-app";
export { createTranslationContext, TranslationProvider, useTranslation } from "./shared/i18n";
export { composeViewDocument, viewRuntimeAddress } from "./chat/views/view-document";
export type { ViewDocumentInput, ViewRuntimeAddress } from "./chat/views/view-document";
