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
    "connectionCatalogue.widens": "Asks for more access at the next sign-in.",
    "connectionCatalogue.otherTools": "Other tools",
    "connectionCatalogue.signInAsks": "The sign-in asks for: {groups}",
    "connectionCatalogue.providerScopes": "Permissions at the provider",
    "connectionCatalogue.personalText":
      "Each person connects their own account under Settings > You > Connections. Agents read with it only in that person's private chats.",
    "connectionCatalogue.ownOptional": "Optional: your own account, which only you use.",
    "connectionCatalogue.connectOwn": "Connect your account now",
    "connectionCatalogue.ownConnected": "Your account is connected.",
    "connectionCatalogue.ownNeedsUse":
      "To connect your own account, you need the right to use this connection.",
    "connectionCatalogue.ownAccessLink": "Give it under use rights",
    "connectionCatalogue.scopesFromReview": "They follow from the tools you just approved.",
    "connectionCatalogue.recreates":
      "A deleted connection had this address. This installs it anew, with none of its earlier access.",
    "connectionCatalogue.managed":
      "No app registration needed. People sign in through the app the team that runs this instance set up.",
    "connectionCatalogue.more": "More",
    "connectionCatalogue.ownApp": "Use your own app registration",
    "connectionCatalogue.ownAppHelp":
      "For an app you registered with the provider yourself. You enter its client ID and secret.",
    "connectionCatalogue.updateTitle": "Set up from an earlier version of {title}",
    "connectionCatalogue.updateText":
      "This connection was set up from version {from}, and this instance has version {to}. Until you update it, changes to it can't be saved.",
    "connectionCatalogue.updateKeeps":
      "The update takes the settings of version {to}. The tools stay as they are. Everyone stays signed in, unless version {to} signs in at other addresses: then each person connects again.",
    "connectionCatalogue.updateApply": "Update to version {version}",
    "connectionCatalogue.updateChanges": "Settings that change"
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
    "connectionCatalogue.widens": "Fragt bei der nächsten Anmeldung nach mehr Zugriff.",
    "connectionCatalogue.otherTools": "Weitere Tools",
    "connectionCatalogue.signInAsks": "Die Anmeldung fragt nach: {groups}",
    "connectionCatalogue.providerScopes": "Berechtigungen beim Anbieter",
    "connectionCatalogue.personalText":
      "Jede Person verbindet ihr eigenes Konto unter Einstellungen > Du > Verbindungen. Agenten lesen damit nur in den privaten Chats dieser Person.",
    "connectionCatalogue.ownOptional": "Optional: dein eigenes Konto, das nur du nutzt.",
    "connectionCatalogue.connectOwn": "Jetzt mit deinem Konto verbinden",
    "connectionCatalogue.ownConnected": "Dein Konto ist verbunden.",
    "connectionCatalogue.ownNeedsUse":
      "Um dein eigenes Konto zu verbinden, brauchst du das Recht, diese Verbindung zu nutzen.",
    "connectionCatalogue.ownAccessLink": "Unter Nutzungsrechten vergeben",
    "connectionCatalogue.scopesFromReview":
      "Sie ergeben sich aus den Tools, die du gerade freigegeben hast.",
    "connectionCatalogue.recreates":
      "Eine gelöschte Verbindung hatte diese Adresse. Diese Einrichtung legt sie neu an, ohne ihre früheren Rechte.",
    "connectionCatalogue.managed":
      "Keine App-Registrierung nötig. Alle melden sich über die App an, die das Team dieser Instanz eingerichtet hat.",
    "connectionCatalogue.more": "Mehr",
    "connectionCatalogue.ownApp": "Eigene App-Registrierung verwenden",
    "connectionCatalogue.ownAppHelp":
      "Für eine App, die du selbst beim Anbieter registriert hast. Du gibst ihre Client-ID und ihr Client-Secret ein.",
    "connectionCatalogue.updateTitle": "Mit einer früheren Version von {title} eingerichtet",
    "connectionCatalogue.updateText":
      "Diese Verbindung wurde mit Version {from} eingerichtet, diese Instanz hat Version {to}. Bis du sie aktualisierst, lassen sich Änderungen an ihr nicht speichern.",
    "connectionCatalogue.updateKeeps":
      "Die Aktualisierung übernimmt die Einstellungen von Version {to}. Die Tools bleiben, wie sie sind. Alle bleiben angemeldet, außer Version {to} meldet über andere Adressen an: Dann verbindet sich jede Person neu.",
    "connectionCatalogue.updateApply": "Auf Version {version} aktualisieren",
    "connectionCatalogue.updateChanges": "Einstellungen, die sich ändern"
  }
});
