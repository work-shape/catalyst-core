import { DEFAULT_THEME_INPUTS, type ThemeInputsByMode } from "../theme";

export type GalleryThemeId = "default" | "teal" | "previous";

/**
 * The themes the gallery's theme control switches between. "Teal accent" is the base theme
 * with the earlier teal as accent, and "Previous default" holds the 14 inputs the product had
 * before the base theme. Both exist only so the base can be compared; G-5d deletes the accent
 * that was not picked and "Previous default".
 */
export const galleryThemes: Record<GalleryThemeId, ThemeInputsByMode> = {
  default: DEFAULT_THEME_INPUTS,
  teal: {
    light: {
      ...DEFAULT_THEME_INPUTS.light,
      accentColor: "#0f766e",
      accentStrongColor: "#0b5f59"
    },
    dark: {
      ...DEFAULT_THEME_INPUTS.dark,
      accentColor: "#2dd4bf",
      accentStrongColor: "#7dd3fc"
    }
  },
  previous: {
    light: {
      surfaceColor: "#fffdfa",
      backgroundColor: "#f5f3ee",
      textColor: "#17201d",
      mutedTextColor: "#6b746f",
      borderColor: "#d8d3c7",
      accentColor: "#0f766e",
      accentStrongColor: "#0b5f59"
    },
    dark: {
      surfaceColor: "#171f1d",
      backgroundColor: "#0f1514",
      textColor: "#eef6f3",
      mutedTextColor: "#9eaaa5",
      borderColor: "#2b3734",
      accentColor: "#2dd4bf",
      accentStrongColor: "#7dd3fc"
    }
  }
};
