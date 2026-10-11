import { defineTranslations } from "./translation-area";

export const connections = defineTranslations({
  en: {
    "connections.disabled": "Disabled",
    "connections.empty":
      "No connections yet. A connection holds the access to an outside system. Connections cannot be created here yet.",
    "connections.enabled": "Enabled",
    "connections.kind": "Connections",
    "connections.scopeInstance": "Instance",
    "connections.scopeWorkspace": "Workspace",
    "connections.search": "Search connections"
  },
  de: {
    "connections.disabled": "Deaktiviert",
    "connections.empty":
      "Noch keine Verbindungen. Eine Verbindung hält den Zugang zu einem externen System. Verbindungen lassen sich hier noch nicht anlegen.",
    "connections.enabled": "Aktiv",
    "connections.kind": "Verbindungen",
    "connections.scopeInstance": "Instanz",
    "connections.scopeWorkspace": "Arbeitsbereich",
    "connections.search": "Verbindungen durchsuchen"
  }
});
