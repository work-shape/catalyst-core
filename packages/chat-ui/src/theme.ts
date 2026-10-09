import type { ThemeMode } from "@vivd-catalyst/ui/theme";

export type ResolvedThemeMode = ThemeMode;
export type ThemeModePreference = ResolvedThemeMode | "system";

export function resolveThemeModePreference(
  preference: ThemeModePreference | undefined,
  systemThemeMode: ResolvedThemeMode
): ResolvedThemeMode {
  if (preference === "dark" || preference === "light") {
    return preference;
  }
  return systemThemeMode;
}

export function readSystemThemeMode(): ResolvedThemeMode {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Marks the document with the mode, which selects the stylesheet's default theme for anything
 * outside a `UiRoot`. Only an entry that owns its document calls this; an embedded shell never
 * writes to its host page.
 */
export function applyDocumentThemeMode(mode: ResolvedThemeMode): void {
  document.documentElement.dataset.vivdTheme = mode;
}
