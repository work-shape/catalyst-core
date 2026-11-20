import { defineTranslations } from "./translation-area";

// Build > Tools: tools an instance adds without a release (TOOL-1).
export const toolAssets = defineTranslations({
  en: {
    "toolAssets.purpose": "Tools show an agent's finished result beside the chat.",
    "toolAssets.kind": "Tools",
    "toolAssets.description":
      "Your own tools, added without a release. An agent calls one to hand its finished result to the panel beside the chat. Tools are written and published with the CLI: catalyst tool put and catalyst tool publish.",
    "toolAssets.search": "Search tools",
    "toolAssets.empty":
      "No tools of your own yet. A tool hands an agent's finished result to the panel beside the chat. It is written and published with the CLI."
  },
  de: {
    "toolAssets.purpose": "Werkzeuge zeigen das fertige Ergebnis eines Agenten neben dem Chat.",
    "toolAssets.kind": "Werkzeuge",
    "toolAssets.description":
      "Eigene Werkzeuge, ohne Release hinzugefügt. Ein Agent ruft eines auf, um sein fertiges Ergebnis an das Panel neben dem Chat zu geben. Werkzeuge werden mit der CLI geschrieben und veröffentlicht: catalyst tool put und catalyst tool publish.",
    "toolAssets.search": "Werkzeuge durchsuchen",
    "toolAssets.empty":
      "Noch keine eigenen Werkzeuge. Ein Werkzeug gibt das fertige Ergebnis eines Agenten an das Panel neben dem Chat. Es wird mit der CLI geschrieben und veröffentlicht."
  }
});
