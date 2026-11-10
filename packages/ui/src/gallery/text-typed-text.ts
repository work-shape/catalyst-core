/** The gallery's text for the TypedText entry. */
export interface TypedTextGalleryText {
  typedTextTitle: string;
  typedTextTitles: readonly string[];
  typedTextChange: string;
  typedTextNote: string;
}

export const typedTextGalleryText: Record<"en" | "de", TypedTextGalleryText> = {
  en: {
    typedTextTitle: "A title somebody else gives",
    typedTextTitles: [
      "New conversation",
      "Offers for the roof renovation",
      "Roof renovation: three offers compared, scaffolding open"
    ],
    typedTextChange: "Give the next title",
    typedTextNote:
      "The first text stands at once. Each one that replaces it is typed in, a long one in bigger steps."
  },
  de: {
    typedTextTitle: "Ein Titel, den jemand anderes vergibt",
    typedTextTitles: [
      "Neue Unterhaltung",
      "Angebote für die Dachsanierung",
      "Dachsanierung: drei Angebote verglichen, Gerüst offen"
    ],
    typedTextChange: "Nächsten Titel vergeben",
    typedTextNote:
      "Der erste Text steht sofort da. Jeder, der ihn ersetzt, wird eingetippt, ein langer in größeren Schritten."
  }
};
