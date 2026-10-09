import type { CSSProperties } from "react";

/**
 * The limited Workspace Accent. Client Branding keeps owning the application
 * theme; these tokens only tint workspace avatars, the selector highlight, the
 * active conversation marker, and the rail. Persistence stores the palette key,
 * never a raw color, so the theme-safe pairs below stay editable in one place.
 *
 * Deliberately a curated list rather than a free color picker: every pair below
 * is asserted to clear 4.5:1 in both themes, which a user-chosen hex cannot
 * promise. Ordered around the hue wheel (warm to cool, neutrals last) because
 * the swatch grid renders in array order.
 */
export const collaborationWorkspaceAccentColors = [
  "garnet",
  "ruby",
  "mahogany",
  "copper",
  "amber",
  "olive",
  "jade",
  "emerald",
  "teal",
  "turquoise",
  "azure",
  "sapphire",
  "indigo",
  "violet",
  "magenta",
  "rose",
  "stone",
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
  garnet: {
    light: { surface: "#7f1d1d", onSurface: "#ffffff" },
    dark: { surface: "#fca5a5", onSurface: "#450a0a" }
  },
  ruby: {
    light: { surface: "#be123c", onSurface: "#ffffff" },
    dark: { surface: "#fb7185", onSurface: "#3f0713" }
  },
  mahogany: {
    light: { surface: "#6b4423", onSurface: "#ffffff" },
    dark: { surface: "#d9a066", onSurface: "#3b1a06" }
  },
  copper: {
    light: { surface: "#c2410c", onSurface: "#ffffff" },
    dark: { surface: "#fb923c", onSurface: "#431407" }
  },
  amber: {
    light: { surface: "#b45309", onSurface: "#ffffff" },
    dark: { surface: "#fbbf24", onSurface: "#422006" }
  },
  olive: {
    light: { surface: "#4d7c0f", onSurface: "#ffffff" },
    dark: { surface: "#a3e635", onSurface: "#1a2e05" }
  },
  jade: {
    light: { surface: "#15803d", onSurface: "#ffffff" },
    dark: { surface: "#4ade80", onSurface: "#052e16" }
  },
  emerald: {
    light: { surface: "#047857", onSurface: "#ffffff" },
    dark: { surface: "#34d399", onSurface: "#022c22" }
  },
  teal: {
    light: { surface: "#0f766e", onSurface: "#ffffff" },
    dark: { surface: "#2dd4bf", onSurface: "#042f2e" }
  },
  turquoise: {
    light: { surface: "#0e7490", onSurface: "#ffffff" },
    dark: { surface: "#22d3ee", onSurface: "#083344" }
  },
  azure: {
    light: { surface: "#0369a1", onSurface: "#ffffff" },
    dark: { surface: "#38bdf8", onSurface: "#082f49" }
  },
  sapphire: {
    light: { surface: "#1d4ed8", onSurface: "#ffffff" },
    dark: { surface: "#60a5fa", onSurface: "#0b2447" }
  },
  indigo: {
    light: { surface: "#4338ca", onSurface: "#ffffff" },
    dark: { surface: "#8ba3fc", onSurface: "#1e1b4b" }
  },
  violet: {
    light: { surface: "#6d28d9", onSurface: "#ffffff" },
    dark: { surface: "#a78bfa", onSurface: "#2e1065" }
  },
  magenta: {
    light: { surface: "#a21caf", onSurface: "#ffffff" },
    dark: { surface: "#e879f9", onSurface: "#4a044e" }
  },
  rose: {
    light: { surface: "#be185d", onSurface: "#ffffff" },
    dark: { surface: "#f472b6", onSurface: "#500724" }
  },
  stone: {
    light: { surface: "#57534e", onSurface: "#ffffff" },
    dark: { surface: "#a8a29e", onSurface: "#1c1917" }
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
 * The eight accents that shipped first. The name hash below draws from this
 * frozen pool rather than the full palette on purpose: a workspace with no
 * stored accent (every personal workspace, and any shared one created before
 * the picker existed) derives its color from `name`, so widening the pool would
 * silently re-tint all of them on release. New accents are reachable by picking
 * them; they are not retroactively assigned.
 */
const originalAccentPool = [
  "ruby",
  "amber",
  "emerald",
  "sapphire",
  "violet",
  "rose",
  "teal",
  "slate"
] as const satisfies readonly CollaborationWorkspaceAccentColor[];

/**
 * Deterministic palette default so a workspace without an explicit accent still
 * looks stable across sessions and devices.
 */
export function defaultCollaborationWorkspaceAccentColor(
  name: string
): CollaborationWorkspaceAccentColor {
  let hash = 0;
  for (const character of name.trim().toLocaleLowerCase()) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 1_000_003;
  }
  const index = hash % originalAccentPool.length;
  return originalAccentPool[index] ?? "teal";
}

/**
 * Starting point for a workspace that is being created: varied between dialog
 * openings, but picked once and then stable, so typing a name never cycles the
 * preview through the palette. `random` is injectable to keep tests
 * deterministic.
 *
 * Unlike the name-derived default, this spans the full palette — nothing is
 * already tinted by it, so there is no stored appearance to preserve.
 */
export function randomCollaborationWorkspaceAccentColor(
  random: () => number = Math.random
): CollaborationWorkspaceAccentColor {
  const index = Math.floor(random() * collaborationWorkspaceAccentColors.length);
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
