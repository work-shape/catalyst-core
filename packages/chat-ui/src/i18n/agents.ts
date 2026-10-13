import { defineTranslations } from "./translation-area";

/** The Agents page: the agents of the open workspace as cards a chat starts from. */
export const agents = defineTranslations({
  en: {
    "agents.description": "The agents of this workspace. Start a chat with one.",
    "agents.editInStudio": "Edit in Studio",
    "agents.emptyBuilder":
      "No agent is available in this workspace yet. Create one in Studio, or make an existing one available here.",
    "agents.loadFailed": "The agents could not be loaded.",
    "agents.openStudio": "Open Studio",
    "agents.startChat": "Start chat",
    "agents.title": "Agents"
  },
  de: {
    "agents.description":
      "Die Agenten dieses Arbeitsbereichs. Starte einen Chat mit einem von ihnen.",
    "agents.editInStudio": "Im Studio bearbeiten",
    "agents.emptyBuilder":
      "In diesem Arbeitsbereich ist noch kein Agent verfügbar. Lege im Studio einen an oder gib einen vorhandenen hier frei.",
    "agents.loadFailed": "Die Agenten konnten nicht geladen werden.",
    "agents.openStudio": "Studio öffnen",
    "agents.startChat": "Chat starten",
    "agents.title": "Agenten"
  }
});
