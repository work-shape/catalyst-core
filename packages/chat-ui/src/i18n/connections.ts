import { defineTranslations } from "./translation-area";

export const connections = defineTranslations({
  en: {
    "connections.disabled": "Disabled",
    "connections.empty":
      "No connections. A connection holds the access to an outside system; agents, apps and workflows use it.",
    "connections.enabled": "Enabled",
    "connections.kind": "Connections",
    "connections.originRelease": "Release config",
    "connections.originRuntime": "Runtime",
    "connections.scopeInstance": "Instance",
    "connections.scopeWorkspace": "Workspace",
    "connections.search": "Search connections"
  },
  de: {
    "connections.disabled": "Deaktiviert",
    "connections.empty":
      "Keine Verbindungen. Eine Verbindung hält den Zugang zu einem externen System; Agenten, Apps und Workflows nutzen sie.",
    "connections.enabled": "Aktiv",
    "connections.kind": "Verbindungen",
    "connections.originRelease": "Release-Konfiguration",
    "connections.originRuntime": "Laufzeit",
    "connections.scopeInstance": "Instanz",
    "connections.scopeWorkspace": "Arbeitsbereich",
    "connections.search": "Verbindungen durchsuchen"
  }
});
