import { defineTranslations } from "./translation-area";

// The catalogue in New connection (CAT-1): the "Dienste" group of entry cards and the steps
// that install one part of an entry. `{title}` is the entry's name, such as a service's.
export const connectionCatalogue = defineTranslations({
  en: {
    "connectionCatalogue.services": "Services",
    "connectionCatalogue.own": "Your own connection",
    "connectionCatalogue.partTools": "For agents",
    "connectionCatalogue.partSource": "As a Knowledge Base source",
    "connectionCatalogue.notOffered": "Ask the team that runs this instance",
    "connectionCatalogue.partChoice": "What to connect",
    "connectionCatalogue.examples": "Ask, for example",
    "connectionCatalogue.checklist": "Before you connect",
    "connectionCatalogue.hosts": "Reaches {hosts}.",
    "connectionCatalogue.reviewIntro":
      "{title} recommends the ticked reading tools. None is enabled until you approve.",
    "connectionCatalogue.connected": "{name} is connected.",
    "connectionCatalogue.saved":
      "{name} is saved. The shared account signs in once you approve its tools.",
    "connectionCatalogue.savedPersonal":
      "{name} is saved. Each person signs in with their own account once you approve its tools.",
    "connectionCatalogue.redirectUri": "Register this redirect URI with the provider:",
    "connectionCatalogue.redirectUriMissing":
      "This instance has no public address yet, so it cannot name its redirect URI. Ask the team that runs it.",
    "connectionCatalogue.groupScopes": "Access: {scopes}",
    "connectionCatalogue.widens": "Asks for more access at the next sign-in.",
    "connectionCatalogue.otherTools": "Other tools",
    "connectionCatalogue.signInScopes": "The sign-in asks for: {scopes}",
    "connectionCatalogue.personalText":
      "Each person connects their own account under Settings > You > Connections. Agents read with it only in that person's private chats.",
    "connectionCatalogue.ownOptional": "Optional: your own account, which only you use.",
    "connectionCatalogue.connectOwn": "Connect your account now",
    "connectionCatalogue.ownConnected": "Your account is connected.",
    "connectionCatalogue.ownNeedsUse":
      "To connect your own account, you need the right to use this connection.",
    "connectionCatalogue.ownAccessLink": "Give it under use rights"
  },
  de: {
    "connectionCatalogue.services": "Dienste",
    "connectionCatalogue.own": "Eigene Verbindung",
    "connectionCatalogue.partTools": "Für Agenten",
    "connectionCatalogue.partSource": "Als Quelle einer Wissensdatenbank",
    "connectionCatalogue.notOffered": "Frag das Team, das diese Instanz betreibt",
    "connectionCatalogue.partChoice": "Was du verbindest",
    "connectionCatalogue.examples": "Frag zum Beispiel",
    "connectionCatalogue.checklist": "Vor dem Verbinden",
    "connectionCatalogue.hosts": "Erreicht {hosts}.",
    "connectionCatalogue.reviewIntro":
      "{title} empfiehlt die angehakten Lese-Tools. Freigegeben ist keines, bis du bestätigst.",
    "connectionCatalogue.connected": "{name} ist verbunden.",
    "connectionCatalogue.saved":
      "{name} ist gespeichert. Das gemeinsame Konto meldest du an, sobald du die Tools freigegeben hast.",
    "connectionCatalogue.savedPersonal":
      "{name} ist gespeichert. Jede Person meldet sich mit ihrem eigenen Konto an, sobald du die Tools freigegeben hast.",
    "connectionCatalogue.redirectUri": "Trag diese Redirect-URI beim Anbieter ein:",
    "connectionCatalogue.redirectUriMissing":
      "Diese Instanz hat noch keine öffentliche Adresse und kann ihre Redirect-URI nicht nennen. Frag das Team, das sie betreibt.",
    "connectionCatalogue.groupScopes": "Zugriff: {scopes}",
    "connectionCatalogue.widens": "Fragt bei der nächsten Anmeldung nach mehr Zugriff.",
    "connectionCatalogue.otherTools": "Weitere Tools",
    "connectionCatalogue.signInScopes": "Die Anmeldung fragt nach: {scopes}",
    "connectionCatalogue.personalText":
      "Jede Person verbindet ihr eigenes Konto unter Einstellungen > Du > Verbindungen. Agenten lesen damit nur in den privaten Chats dieser Person.",
    "connectionCatalogue.ownOptional": "Optional: dein eigenes Konto, das nur du nutzt.",
    "connectionCatalogue.connectOwn": "Jetzt mit deinem Konto verbinden",
    "connectionCatalogue.ownConnected": "Dein Konto ist verbunden.",
    "connectionCatalogue.ownNeedsUse":
      "Um dein eigenes Konto zu verbinden, brauchst du das Recht, diese Verbindung zu nutzen.",
    "connectionCatalogue.ownAccessLink": "Unter Nutzungsrechten vergeben"
  }
});
