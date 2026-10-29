import { defineTranslations } from "./translation-area";

// Studio's "Fähigkeiten" page (TOOLS-2): what this instance's agents can be given, one package
// ("Paket") per module, the general skills and tools first and the instance's own tools last.
export const capabilities = defineTranslations({
  en: {
    "capabilities.title": "Capabilities",
    "capabilities.description":
      "What the agents of this instance can be given, by package. You give a tool or skill to an agent on the agent's page.",
    "capabilities.general": "General",
    "capabilities.generalText":
      "Skills and tools that come with every release and need no package.",
    "capabilities.own": "This instance's tools",
    "capabilities.ownText": "Tools that this instance adds for its own work.",
    "capabilities.on": "On",
    "capabilities.off": "Not active on this instance, ask Workshape",
    "capabilities.tools": "Tools",
    "capabilities.skills": "Skills",
    "capabilities.usedBy": "Used by",
    "capabilities.usedByNone": "No agent you can see uses this package.",
    "capabilities.toolCount": "{count} tools",
    "capabilities.toolCountOne": "1 tool",
    "capabilities.skillCount": "{count} skills",
    "capabilities.skillCountOne": "1 skill",
    "capabilities.agentCount": "{count} agents",
    "capabilities.agentCountOne": "1 agent",
    "capabilities.empty": "The agents of this instance cannot be given anything yet.",
    "capabilities.loadFailed": "The capabilities could not be loaded.",
    "capabilities.moduleApps":
      "Builds Apps in a conversation, shows them in the preview and saves them.",
    "capabilities.moduleAssetManagement":
      "Saves agents, skills and other assets with the rights of the person it works for.",
    "capabilities.moduleConnections":
      "Proposes connections to outside systems, drafts their tools and gives them to agents.",
    "capabilities.moduleWorkflows": "Writes Workflows and tests their steps.",
    "capabilities.moduleDataStores": "Describes the data stores and reads and writes their rows.",
    "capabilities.moduleKnowledge": "Adds files to knowledge bases and searches them."
  },
  de: {
    "capabilities.title": "Fähigkeiten",
    "capabilities.description":
      "Was die Agenten dieser Instanz bekommen können, nach Paket. Ein Werkzeug oder einen Skill gibst du einem Agenten auf seiner Seite.",
    "capabilities.general": "Allgemein",
    "capabilities.generalText":
      "Skills und Werkzeuge, die mit jedem Release kommen und kein Paket brauchen.",
    "capabilities.own": "Werkzeuge dieser Instanz",
    "capabilities.ownText": "Werkzeuge, die diese Instanz für ihre eigene Arbeit mitbringt.",
    "capabilities.on": "An",
    "capabilities.off": "Auf dieser Instanz nicht aktiv, Workshape fragen",
    "capabilities.tools": "Werkzeuge",
    "capabilities.skills": "Skills",
    "capabilities.usedBy": "Verwendet von",
    "capabilities.usedByNone": "Kein Agent, den du sehen kannst, verwendet dieses Paket.",
    "capabilities.toolCount": "{count} Werkzeuge",
    "capabilities.toolCountOne": "1 Werkzeug",
    "capabilities.skillCount": "{count} Skills",
    "capabilities.skillCountOne": "1 Skill",
    "capabilities.agentCount": "{count} Agenten",
    "capabilities.agentCountOne": "1 Agent",
    "capabilities.empty": "Die Agenten dieser Instanz können noch nichts bekommen.",
    "capabilities.loadFailed": "Die Fähigkeiten konnten nicht geladen werden.",
    "capabilities.moduleApps": "Baut Apps im Chat, zeigt sie in der Vorschau und speichert sie.",
    "capabilities.moduleAssetManagement":
      "Speichert Agenten, Skills und andere Assets mit den Rechten der Person, für die er arbeitet.",
    "capabilities.moduleConnections":
      "Schlägt Verbindungen zu externen Systemen vor, entwirft ihre Werkzeuge und gibt sie Agenten.",
    "capabilities.moduleWorkflows": "Schreibt Workflows und testet ihre Schritte.",
    "capabilities.moduleDataStores":
      "Beschreibt die Datenspeicher und liest und schreibt ihre Zeilen.",
    "capabilities.moduleKnowledge": "Fügt Wissensbasen Dateien hinzu und durchsucht sie."
  }
});
