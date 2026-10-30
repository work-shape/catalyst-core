import { defineTranslations } from "./translation-area";

/** You > API keys, and every person's keys on Instance > API access. */
export const personalApiKeys = defineTranslations({
  en: {
    "settings.apiKeys": "API keys",
    "personalApiKeys.description":
      "Keys for the catalyst CLI and your scripts. A key acts as you, limited to what you let it do, until it expires or you revoke it.",
    "personalApiKeys.new": "New key",
    "personalApiKeys.newDescription":
      "Choose what the key may do. You can only give it what you may do yourself.",
    "personalApiKeys.create": "Create key",
    "personalApiKeys.issueRefused": "You may not issue this key.",
    "personalApiKeys.listRefused": "You may not see your keys.",
    "personalApiKeys.revokeRefused": "You may not revoke this key.",
    "personalApiKeys.created": "Key {name} created",
    "personalApiKeys.createdDescription":
      "Set it as CATALYST_API_KEY where the CLI or your script runs, with the server address beside it.",
    "personalApiKeys.yourKeys": "Your keys",
    "personalApiKeys.empty": "No personal API keys yet.",
    "personalApiKeys.owner": "Owner",
    "personalApiKeys.revokeTitle": "Revoke {name}?",
    "personalApiKeys.name": "Name",
    "personalApiKeys.nameHint": "Where you use the key, such as your laptop or a script.",
    "personalApiKeys.actions": "What the key may do",
    "personalApiKeys.actionsHint": "If you lose a right later, the key loses it too.",
    "personalApiKeys.scopeLimited": "{right} in {workspace}",
    "personalApiKeys.scopeLimitedAsset": "{right}: {asset} in {workspace}",
    "personalApiKeys.startsWith": "Starts with {prefix}",
    "personalApiKeys.useLevel": "Use",
    "personalApiKeys.useLevelHint":
      "Use the Connections, Data Stores, Knowledge Bases and Workflows you may use. Needed to publish a Workflow whose technical account uses them.",
    "personalApiKeys.connectionUseCopies":
      "The results of these calls are copied to the computer that holds the key.",
    "personalApiKeys.instanceLevel": "All workspaces",
    "personalApiKeys.instanceLevelHint":
      "Lets the key only read what is shared by all workspaces: usage, audit events, background jobs, Operation Runs, Modules and infrastructure, and run the read-only check of the configured providers, as catalyst models check does. It changes nothing. It works only while you hold the same right yourself, and not on a key limited to a workspace. The key that catalyst setup creates never has it.",
    "personalApiKeys.accountLevel": "Account and workspaces",
    "personalApiKeys.accountLevelHint":
      "Lets the key change your own account and your workspaces, as you can on these screens. In a workspace your role there decides what it may do. It never issues a key, changes your password or deletes your account. The key that catalyst setup creates never has it.",
    "personalApiKeys.accountManage":
      "Change your name, language, what Enter does while an answer runs and your model preference, and revoke your keys",
    "personalApiKeys.workspacesManage":
      "Create, change and delete workspaces, and manage their members and requests",
    "personalApiKeys.workspace": "Limit to a workspace",
    "personalApiKeys.workspaceHint":
      "The key then reaches only what this workspace owns. Everywhere: wherever you hold the chosen rights.",
    "personalApiKeys.workspaceEverywhere": "Everywhere",
    "personalApiKeys.workspacePersonal": "Personal",
    "personalApiKeys.asset": "Limit to one asset",
    "personalApiKeys.assetHint":
      "The id of an agent, skill or other asset of the workspace, such as vat-helper. Empty: every asset of the workspace.",
    "personalApiKeys.assetInvalid":
      "An id starts with a letter or digit and uses only letters, digits, dots, hyphens and underscores.",
    "personalApiKeys.expiry": "Expires after",
    "personalApiKeys.expiryDays": "{days} days",
    "personalApiKeys.connectTitle": "Connect the CLI",
    "personalApiKeys.connectDescription":
      "Run catalyst login in your terminal and enter the code it shows. The CLI then receives a key that may do what you choose here.",
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
      "The keys people issued for themselves. Each acts as its owner, limited to what it may do."
  },
  de: {
    "settings.apiKeys": "API-Schlüssel",
    "personalApiKeys.description":
      "Schlüssel für die catalyst CLI und deine Skripte. Ein Schlüssel handelt als du, begrenzt auf seine Berechtigungen, bis er abläuft oder du ihn widerrufst.",
    "personalApiKeys.new": "Neuer Schlüssel",
    "personalApiKeys.newDescription":
      "Wähle, was der Schlüssel darf. Du kannst ihm nur geben, was du selbst darfst.",
    "personalApiKeys.create": "Schlüssel erstellen",
    "personalApiKeys.issueRefused": "Du darfst diesen Schlüssel nicht ausstellen.",
    "personalApiKeys.listRefused": "Du darfst deine Schlüssel nicht sehen.",
    "personalApiKeys.revokeRefused": "Du darfst diesen Schlüssel nicht widerrufen.",
    "personalApiKeys.created": "Schlüssel {name} erstellt",
    "personalApiKeys.createdDescription":
      "Setze ihn als CATALYST_API_KEY dort, wo die CLI oder dein Skript läuft, zusammen mit der Serveradresse.",
    "personalApiKeys.yourKeys": "Deine Schlüssel",
    "personalApiKeys.empty": "Noch keine persönlichen API-Schlüssel.",
    "personalApiKeys.owner": "Inhaber",
    "personalApiKeys.revokeTitle": "{name} widerrufen?",
    "personalApiKeys.name": "Name",
    "personalApiKeys.nameHint":
      "Wo du den Schlüssel verwendest, etwa auf dem Laptop oder in einem Skript",
    "personalApiKeys.actions": "Was der Schlüssel darf",
    "personalApiKeys.actionsHint": "Verlierst du später ein Recht, verliert es auch der Schlüssel.",
    "personalApiKeys.scopeLimited": "{right} in {workspace}",
    "personalApiKeys.scopeLimitedAsset": "{right}: {asset} in {workspace}",
    "personalApiKeys.startsWith": "Beginnt mit {prefix}",
    "personalApiKeys.useLevel": "Verwenden",
    "personalApiKeys.useLevelHint":
      "Verbindungen, Datenspeicher, Wissensbasen und Workflows verwenden, die du verwenden darfst. Nötig, um einen Workflow zu veröffentlichen, dessen technisches Konto sie verwendet.",
    "personalApiKeys.connectionUseCopies":
      "Die Ergebnisse dieser Aufrufe werden auf den Computer kopiert, auf dem der Schlüssel liegt.",
    "personalApiKeys.instanceLevel": "Alle Arbeitsbereiche",
    "personalApiKeys.instanceLevelHint":
      "Erlaubt dem Schlüssel nur, zu lesen, was alle Arbeitsbereiche gemeinsam haben: Nutzung, Audit-Ereignisse, Hintergrundaufträge, Operation Runs, Module und Infrastruktur, und die lesende Prüfung der eingerichteten Anbieter auszuführen, wie catalyst models check sie ausführt. Er ändert nichts. Das wirkt nur, solange du das gleiche Recht selbst hast, und nicht bei einem Schlüssel, der auf einen Arbeitsbereich begrenzt ist. Der Schlüssel, den catalyst setup anlegt, hat es nie.",
    "personalApiKeys.accountLevel": "Konto und Arbeitsbereiche",
    "personalApiKeys.accountLevelHint":
      "Erlaubt dem Schlüssel, dein eigenes Konto und deine Arbeitsbereiche zu ändern, wie du es auf diesen Seiten kannst. In einem Arbeitsbereich entscheidet deine Rolle dort, was er darf. Er stellt nie einen Schlüssel aus, ändert nie dein Passwort und löscht nie dein Konto. Der Schlüssel, den catalyst setup anlegt, hat es nie.",
    "personalApiKeys.accountManage":
      "Deinen Namen, deine Sprache, was Enter während einer Antwort tut, und deine Modellwahl ändern und deine Schlüssel widerrufen",
    "personalApiKeys.workspacesManage":
      "Arbeitsbereiche anlegen, ändern und löschen, ihre Mitglieder und Anfragen verwalten",
    "personalApiKeys.workspace": "Auf einen Arbeitsbereich begrenzen",
    "personalApiKeys.workspaceHint":
      "Der Schlüssel erreicht dann nur, was diesem Arbeitsbereich gehört. Überall: überall, wo du die gewählten Berechtigungen hast.",
    "personalApiKeys.workspaceEverywhere": "Überall",
    "personalApiKeys.workspacePersonal": "Persönlich",
    "personalApiKeys.asset": "Auf ein Asset begrenzen",
    "personalApiKeys.assetHint":
      "Die ID eines Agenten, Skills oder anderen Assets des Arbeitsbereichs, etwa vat-helper. Leer: jedes Asset des Arbeitsbereichs.",
    "personalApiKeys.assetInvalid":
      "Eine ID beginnt mit einem Buchstaben oder einer Ziffer und enthält nur Buchstaben, Ziffern, Punkte, Bindestriche und Unterstriche.",
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
