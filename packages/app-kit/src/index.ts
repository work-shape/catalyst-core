// The App Kit as a Page imports it: `@work-shape/catalyst-app-kit`. The components of the
// shared UI library come along, so a Page needs one import name for both.
export * from "@vivd-catalyst/ui";
export {
  createAppClient,
  createFrameTransport,
  getContext,
  navigate,
  onThemeChange,
  resize,
  type AppClient,
  type Transport
} from "./client";
export { mountApp } from "./mount";
export type {
  AppContext,
  AppTheme,
  AppThemeChange,
  AppThemeMode,
  HostMessage,
  PageMessage
} from "./protocol";
