import { defineTranslations } from "./translation-area";

/** The chat dock beside every page, and the buttons that bring it back. */
export const dock = defineTranslations({
  en: {
    "dock.answerRunning": "an answer is running",
    "dock.chat": "Chat",
    "dock.close": "Close chat",
    "dock.openFullChat": "Open as full chat",
    "dock.resize": "Resize chat",
    "dock.showChat": "Show chat",
    "dock.showPage": "Show page"
  },
  de: {
    "dock.answerRunning": "eine Antwort läuft",
    "dock.chat": "Chat",
    "dock.close": "Chat schließen",
    "dock.openFullChat": "Als ganzen Chat öffnen",
    "dock.resize": "Chatbreite ändern",
    "dock.showChat": "Chat anzeigen",
    "dock.showPage": "Seite anzeigen"
  }
});
