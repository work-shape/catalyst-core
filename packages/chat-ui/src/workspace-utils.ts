import { appErrorCodeSchema, type ApiErrorCode, type LocaleCode } from "@vivd-catalyst/api-client";
import type { ThemeModePreference } from "./theme";

export const STANDALONE_AUTH_SOURCE = "better-auth";
export const DEFAULT_LOCALES: LocaleCode[] = ["en", "de"];

const THEME_STORAGE_KEY = "vivd-catalyst:theme";
const LOCALE_STORAGE_KEY = "vivd-catalyst:locale";
const CONTEXT_INDICATOR_STORAGE_KEY = "vivd-catalyst:show-context-indicator";
const RESOURCES_PANEL_STORAGE_KEY = "vivd-catalyst:resources-panel";
const COLLABORATION_WORKSPACE_STORAGE_PREFIX = "vivd-catalyst:collaboration-workspace";
const SURFACE_WIDTH_STORAGE_PREFIX = "vivd-catalyst:surface-width";

export type ResourcesPanelPreference = "open" | "closed";

export function createDraftKey(authScope: string, conversationId: string | undefined): string {
  return `${authScope}:${conversationId ?? "new"}`;
}

export function apiErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || Array.isArray(error) || !("status" in error)) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Stable `AppError` code carried on API failures. Preferred over the HTTP status
 * so the UI never has to match server prose.
 */
export function apiErrorCode(error: unknown): ApiErrorCode | undefined {
  if (!error || typeof error !== "object" || Array.isArray(error) || !("code" in error)) {
    return undefined;
  }
  const parsed = appErrorCodeSchema.safeParse(error.code);
  return parsed.success ? parsed.data : undefined;
}

export function apiErrorMessage(error: unknown, fallback: string | undefined): string | undefined {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (error && typeof error === "object" && !Array.isArray(error) && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) {
      return message;
    }
  }
  return fallback;
}

export function createEnvironmentDocumentTitle(
  title: string,
  environment: string | undefined
): string {
  return environment === "staging" ? `(Test) ${title}` : title;
}

/** The person's own choice of theme. Nothing stored means the instance's default applies. */
export function readStoredThemeMode(): ThemeModePreference | undefined {
  const storedThemeMode = window.localStorage.getItem(THEME_STORAGE_KEY);
  return storedThemeMode === "dark" || storedThemeMode === "light" || storedThemeMode === "system"
    ? storedThemeMode
    : undefined;
}

export function writeStoredThemeMode(themeMode: ThemeModePreference): void {
  window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
}

export function readStoredLocale(): LocaleCode | undefined {
  const storedLocale = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  return storedLocale === "en" || storedLocale === "de" ? storedLocale : undefined;
}

export function writeStoredLocale(locale: LocaleCode): void {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
}

export function readStoredContextIndicatorPreference(): boolean {
  return window.localStorage.getItem(CONTEXT_INDICATOR_STORAGE_KEY) === "true";
}

export function writeStoredContextIndicatorPreference(visible: boolean): void {
  window.localStorage.setItem(CONTEXT_INDICATOR_STORAGE_KEY, String(visible));
}

export function readStoredResourcesPanelPreference(): ResourcesPanelPreference | undefined {
  const preference = window.localStorage.getItem(RESOURCES_PANEL_STORAGE_KEY);
  return preference === "open" || preference === "closed" ? preference : undefined;
}

export function writeStoredResourcesPanelPreference(preference: ResourcesPanelPreference): void {
  window.localStorage.setItem(RESOURCES_PANEL_STORAGE_KEY, preference);
}

/**
 * The width a person gave the surface slot, in pixels, kept per surface kind under a key of
 * its own. What is stored is the width that was chosen; `limits` clamps it on every read, so
 * a width chosen in a wider window never takes the other side below its minimum.
 */
export function readStoredSurfaceWidth(
  kind: string,
  limits: { min: number; max: number }
): number | undefined {
  const width = Number(window.localStorage.getItem(`${SURFACE_WIDTH_STORAGE_PREFIX}:${kind}`));
  if (!Number.isFinite(width) || width <= 0) {
    return undefined;
  }
  return Math.round(Math.min(Math.max(width, limits.min), Math.max(limits.min, limits.max)));
}

export function writeStoredSurfaceWidth(kind: string, width: number): void {
  window.localStorage.setItem(`${SURFACE_WIDTH_STORAGE_PREFIX}:${kind}`, String(Math.round(width)));
}

/**
 * The last active Collaboration Workspace is browser-local and scoped by client
 * instance (api base url) and authenticated user, so shared browsers never leak
 * one person's workspace choice into another's session.
 */
function collaborationWorkspaceStorageKey(apiBaseUrl: string, userId: string): string {
  return `${COLLABORATION_WORKSPACE_STORAGE_PREFIX}:${apiBaseUrl}:${userId}`;
}

export function readStoredCollaborationWorkspaceId(
  apiBaseUrl: string,
  userId: string
): string | undefined {
  return (
    window.localStorage.getItem(collaborationWorkspaceStorageKey(apiBaseUrl, userId)) ?? undefined
  );
}

export function writeStoredCollaborationWorkspaceId(
  apiBaseUrl: string,
  userId: string,
  collaborationWorkspaceId: string
): void {
  window.localStorage.setItem(
    collaborationWorkspaceStorageKey(apiBaseUrl, userId),
    collaborationWorkspaceId
  );
}

/**
 * Called when the stored workspace is gone (deleted), so the next application
 * root visit falls back to the Personal Workspace instead of a dead id.
 */
export function clearStoredCollaborationWorkspaceId(apiBaseUrl: string, userId: string): void {
  window.localStorage.removeItem(collaborationWorkspaceStorageKey(apiBaseUrl, userId));
}

export function applyFavicon(href: string): void {
  const selector = "link[rel~='icon'][data-vivd-favicon='true']";
  const existing =
    document.head.querySelector<HTMLLinkElement>(selector) ??
    document.head.querySelector<HTMLLinkElement>("link[rel~='icon']");
  const link = existing ?? document.createElement("link");
  link.rel = "icon";
  link.type = href.endsWith(".svg") ? "image/svg+xml" : "image/png";
  link.href = href;
  link.dataset.vivdFavicon = "true";
  if (!existing) {
    document.head.appendChild(link);
  }
}
