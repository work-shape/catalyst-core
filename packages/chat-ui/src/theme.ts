import type { CSSProperties } from "react";
import type { SafeConfig } from "@vivd-stage/api-client";

export type ResolvedThemeMode = "light" | "dark";
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

export function createThemeStyle(
  ui: SafeConfig["ui"] | undefined,
  mode: ResolvedThemeMode
): CSSProperties | undefined {
  if (!ui) {
    return undefined;
  }

  const theme = mode === "dark" ? ui.darkTheme : ui.theme;
  const primaryForeground = readableForeground(theme.accentColor);

  return {
    "--background": theme.surfaceColor,
    "--foreground": theme.textColor,
    "--card": theme.surfaceColor,
    "--card-foreground": theme.textColor,
    "--popover": theme.surfaceColor,
    "--popover-foreground": theme.textColor,
    "--primary": theme.accentColor,
    "--primary-foreground": primaryForeground,
    "--secondary": theme.backgroundColor,
    "--secondary-foreground": theme.textColor,
    "--muted": theme.backgroundColor,
    "--muted-foreground": theme.mutedTextColor,
    "--accent": theme.backgroundColor,
    "--accent-foreground": theme.accentStrongColor,
    "--destructive": mode === "dark" ? "#f87171" : "#b42318",
    "--border": theme.borderColor,
    "--input": theme.borderColor,
    "--ring": theme.accentColor,
    "--sidebar": theme.backgroundColor,
    "--sidebar-foreground": theme.textColor,
    "--sidebar-primary": theme.accentColor,
    "--sidebar-primary-foreground": primaryForeground,
    "--sidebar-accent": theme.surfaceColor,
    "--sidebar-accent-foreground": theme.accentStrongColor,
    "--sidebar-border": theme.borderColor,
    "--sidebar-ring": theme.accentColor
  } as CSSProperties;
}

function readableForeground(background: string): "#ffffff" | "#071312" {
  const rgb = parseHexColor(background);
  if (!rgb) {
    return "#ffffff";
  }
  const luminance = relativeLuminance(rgb);
  return luminance > 0.56 ? "#071312" : "#ffffff";
}

function parseHexColor(value: string): { r: number; g: number; b: number } | undefined {
  const hex = value.trim().replace(/^#/u, "");
  if (!/^[0-9a-f]{3}([0-9a-f]{3})?$/iu.test(hex)) {
    return undefined;
  }
  const normalized =
    hex.length === 3
      ? hex
          .split("")
          .map((character) => `${character}${character}`)
          .join("")
      : hex;
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16)
  };
}

function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const [red, green, blue] = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);
}
