import { textOnSolid } from "./contrast";

export type ThemeMode = "light" | "dark";

/** The seven colours an instance sets per mode. Everything else is derived from them. */
export interface ThemeInputs {
  surfaceColor: string;
  backgroundColor: string;
  textColor: string;
  mutedTextColor: string;
  borderColor: string;
  accentColor: string;
  accentStrongColor: string;
}

/** The inputs of both modes, as an instance configures them. */
export interface ThemeInputsByMode {
  light: ThemeInputs;
  dark: ThemeInputs;
}

/** The base theme of an instance that sets no colours. A test holds it equal to the config schema defaults. */
export const DEFAULT_THEME_INPUTS: ThemeInputsByMode = {
  light: {
    surfaceColor: "#fdfdfc",
    backgroundColor: "#f6f6f4",
    textColor: "#1c1c1b",
    mutedTextColor: "#5e5e5b",
    borderColor: "#e4e4e1",
    accentColor: "#b5573a",
    accentStrongColor: "#8c3f26"
  },
  dark: {
    surfaceColor: "#1b1c1f",
    backgroundColor: "#151619",
    textColor: "#ececeb",
    mutedTextColor: "#a9abaf",
    borderColor: "#2f3135",
    accentColor: "#d98c6c",
    accentStrongColor: "#e8ab90"
  }
};

/** Every token that depends on the theme or the mode. Fixed tokens live in the stylesheet only. */
export const THEME_TOKEN_NAMES = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--primary-soft",
  "--primary-soft-foreground",
  "--primary-border",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--state-hover",
  "--state-pressed",
  "--state-selected",
  "--destructive",
  "--destructive-foreground",
  "--destructive-soft",
  "--destructive-soft-foreground",
  "--destructive-border",
  "--success",
  "--success-foreground",
  "--success-soft",
  "--success-soft-foreground",
  "--success-border",
  "--warning",
  "--warning-foreground",
  "--warning-soft",
  "--warning-soft-foreground",
  "--warning-border",
  "--info",
  "--info-foreground",
  "--info-soft",
  "--info-soft-foreground",
  "--info-border",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--level-1",
  "--level-2",
  "--level-3",
  "--level-4",
  "--level-5",
  "--level-6",
  "--file-sheet",
  "--file-document",
  "--file-slides",
  "--file-pdf",
  "--file-foreground",
  "--border",
  "--input",
  "--input-strong",
  "--ring",
  "--sidebar",
  "--sidebar-foreground",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
  "--sidebar-border",
  "--sidebar-ring",
  "--shadow-control",
  "--shadow-raised",
  "--shadow-overlay",
  "--shadow-modal"
] as const;

export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];
export type ThemeTokens = Record<ThemeTokenName, string>;

type LevelColors = readonly [string, string, string, string, string, string];

interface ModeConstants {
  destructive: string;
  success: string;
  warning: string;
  /**
   * The one blue: the quiet second accent beside the orange. It marks work that runs (a
   * spinner, a running count, an in-progress badge) and what is said for information; it is
   * never an action. A soft blue, so it stays below the accent.
   */
  info: string;
  charts: readonly [string, string, string, string, string];
  /**
   * Six levels from low to high, from a cool blue to a warm orange. Each holds 3:1 against the
   * page, the sidebar and a raised surface of the base theme. The last is not the destructive red.
   */
  levels: LevelColors;
  /** The page colours of the file-type icons. They are fixed: no instance theme tints them. */
  files: { sheet: string; document: string; slides: string; pdf: string; foreground: string };
  shadowControl: string;
  shadowRaised: string;
  shadowOverlay: string;
  shadowModal: string;
}

const MODE_CONSTANTS: Record<ThemeMode, ModeConstants> = {
  light: {
    destructive: "#b42318",
    success: "#047857",
    warning: "#b45309",
    info: "#32669a",
    charts: ["#0f766e", "#b45309", "#0369a1", "#7c3aed", "#be185d"],
    levels: ["#3082b5", "#118c8c", "#318f5a", "#8b8318", "#ae720a", "#b24b0a"],
    files: {
      sheet: "#1a7f4b",
      document: "#2563c9",
      slides: "#d2571c",
      pdf: "#c8322b",
      foreground: "#ffffff"
    },
    shadowControl: "inset 0 1px 0 rgb(255 255 255 / 0.4), 0 1px 2px rgb(0 0 0 / 0.05)",
    shadowRaised: "0 1px 2px rgb(0 0 0 / 0.04), 0 2px 12px rgb(0 0 0 / 0.06)",
    shadowOverlay: "0 1px 3px rgb(0 0 0 / 0.06), 0 8px 24px rgb(0 0 0 / 0.10)",
    shadowModal: "0 16px 48px rgb(0 0 0 / 0.18)"
  },
  dark: {
    destructive: "#f87171",
    success: "#34d399",
    warning: "#fbbf24",
    info: "#6fa8dc",
    charts: ["#2dd4bf", "#fbbf24", "#38bdf8", "#a78bfa", "#f472b6"],
    levels: ["#6bbaf0", "#4fcdcd", "#72d699", "#d5cc55", "#f5ae4b", "#f47f46"],
    // A step lighter than in light mode, so a page stands off a dark surface and still carries
    // its white glyph.
    files: {
      sheet: "#23915a",
      document: "#3b76d9",
      slides: "#dc6328",
      pdf: "#d6453d",
      foreground: "#ffffff"
    },
    shadowControl: "inset 0 1px 0 rgb(255 255 255 / 0.07), 0 1px 2px rgb(0 0 0 / 0.3)",
    shadowRaised: "0 1px 2px rgb(0 0 0 / 0.4)",
    shadowOverlay: "0 8px 24px rgb(0 0 0 / 0.5)",
    shadowModal: "0 16px 48px rgb(0 0 0 / 0.6)"
  }
};

