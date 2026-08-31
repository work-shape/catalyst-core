import type { CSSProperties } from "react";

/**
 * The limited Workspace Accent. Client Branding keeps owning the application
 * theme; these tokens only tint workspace avatars, the selector highlight, the
 * active conversation marker, and the rail. Persistence stores the palette key,
 * never a raw color, so the theme-safe pairs below stay editable in one place.
 */
export const collaborationWorkspaceAccentColors = [
  "ruby",
  "amber",
  "emerald",
  "sapphire",
  "violet",
  "rose",
  "teal",
  "slate"
] as const;

export type CollaborationWorkspaceAccentColor = (typeof collaborationWorkspaceAccentColors)[number];

export interface CollaborationWorkspaceAccentTokens {
  /** Solid avatar background. */
  surface: string;
  /** Initials/emoji foreground on `surface`; contrast is asserted in tests. */
  onSurface: string;
}

const accentPalette: Record<
  CollaborationWorkspaceAccentColor,
  { light: CollaborationWorkspaceAccentTokens; dark: CollaborationWorkspaceAccentTokens }
> = {
  ruby: {
    light: { surface: "#be123c", onSurface: "#ffffff" },
    dark: { surface: "#fb7185", onSurface: "#3f0713" }
  },
  amber: {
    light: { surface: "#b45309", onSurface: "#ffffff" },
    dark: { surface: "#fbbf24", onSurface: "#422006" }
  },
  emerald: {
    light: { surface: "#047857", onSurface: "#ffffff" },
    dark: { surface: "#34d399", onSurface: "#022c22" }
  },
  sapphire: {
    light: { surface: "#1d4ed8", onSurface: "#ffffff" },
    dark: { surface: "#60a5fa", onSurface: "#0b2447" }
  },
  violet: {
    light: { surface: "#6d28d9", onSurface: "#ffffff" },
    dark: { surface: "#a78bfa", onSurface: "#2e1065" }
  },
  rose: {
    light: { surface: "#be185d", onSurface: "#ffffff" },
    dark: { surface: "#f472b6", onSurface: "#500724" }
  },
  teal: {
    light: { surface: "#0f766e", onSurface: "#ffffff" },
    dark: { surface: "#2dd4bf", onSurface: "#042f2e" }
  },
  slate: {
    light: { surface: "#475569", onSurface: "#ffffff" },
    dark: { surface: "#94a3b8", onSurface: "#0f172a" }
  }
};

export function collaborationWorkspaceAccentTokens(
  accentColor: CollaborationWorkspaceAccentColor,
  themeMode: "light" | "dark"
): CollaborationWorkspaceAccentTokens {
  return accentPalette[accentColor][themeMode];
}

export function isCollaborationWorkspaceAccentColor(
  value: string | null | undefined
): value is CollaborationWorkspaceAccentColor {
  return collaborationWorkspaceAccentColors.includes(value as CollaborationWorkspaceAccentColor);
}

/**
 * Deterministic palette default so a workspace without an explicit accent still
 * looks stable across sessions and devices.
 */
export function defaultCollaborationWorkspaceAccentColor(
  name: string
): CollaborationWorkspaceAccentColor {
  let hash = 0;
  for (const character of name.trim().toLocaleLowerCase()) {
    hash = (hash * 31 + character.codePointAt(0)!) % 1_000_003;
  }
  const index = hash % collaborationWorkspaceAccentColors.length;
  return collaborationWorkspaceAccentColors[index] ?? "teal";
}

export function resolveCollaborationWorkspaceAccentColor(input: {
  accentColor: string | null | undefined;
  name: string;
}): CollaborationWorkspaceAccentColor {
  return isCollaborationWorkspaceAccentColor(input.accentColor)
    ? input.accentColor
    : defaultCollaborationWorkspaceAccentColor(input.name);
}

export interface CollaborationWorkspaceAccentAttributes {
  "data-collaboration-workspace-accent": CollaborationWorkspaceAccentColor;
  style: CSSProperties;
}

/**
 * Emits both theme variants as inline custom properties. `styles.css` picks the
 * matching pair, so one element works in light and dark without re-rendering.
 */
export function collaborationWorkspaceAccentAttributes(
  accentColor: CollaborationWorkspaceAccentColor,
  style?: CSSProperties
): CollaborationWorkspaceAccentAttributes {
  const light = accentPalette[accentColor].light;
  const dark = accentPalette[accentColor].dark;
  return {
    "data-collaboration-workspace-accent": accentColor,
    style: {
      ...style,
      "--collaboration-workspace-accent-surface-light": light.surface,
      "--collaboration-workspace-accent-on-surface-light": light.onSurface,
      "--collaboration-workspace-accent-surface-dark": dark.surface,
      "--collaboration-workspace-accent-on-surface-dark": dark.onSurface
    } as CSSProperties
  };
}

export function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hexColor: string): number {
  const [red, green, blue] = parseHexColor(hexColor).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function parseHexColor(hexColor: string): [number, number, number] {
  const value = hexColor.replace("#", "");
  const expanded =
    value.length === 3
      ? value
          .split("")
          .map((character) => `${character}${character}`)
          .join("")
      : value;
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16)
  ];
}
