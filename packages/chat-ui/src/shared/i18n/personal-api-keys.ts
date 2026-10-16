import { defineTranslations } from "./translation-area";

/** You > API keys, and every person's keys on Instance > API access. */
export const personalApiKeys = defineTranslations({
  en: {
    "settings.apiKeys": "API keys",
    "personalApiKeys.description":
      "Keys for the catalyst CLI and your scripts. A key acts as you, limited to its scopes, until it expires or you revoke it.",
    "personalApiKeys.new": "New key",
    "personalApiKeys.newDescription":
      "Choose what the key may do. You can only give it what you may do yourself.",
    "personalApiKeys.create": "Create key",
    "personalApiKeys.created": "Key {name} created",
    "personalApiKeys.createdDescription":
      "Set it as CATALYST_API_KEY where the CLI or your script runs, with the instance address beside it.",
    "personalApiKeys.yourKeys": "Your keys",
    "personalApiKeys.empty": "No personal API keys yet.",
    "personalApiKeys.owner": "Owner",
    "personalApiKeys.revokeTitle": "Revoke {name}?",
    "personalApiKeys.name": "Name",
    "personalApiKeys.nameHint": "Where the key is used, such as the laptop or the script.",
    "personalApiKeys.actions": "Scopes",
    "personalApiKeys.actionsHint":
      "What the key may do. It never does more than you may do at the time of the call.",
    "personalApiKeys.namespace": "Limit to a Namespace",
    "personalApiKeys.namespaceHint":
      "A Namespace prefix such as tax-. Empty: wherever you hold the chosen scopes.",
    "personalApiKeys.namespaceInvalid":
      "A Namespace prefix is lowercase words joined by hyphens and ends in a hyphen, such as tax-.",
    "personalApiKeys.namespacePlaceholder": "tax-",
    "personalApiKeys.expiry": "Expires after",
    "personalApiKeys.expiryDays": "{days} days",
    "personalApiKeys.connectTitle": "Connect the CLI",
    "personalApiKeys.connectDescription":
      "Run catalyst login in your terminal and enter the code it shows. The CLI then receives a key with the scopes you choose here.",
    "personalApiKeys.code": "Connect code",
    "personalApiKeys.codeHint": "The code your terminal shows, such as ABCD-EFGH.",
    "personalApiKeys.codePlaceholder": "ABCD-EFGH",
    "personalApiKeys.codeUnknown":
      "This code is unknown, expired or already used. Run catalyst login again for a new one.",
    "personalApiKeys.codeAsking": "Asking",
    "personalApiKeys.unnamedClient": "A CLI that gave no name",
    "personalApiKeys.codeStarted": "Started",
    "personalApiKeys.codeExpires": "Code expires",
    "personalApiKeys.cliName": "catalyst CLI",
    "personalApiKeys.ownTerminalOnly": "Only confirm a code your own terminal shows you",
    "personalApiKeys.ownTerminalOnlyDescription":
      "Whoever started this code gets a key that acts as you. If somebody sent you the code {code}, do not confirm it.",
    "personalApiKeys.confirm": "Confirm",
    "personalApiKeys.connected": "The CLI is now logged in",
    "personalApiKeys.connectedDescription":
      "Return to your terminal. The key is listed under Your keys, where you can revoke it.",
    "personalApiKeys.instanceTitle": "Personal keys",
    "personalApiKeys.instanceDescription":
      "The keys people issued for themselves. Each acts as its owner within its scopes."
  },
  de: {
    "settings.apiKeys": "API-Schlüssel",
    "personalApiKeys.description":
      "Schlüssel für die catalyst CLI und deine Skripte. Ein Schlüssel handelt als du, begrenzt auf seine Berechtigungen, bis er abläuft oder du ihn widerrufst.",
    "personalApiKeys.new": "Neuer Schlüssel",
    "personalApiKeys.newDescription":
      "Wähle, was der Schlüssel darf. Du kannst ihm nur geben, was du selbst darfst.",
    "personalApiKeys.create": "Schlüssel erstellen",
    "personalApiKeys.created": "Schlüssel {name} erstellt",
    "personalApiKeys.createdDescription":
      "Setze ihn als CATALYST_API_KEY dort, wo die CLI oder dein Skript läuft, zusammen mit der Adresse der Instanz.",
    "personalApiKeys.yourKeys": "Deine Schlüssel",
    "personalApiKeys.empty": "Noch keine persönlichen API-Schlüssel.",
    "personalApiKeys.owner": "Inhaber",
    "personalApiKeys.revokeTitle": "{name} widerrufen?",
    "personalApiKeys.name": "Name",
    "personalApiKeys.nameHint": "Wo der Schlüssel verwendet wird, etwa der Laptop oder das Skript.",
    "personalApiKeys.actions": "Berechtigungen",
    "personalApiKeys.actionsHint":
      "Was der Schlüssel darf. Er darf nie mehr, als du zum Zeitpunkt des Aufrufs darfst.",
    "personalApiKeys.namespace": "Auf einen Namespace begrenzen",
    "personalApiKeys.namespaceHint":
      "Ein Namespace-Präfix wie tax-. Leer: überall, wo du die gewählten Berechtigungen hast.",
    "personalApiKeys.namespaceInvalid":
      "Ein Namespace-Präfix besteht aus kleingeschriebenen Wörtern mit Bindestrichen und endet mit einem Bindestrich, etwa tax-.",
    "personalApiKeys.namespacePlaceholder": "tax-",
    "personalApiKeys.expiry": "Läuft ab nach",
    "personalApiKeys.expiryDays": "{days} Tagen",
    "personalApiKeys.connectTitle": "CLI verbinden",
    "personalApiKeys.connectDescription":
      "Führe catalyst login in deinem Terminal aus und gib den angezeigten Code ein. Die CLI erhält dann einen Schlüssel mit den Berechtigungen, die du hier wählst.",
    "personalApiKeys.code": "Verbindungscode",
    "personalApiKeys.codeHint": "Der Code, den dein Terminal anzeigt, etwa ABCD-EFGH.",
    "personalApiKeys.codePlaceholder": "ABCD-EFGH",
    "personalApiKeys.codeUnknown":
      "Dieser Code ist unbekannt, abgelaufen oder bereits verwendet. Führe catalyst login erneut aus, um einen neuen zu erhalten.",
    "personalApiKeys.codeAsking": "Anfrage von",
    "personalApiKeys.unnamedClient": "Eine CLI ohne Namen",
    "personalApiKeys.codeStarted": "Gestartet",
    "personalApiKeys.codeExpires": "Code läuft ab",
    "personalApiKeys.cliName": "catalyst CLI",
    "personalApiKeys.ownTerminalOnly":
      "Bestätige nur einen Code, den dir dein eigenes Terminal zeigt",
    "personalApiKeys.ownTerminalOnlyDescription":
      "Wer diesen Code gestartet hat, erhält einen Schlüssel, der als du handelt. Hat dir jemand den Code {code} geschickt, bestätige ihn nicht.",
    "personalApiKeys.confirm": "Bestätigen",
    "personalApiKeys.connected": "Die CLI ist jetzt angemeldet",
    "personalApiKeys.connectedDescription":
      "Kehre zu deinem Terminal zurück. Der Schlüssel steht unter Deine Schlüssel, wo du ihn widerrufen kannst.",
    "personalApiKeys.instanceTitle": "Persönliche Schlüssel",
    "personalApiKeys.instanceDescription":
      "Die Schlüssel, die Personen für sich selbst ausgestellt haben. Jeder handelt als sein Inhaber innerhalb seiner Berechtigungen."
  }
});
