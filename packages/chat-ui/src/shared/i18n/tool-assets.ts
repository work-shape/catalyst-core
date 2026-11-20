import { defineTranslations } from "./translation-area";

// The instance's own tools, added without a release (TOOL-1), as Studio's "Fähigkeiten" page
// says them in its group "Eigene Werkzeuge".
export const toolAssets = defineTranslations({
  en: {
    "toolAssets.description":
      "A tool of your own computes something or calls a Connection, and can show its result in the panel beside the chat. Add one with the CLI: catalyst tool put, then catalyst tool publish.",
    "toolAssets.empty":
      "No tools of your own yet. A tool computes something or calls a Connection, and can show its result in the panel beside the chat. Add one with the CLI: catalyst tool put, then catalyst tool publish."
  },
  de: {
    "toolAssets.description":
      "Ein eigenes Werkzeug berechnet etwas oder ruft eine Verbindung auf und kann sein Ergebnis im Panel neben dem Chat zeigen. Du fügst es mit der CLI hinzu: catalyst tool put, dann catalyst tool publish.",
    "toolAssets.empty":
      "Noch keine eigenen Werkzeuge. Ein Werkzeug berechnet etwas oder ruft eine Verbindung auf und kann sein Ergebnis im Panel neben dem Chat zeigen. Du fügst es mit der CLI hinzu: catalyst tool put, dann catalyst tool publish."
  }
});