/**
 * The one mapping from an instance's seven inputs to every themed token.
 *
 * Each value is a literal or a `color-mix()` over literals, never a `var()`: a custom property
 * resolves on the element that declares it, so a token written as `var()` on an outer root
 * would carry the outer theme's tint into a nested root.
 */
export function createThemeTokens(inputs: ThemeInputs, mode: ThemeMode): ThemeTokens {
  const constants = MODE_CONSTANTS[mode];
  const { surfaceColor, backgroundColor, textColor, mutedTextColor, borderColor } = inputs;
  const { accentColor, accentStrongColor } = inputs;
  const hover = over(textColor, 6);
  const onAccent = textOnSolid(accentColor);
  const destructive = toneValues(constants.destructive, textColor);
  const success = toneValues(constants.success, textColor);
  const warning = toneValues(constants.warning, textColor);
  const info = toneValues(constants.info, textColor);

  return {
    "--background": surfaceColor,
    "--foreground": textColor,
    "--card": surfaceColor,
    "--card-foreground": textColor,
    // A shadow does not show on a dark page, so there the fill carries the lift.
    "--popover": mode === "dark" ? mix(textColor, 6, surfaceColor) : surfaceColor,
    "--popover-foreground": textColor,
    "--primary": accentColor,
    "--primary-foreground": onAccent,
    "--primary-soft": over(accentColor, 12),
    // An accent may be light, so its soft text is the strong accent and not the tone mix.
    "--primary-soft-foreground": accentStrongColor,
    "--primary-border": over(accentColor, 35),
    "--secondary": hover,
    "--secondary-foreground": textColor,
    "--muted": backgroundColor,
    "--muted-foreground": mutedTextColor,
    "--accent": hover,
    "--accent-foreground": accentStrongColor,
    "--state-hover": hover,
    "--state-pressed": over(textColor, 10),
    "--state-selected": over(accentColor, 12),
    "--destructive": destructive.color,
    "--destructive-foreground": destructive.foreground,
    "--destructive-soft": destructive.soft,
    "--destructive-soft-foreground": destructive.softForeground,
    "--destructive-border": destructive.border,
    "--success": success.color,
    "--success-foreground": success.foreground,
    "--success-soft": success.soft,
    "--success-soft-foreground": success.softForeground,
    "--success-border": success.border,
    "--warning": warning.color,
    "--warning-foreground": warning.foreground,
    "--warning-soft": warning.soft,
    "--warning-soft-foreground": warning.softForeground,
    "--warning-border": warning.border,
    "--info": info.color,
    "--info-foreground": info.foreground,
    "--info-soft": info.soft,
    "--info-soft-foreground": info.softForeground,
    "--info-border": info.border,
    "--chart-1": constants.charts[0],
    "--chart-2": constants.charts[1],
    "--chart-3": constants.charts[2],
    "--chart-4": constants.charts[3],
    "--chart-5": constants.charts[4],
    "--level-1": constants.levels[0],
    "--level-2": constants.levels[1],
    "--level-3": constants.levels[2],
    "--level-4": constants.levels[3],
    "--level-5": constants.levels[4],
    "--level-6": constants.levels[5],
    "--file-sheet": constants.files.sheet,
    "--file-document": constants.files.document,
    "--file-slides": constants.files.slides,
    "--file-pdf": constants.files.pdf,
    "--file-foreground": constants.files.foreground,
    "--border": borderColor,
    "--input": mix(textColor, 12, borderColor),
    "--input-strong": over(mutedTextColor, 70),
    "--ring": accentColor,
    "--sidebar": backgroundColor,
    "--sidebar-foreground": textColor,
    "--sidebar-primary": accentColor,
    "--sidebar-primary-foreground": onAccent,
    "--sidebar-accent": surfaceColor,
    "--sidebar-accent-foreground": accentStrongColor,
    "--sidebar-border": borderColor,
    "--sidebar-ring": accentColor,
    "--shadow-control": constants.shadowControl,
    "--shadow-raised": constants.shadowRaised,
    "--shadow-overlay": constants.shadowOverlay,
    "--shadow-modal": constants.shadowModal
  };
}

interface ToneValues {
  color: string;
  foreground: string;
  soft: string;
  softForeground: string;
  border: string;
}

/** A state tone's four derived colours: text on its solid fill, its tint, text on the tint, its line. */
function toneValues(color: string, textColor: string): ToneValues {
  return {
    color,
    foreground: textOnSolid(color),
    soft: over(color, 12),
    softForeground: mix(color, 80, textColor),
    border: over(color, 35)
  };
}

/** `percent` of `color` mixed into `base`. */
function mix(color: string, percent: number, base: string): string {
  return `color-mix(in srgb, ${color} ${percent}%, ${base})`;
}

/** `percent` of `color` over whatever lies beneath. */
function over(color: string, percent: number): string {
  return mix(color, percent, "transparent");
}
