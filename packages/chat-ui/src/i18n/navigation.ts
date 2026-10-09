import { defineTranslations } from "./translation-area";

/** The rail, the command palette and the frame of a surface. */
export const navigation = defineTranslations({
  en: {
    "nav.chat": "Chat",
    "nav.collapse": "Collapse sidebar",
    "nav.expand": "Expand sidebar",
    "nav.label": "Main navigation",
    "nav.newChat": "New chat",
    "nav.paletteConversations": "Conversations",
    "nav.paletteFailed": "Search is not available right now.",
    "nav.paletteNoMatch": 'No results for "{query}".',
    "nav.recent": "Recent",
    "nav.recentLoadFailed": "Conversations could not be loaded.",
    "nav.search": "Search",
    "nav.settings": "Settings",
    "nav.showChat": "Show chat",
    "nav.skipToContent": "Skip to content",
    "nav.surfaceNoRenderer": "This content cannot be shown yet."
  },
  de: {
    "nav.chat": "Chat",
    "nav.collapse": "Seitenleiste einklappen",
    "nav.expand": "Seitenleiste ausklappen",
    "nav.label": "Hauptnavigation",
    "nav.newChat": "Neuer Chat",
    "nav.paletteConversations": "Unterhaltungen",
    "nav.paletteFailed": "Die Suche ist gerade nicht verfügbar.",
    "nav.paletteNoMatch": "Keine Treffer für „{query}“.",
    "nav.recent": "Zuletzt",
    "nav.recentLoadFailed": "Unterhaltungen konnten nicht geladen werden.",
    "nav.search": "Suchen",
    "nav.settings": "Einstellungen",
    "nav.showChat": "Chat anzeigen",
    "nav.skipToContent": "Zum Inhalt springen",
    "nav.surfaceNoRenderer": "Dieser Inhalt kann noch nicht angezeigt werden."
  }
});
