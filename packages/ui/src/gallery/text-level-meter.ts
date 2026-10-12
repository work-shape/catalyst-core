/** The gallery's text for the LevelMeter entry. */
export interface LevelMeterGalleryText {
  levelMeterNeutral: string;
  levelMeterSpectrum: string;
  levelMeterTone: string;
  levelMeterNarrow: string;
  levelMeterLabel: string;
  levelMeterLevels: readonly [string, string, string, string, string, string];
}

export const levelMeterGalleryText: Record<"en" | "de", LevelMeterGalleryText> = {
  en: {
    levelMeterNeutral: "Neutral: the text colour at every level",
    levelMeterSpectrum: "Spectrum: cool at the lowest level, warm at the highest",
    levelMeterTone: "Tone: one hue that deepens with the level",
    levelMeterNarrow: "Four steps in a narrow column",
    levelMeterLabel: "Usage consumption",
    levelMeterLevels: ["Very low", "Low", "Moderate", "Elevated", "High", "Very high"]
  },
  de: {
    levelMeterNeutral: "Neutral: die Textfarbe auf jeder Stufe",
    levelMeterSpectrum: "Spektrum: kühl auf der niedrigsten Stufe, warm auf der höchsten",
    levelMeterTone: "Ton: ein Farbton, der mit der Stufe kräftiger wird",
    levelMeterNarrow: "Vier Stufen in einer schmalen Spalte",
    levelMeterLabel: "Verbrauch",
    levelMeterLevels: ["Sehr niedrig", "Niedrig", "Mittel", "Erhöht", "Hoch", "Sehr hoch"]
  }
};
