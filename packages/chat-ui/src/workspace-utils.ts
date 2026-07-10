import type { LocaleCode } from "@vivd-catalyst/api-client";
import type { ResolvedThemeMode } from "./theme";

export const STANDALONE_AUTH_SOURCE = "better-auth";
export const DEFAULT_LOCALES: LocaleCode[] = ["en", "de"];

const THEME_STORAGE_KEY = "vivd-catalyst:theme";
const LOCALE_STORAGE_KEY = "vivd-catalyst:locale";

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

export function readStoredThemeMode(): ResolvedThemeMode | undefined {
  const storedThemeMode = window.localStorage.getItem(THEME_STORAGE_KEY);
  return storedThemeMode === "dark" || storedThemeMode === "light" ? storedThemeMode : undefined;
}

export function writeStoredThemeMode(themeMode: ResolvedThemeMode): void {
  window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
}

export function readStoredLocale(): LocaleCode | undefined {
  const storedLocale = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  return storedLocale === "en" || storedLocale === "de" ? storedLocale : undefined;
}

export function writeStoredLocale(locale: LocaleCode): void {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
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
