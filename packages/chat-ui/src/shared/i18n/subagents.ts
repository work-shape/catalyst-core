import { defineTranslations } from "./translation-area";

/** The subagents of a conversation: their cards, their section of Resources and their threads. */
export const subagents = defineTranslations({
  en: {
    "subagents.active": "Active",
    "subagents.back": "Back to the conversation",
    "subagents.done": "Done",
    "subagents.loading": "Loading the subagent's thread…",
    "subagents.loadFailed": "The subagent's thread could not be loaded.",
    "subagents.notFound": "This subagent's thread is not available.",
    "subagents.open": "Open",
    "subagents.openLabel": "Open the thread of {description}",
    "subagents.readOnly": "A subagent's thread can be read, not answered.",
    "subagents.section": "Subagents",
    "subagents.soFar": "{duration} so far",
    "subagents.statusCancelled": "Stopped",
    "subagents.statusCompleted": "Done",
    "subagents.statusFailed": "Failed",
    "subagents.statusRunning": "Running",
    "subagents.statusStarting": "Starting",
    "subagents.statusStopping": "Stopping",
    "subagents.stop": "Stop",
    "subagents.stopFailed": "The subagent could not be stopped. Try again.",
    "subagents.stopLabel": "Stop {description}",
    "subagents.subagent": "Subagent"
  },
  de: {
    "subagents.active": "Aktiv",
    "subagents.back": "Zurück zur Unterhaltung",
    "subagents.done": "Erledigt",
    "subagents.loading": "Verlauf des Subagenten wird geladen…",
    "subagents.loadFailed": "Der Verlauf des Subagenten konnte nicht geladen werden.",
    "subagents.notFound": "Dieser Verlauf eines Subagenten ist nicht verfügbar.",
    "subagents.open": "Öffnen",
    "subagents.openLabel": "Verlauf von {description} öffnen",
    "subagents.readOnly": "Den Verlauf eines Subagenten kann man lesen, aber nicht beantworten.",
    "subagents.section": "Subagenten",
    "subagents.soFar": "bisher {duration}",
    "subagents.statusCancelled": "Gestoppt",
    "subagents.statusCompleted": "Fertig",
    "subagents.statusFailed": "Fehlgeschlagen",
    "subagents.statusRunning": "Läuft",
    "subagents.statusStarting": "Startet",
    "subagents.statusStopping": "Wird gestoppt",
    "subagents.stop": "Stoppen",
    "subagents.stopFailed": "Der Subagent konnte nicht gestoppt werden. Bitte erneut versuchen.",
    "subagents.stopLabel": "{description} stoppen",
    "subagents.subagent": "Subagent"
  }
});
