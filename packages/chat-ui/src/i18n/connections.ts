import { defineTranslations } from "./translation-area";

export const connections = defineTranslations({
  en: {
    "connections.description":
      "Connections come from the release config and cannot be changed here.",
    "connections.disabled": "Disabled",
    "connections.empty": "No connections yet. A connection holds the access to an outside system.",
    "connections.enabled": "Enabled",
    "connections.kind": "Connections",
    "connections.scopeInstance": "Instance",
    "connections.scopeWorkspace": "Workspace",
    "connections.search": "Search connections"
  },
  de: {
    "connections.description":
      "Verbindungen kommen aus der Release-Konfiguration und lassen sich hier nicht ändern.",
    "connections.disabled": "Deaktiviert",
    "connections.empty":
      "Noch keine Verbindungen. Eine Verbindung hält den Zugang zu einem externen System.",
    "connections.enabled": "Aktiv",
    "connections.kind": "Verbindungen",
    "connections.scopeInstance": "Instanz",
    "connections.scopeWorkspace": "Arbeitsbereich",
    "connections.search": "Verbindungen durchsuchen"
  }
});
