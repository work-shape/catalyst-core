// @rights-copy: included in the rights wording guard.
import { defineTranslations } from "./translation-area";

// Instance > Access: the words of the keys `admin/access/kinds/connection.ts` names.
export const accessConnection = defineTranslations({
  en: {
    "access.actionReadConnectionDescription":
      "See the connection and its status in Studio. Never its credentials.",
    "access.actionUseConnectionDescription":
      "Let agents this person builds or runs call the outside system through it.",
    "access.kindConnection": "Connections",
    "access.scopeConnection": "Connection {name}",
    "access.scopeOnConnection": "On one connection",
    "access.scopeOnConnectionDescription": "One existing connection.",
    "access.grantConnection": "Connection",
    "access.chooseConnection": "Choose a connection",
    "access.noConnections": "This instance has no connection yet.",
    "access.connectionsLoadFailed": "The connections could not be loaded.",
    "access.objectConnection": "the connection {name}"
  },
  de: {
    "access.actionReadConnectionDescription":
      "Die Verbindung und ihren Status im Studio sehen. Nie ihre Zugangsdaten.",
    "access.actionUseConnectionDescription":
      "Agenten, die diese Person baut oder ausführt, dürfen das externe System darüber aufrufen.",
    "access.kindConnection": "Verbindungen",
    "access.scopeConnection": "Verbindung {name}",
    "access.scopeOnConnection": "An einer Verbindung",
    "access.scopeOnConnectionDescription": "Eine vorhandene Verbindung.",
    "access.grantConnection": "Verbindung",
    "access.chooseConnection": "Verbindung wählen",
    "access.noConnections": "Auf dieser Instanz gibt es noch keine Verbindung.",
    "access.connectionsLoadFailed": "Die Verbindungen konnten nicht geladen werden.",
    "access.objectConnection": "die Verbindung {name}"
  }
});
