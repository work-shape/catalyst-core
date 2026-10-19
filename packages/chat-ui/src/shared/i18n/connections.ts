// @rights-copy: included in the rights wording guard.
import { defineTranslations } from "./translation-area";

export const connections = defineTranslations({
  en: {
    "connections.personContextAppUnavailable":
      "Person context is not available in Apps yet. Remove App exposure or the person context header.",
    "connections.description":
      "Connections give agents, apps and workflows access to outside systems. Those from the release config are read-only here.",
    "connections.releaseNotice":
      "This connection is defined in the release config. The operator changes it there; it cannot be changed here.",
    "connections.new": "New connection",
    "connections.titleLabel": "Name",
    "connections.deleteTitle": "Delete connection '{name}'?",
    "connections.deleteDescription":
      "Its credential is deleted with it, and nothing can call it afterwards. The account in the outside system stays as it is.",
    "connections.emptyReadOnly": "No connections yet.",
    "connections.create": "Create connection",
    "connections.serverTitle": "Server",
    "connections.serverDescription":
      "The remote MCP server this connection reaches. The instance reaches only hosts the operator allowed.",
    "connections.url": "Server address",
    "connections.urlHint":
      "The https address of the server with the path of its MCP endpoint, as its provider gives it. Moving to another server removes the key entered for this one.",
    "connections.authTitle": "Authentication",
    "connections.authDescription": "How the instance proves itself to the server.",
    "connections.authOAuth": "OAuth sign-in",
    "connections.authOAuthText":
      "A person signs in at the provider under Sign-in, and every call uses that account.",
    "connections.authNone": "None",
    "connections.authNoneText": "The server asks for no credential.",
    "connections.authBearer": "Bearer token",
    "connections.authBearerText": "The key is sent in the Authorization header.",
    "connections.authHeader": "Key in a header",
    "connections.authHeaderText": "The key is sent in a header the server names.",
    "connections.headerName": "Header name",
    "connections.headerNameHint": "The header the server reads the key from, such as X-API-Key.",
    "connections.secret": "Key",
    "connections.secretHint":
      "Stored encrypted. Nobody can read it back, you included. To change it, enter a new one.",
    "connections.secretReplace": "Enter a new key",
    "connections.secretEnter": "Enter the key",
    "connections.secretSave": "Save key",
    "connections.secretSaved": "The key was saved.",
    "connections.secretFailed": "The key could not be saved.",
    "connections.secretCancel": "Cancel",
    "connections.settingsEdit": "Edit",
    "connections.settingsSave": "Save settings",
    "connections.settingsCancel": "Cancel",
    "connections.refusedAddress":
      "Enter the address as a web address that starts with https:// or http://, such as https://example.com/api, without user name, password, query (?) or fragment (#).",
    "connections.refusedHeaders":
      "The instance did not accept these headers. Check each header's name and value.",
    "connections.refusedName": "The instance did not accept this name. Choose another one.",
    "connections.refusedOperation": "The instance did not accept this tool.",
    "connections.refusedSettings":
      "The instance did not accept these settings. Check that the address starts with https:// or http:// and has no user name, password, query or fragment.",
    "connections.refusedTestPath":
      "Enter the test path as a path that starts with /, without query (?).",
    "connections.refusedUnknown":
      "The instance did not accept this connection. An administrator of the instance sees why under Technical details.",
    "connections.writeFailed": "The change could not be saved.",
    "connections.discoveredTitle": "Discovered tools",
    "connections.discoveredDescription":
      "Tools the server offers that this connection does not accept. Nobody can call one until it is accepted.",
    "connections.discoveredEmpty": "The server offers no tool that is not accepted.",
    "connections.discoveredWaiting": "The instance is reading the tools of the server.",
    "connections.discoveredNever": "The tools of the server have not been read yet.",
    "connections.discoveredFailed": "The tools could not be read. Test the connection to see why.",
    "connections.discoverAgain": "Read tools again",
    "connections.discoverHeld": "Reading the tools waits for approval in the Inbox.",
    "connections.discoverFailed": "The tools could not be read again.",
    "connections.removeOperation": "Remove",
    "connections.acceptNewDescription": "Accept new description",
    "connections.healthNotConfiguredNextRuntime":
      "Enter the key under Credential. Then test again.",
    "connections.healthUnauthorizedNextRuntime":
      "Enter a new key under Credential. Then test again.",
    "connections.healthUnauthorizedTextNoKey":
      "The outside system refuses access without a credential, and this connection sends none.",
    "connections.healthUnauthorizedNextNoKey":
      "The server asks for a key, and this connection sends none. Under Settings, choose Edit, set how the key is sent and save. Then enter the key.",
    "connections.secretRemove": "Remove key",
    "connections.secretRemoveTitle": "Remove the key?",
    "connections.secretRemoveAgents":
      "The key is deleted and the connection sends no key from now on. Calls of {agents} and of Workflows that use this connection are refused by a server that asks for a key.",
    "connections.secretRemoveNoAgents":
      "The key is deleted and the connection sends no key from now on. No agent uses its tools; Workflows that use this connection are refused by a server that asks for a key.",
    "connections.healthSecretUnreadableNextRuntime":
      "Enter the key again under Credential. Then test again.",
    "connections.healthUnavailableNextRuntime":
      "Check the address under Settings and change it if it is wrong.",
    "connections.disabled": "Disabled",
    "connections.empty": "No connections yet. A connection holds the access to an outside system.",
    "connections.healthFailed": "Failed",
    "connections.healthFailedNext": "Test again. If it fails again, ask the operator.",
    "connections.healthFailedText": "The test failed for a reason the instance does not name.",
    "connections.healthNetworkDeniedNext":
      "The operator lets the instance reach this host and restarts it. Then test again.",
    "connections.healthNotConfiguredNext":
      "The operator supplies the credential in the instance's environment and restarts the instance. Then test again.",
    "connections.healthSecretUnreadableNext":
      "The operator restores the Secret Store key the credential was stored with, or supplies the credential again in the instance's environment, and restarts the instance. Then test again.",
    "connections.healthUnauthorizedNext":
      "The operator sets a new credential in the instance's environment and restarts the instance. Then test again.",
    "connections.healthUnavailableNext":
      "Check the address under Settings. The operator of this instance can change it.",
    "connections.statusDescription": "Whether the instance reaches the outside system.",
    "connections.accessTitle": "Additional use rights",
    "connections.accessDescription":
      "People and service principals given a right on this Connection itself. Workspace members use it through Available in and are not listed here.",
    "connections.accessEmpty": "Nobody has an additional right on this Connection.",
    "connections.accessFailed": "The additional use rights could not be loaded.",
    "connections.accessServicePrincipal": "Service principal",
    "connections.accessPrincipalDisabled": "Disabled",
    "connections.accessUnknownPerson": "A person you cannot see",
    "connections.accessUnknownPrincipal": "A service principal that no longer exists",
    "connections.agentsTitle": "Used by",
    "connections.agentsDescription": "The agents that carry a tool of this connection.",
    "connections.agentsEmpty": "No agent carries a tool of this connection.",
    "connections.agentTool": "1 tool",
    "connections.agentTools": "{count} tools",
    "connections.authScheme": "Authentication",
    "connections.connectorType": "Connector type",
    "connections.credential": "Credential",
    "connections.credentialNeverShown":
      "The credential stays in the Secret Store. This page shows only whether it is there.",
    "connections.credentialNoneNeeded": "None needed",
    "connections.credentialNoneNeededText": "The outside system asks for no credential.",
    "connections.credentialNotSet": "Not set",
    "connections.credentialSet": "Set",
    "connections.credentialSetVersion": "Set, version {version}",
    "connections.credentialUnreadable": "Unreadable",
    "connections.descriptionLabel": "Description",
    "connections.detailFailed": "The status of this connection could not be read.",
    "connections.disabledNotice": "This connection is disabled. Nothing can call it.",
    "connections.effectChanging": "Changing",
    "connections.effectReading": "Reading",
    "connections.enabled": "Enabled",
    "connections.exposeOutside": "Outside clients (CLI, MCP)",
    "connections.exposeOutsideHint":
      "What a call returns is copied to the computer that holds the key.",
    "connections.exposureAgent": "Agents",
    "connections.exposureBridge": "Apps",
    "connections.exposureNone": "Nobody can call it",
    "connections.exposureOutside": "Outside clients",
    "connections.exposureWorkflow": "Workflows",
    "connections.healthNetworkDenied": "Network denied",
    "connections.healthNetworkDeniedText":
      "The instance may not reach this address. Its host is not among the outside addresses the operator allowed.",
    "connections.healthNeverTested": "Not tested",
    "connections.healthNeverTestedText": "This connection has not been tested yet.",
    "connections.healthSignInNeeded": "Sign-in needed",
    "connections.healthSignInNeededText":
      "This connection signs in at its provider with OAuth, and nobody is signed in.",
    "connections.healthSignInNeededNext":
      "An administrator signs in under Sign-in. Until then nothing can call the connection.",
    "connections.healthNotConfigured": "Not configured",
    "connections.healthNotConfiguredText":
      "The credential of this connection is missing. Until the operator supplies it, no call reaches the outside system.",
    "connections.healthReady": "Ready",
    "connections.healthReadyText": "The outside system answered the test.",
    "connections.healthSecretUnreadable": "Credential unreadable",
    "connections.healthSecretUnreadableText":
      "A credential is stored, but the instance cannot read it. Until it is set again, no call reaches the outside system.",
    "connections.healthTesting": "Testing",
    "connections.healthTestingText":
      "The instance is asking the outside system. This can take a moment.",
    "connections.healthUnauthorized": "Unauthorized",
    "connections.healthUnauthorizedText":
      "The outside system refused the credential. It may be wrong, expired or revoked.",
    "connections.healthUnavailable": "Unavailable",
    "connections.healthUnavailableText":
      "The outside system did not answer the test. It may be down, or its address may be wrong.",
    "connections.kind": "Connections",
    "connections.kindSingular": "Connection",
    "connections.lastTested": "Last tested {time}",
    "connections.missing": "There is no connection with the id {name}.",
    "connections.operationExposure": "Callable by",
    "connections.paging": "Paged by",
    "connections.pagingCursor": "cursor from {cursor} of each answer, sent as {param}",
    "connections.pagingNextLink": "next address from {cursor} of each answer, sent as {param}",
    "connections.pagingOffset": "row offset in {param}, {size} per page in {sizeParam}",
    "connections.pagingPage": "page number in {param}, {size} per page in {sizeParam}",
    "connections.pagingStart": "{text}, starting at {start}",
    "connections.operationsTitle": "Operations",
    "connections.operationsDescription":
      "What this connection can do in the outside system, and who may call it.",
    "connections.operationsEmpty": "This connection has no accepted operation.",
    "connections.scopeInstance": "Instance",
    "connections.scopeWorkspace": "Workspace",
    "connections.search": "Search connections",
    "connections.settingsTitle": "Settings",
    "connections.settingsDescription":
      "How the instance reaches the outside system. No setting is a credential.",
    "connections.sharedAccountTitle": "One shared account",
    "connections.sharedAccountText":
      "Every call through this connection uses the same account in the outside system. Everyone who may use the connection sees what that account sees, whatever their own rights there are.",
    "connections.statusAwaitingDiscovery": "Awaiting discovery",
    "connections.statusAwaitingDiscoveryText":
      "The instance has not read this operation from the outside system yet. It cannot be called until then.",
    "connections.statusDisabled": "Disabled",
    "connections.statusDisabledText": "Switched off by the operator of this instance.",
    "connections.statusNeedsReview": "Needs review",
    "connections.statusNeedsReviewText":
      "The outside system now describes this operation differently than was accepted. It cannot be called until the operator accepts the new description.",
    "connections.statusNeedsReviewFingerprint": "New fingerprint:",
    "connections.statusReady": "Ready",
    "connections.statusTitle": "Status",
    "connections.statusUnknown": "Unknown",
    "connections.statusUnknownText":
      "The outside system does not offer this operation. It cannot be called.",
    "connections.test": "Test connection",
    "connections.testFailed": "The test could not be run.",
    "connections.testHeld": "The test waits for approval in the Inbox. It has not run yet.",
    "connections.testNotAllowed":
      "You can read this connection. Testing it needs the right to change connections on the instance.",
    "connections.testRefused": "You may not test this connection. You can read it.",
    "connections.toolsHeld": "Tools of connections this agent holds",
    "connections.personContextTitle": "Person context",
    "connections.personContextDescription":
      "The value each call sends for the person or service principal it runs for.",
    "connections.personContextHeader": "Header",
    "connections.personContextExplain":
      "Nobody is mapped automatically. Map each person and each service principal on its own. A call for someone without a mapping is refused.",
    "connections.personContextKind": "Mapping for",
    "connections.personContextKindUser": "Person",
    "connections.personContextSubjectId": "ID",
    "connections.personContextSubjectIdHint":
      "The ID the instance gives the person or service principal.",
    "connections.personContextShow": "Show mapping",
    "connections.personContextChoosePerson": "Choose a person",
    "connections.personContextChoosePrincipal": "Choose a service principal",
    "connections.personContextNoPeople": "This instance has no people yet.",
    "connections.personContextNoPrincipals": "This instance has no service principals yet.",
    "connections.personContextListFailed": "The list could not be loaded.",
    "connections.personContextPeopleHidden":
      "Choosing a person by name needs the right to manage users. Someone with that right can map people here.",
    "connections.personContextPrincipalsHidden":
      "Choosing a service principal by name needs the right to manage service principals. Someone with that right can map them here.",
    "connections.personContextEnterId": "Enter a technical ID instead",
    "connections.personContextReadFailed": "The mapping could not be read.",
    "connections.personContextMapped": "Mapped",
    "connections.personContextUnmapped": "Not mapped",
    "connections.personContextUnmappedText":
      "Calls on this connection for them are refused until you save a value.",
    "connections.personContextValue": "Value sent in {header}",
    "connections.personContextValueHint": "Only people who may change this connection see it.",
    "connections.personContextSave": "Save mapping",
    "connections.personContextRemove": "Remove mapping",
    "connections.personContextConflict":
      "Someone changed this mapping in the meantime. The current state is shown; check it and save again.",
    "connections.personContextWriteFailed": "The mapping was not saved.",
    "connections.toolsLoading": "The connections are being checked.",
    "connections.toolsOpenConnection": "Open connection",
    "connections.toolsSelected": "{selected} of {count} selected",
    "connections.toolsUnavailableText":
      "These tools are no longer offered to this agent. The agent keeps each one until you remove it.",
    "connections.toolsUnavailableTitle": "No longer available",
    "connections.toolsUnknown":
      "The connections could not be read, so this was not checked. The agent keeps it until you remove it."
  },
  de: {
    "connections.personContextAppUnavailable":
      "Personenkontext ist in Apps noch nicht verfügbar. Entfernen Sie die App-Freigabe oder den Header für den Personenkontext.",
    "connections.description":
      "Verbindungen geben Agenten, Apps und Workflows Zugang zu externen Systemen. Die aus der Release-Konfiguration sind hier schreibgeschützt.",
    "connections.releaseNotice":
      "Diese Verbindung ist in der Release-Konfiguration festgelegt. Der Betreiber ändert sie dort; hier lässt sie sich nicht ändern.",
    "connections.new": "Neue Verbindung",
    "connections.titleLabel": "Name",
    "connections.deleteTitle": "Verbindung „{name}“ löschen?",
    "connections.deleteDescription":
      "Ihre Zugangsdaten werden mit ihr gelöscht, und danach kann nichts sie aufrufen. Das Konto im externen System bleibt, wie es ist.",
    "connections.emptyReadOnly": "Noch keine Verbindungen.",
    "connections.create": "Verbindung anlegen",
    "connections.serverTitle": "Server",
    "connections.serverDescription":
      "Der entfernte MCP-Server, den diese Verbindung erreicht. Die Instanz erreicht nur Hosts, die der Betreiber erlaubt hat.",
    "connections.url": "Serveradresse",
    "connections.urlHint":
      "Die https-Adresse des Servers mit dem Pfad seines MCP-Endpunkts, wie sein Anbieter sie angibt. Beim Wechsel zu einem anderen Server wird der für diesen eingegebene Schlüssel entfernt.",
    "connections.authTitle": "Authentifizierung",
    "connections.authDescription": "Wie sich die Instanz beim Server ausweist.",
    "connections.authOAuth": "Anmeldung mit OAuth",
    "connections.authOAuthText":
      "Eine Person meldet sich unter Anmeldung beim Anbieter an, und jeder Aufruf nutzt dieses Konto.",
    "connections.authNone": "Keine",
    "connections.authNoneText": "Der Server verlangt keine Zugangsdaten.",
    "connections.authBearer": "Bearer-Token",
    "connections.authBearerText": "Der Schlüssel wird im Authorization-Header gesendet.",
    "connections.authHeader": "Schlüssel in einem Header",
    "connections.authHeaderText":
      "Der Schlüssel wird in einem Header gesendet, den der Server nennt.",
    "connections.headerName": "Header-Name",
    "connections.headerNameHint":
      "Der Header, aus dem der Server den Schlüssel liest, etwa X-API-Key.",
    "connections.secret": "Schlüssel",
    "connections.secretHint":
      "Wird verschlüsselt gespeichert. Niemand kann ihn wieder auslesen, auch du nicht. Zum Ändern gibst du einen neuen ein.",
    "connections.secretReplace": "Neuen Schlüssel eingeben",
    "connections.secretEnter": "Schlüssel eingeben",
    "connections.secretSave": "Schlüssel speichern",
    "connections.secretSaved": "Der Schlüssel wurde gespeichert.",
    "connections.secretFailed": "Der Schlüssel konnte nicht gespeichert werden.",
    "connections.secretCancel": "Abbrechen",
    "connections.settingsEdit": "Bearbeiten",
    "connections.settingsSave": "Einstellungen speichern",
    "connections.settingsCancel": "Abbrechen",
    "connections.refusedAddress":
      "Gib die Adresse als Webadresse an, die mit https:// oder http:// beginnt, etwa https://example.com/api, ohne Benutzername, Passwort, Abfrage (?) oder Fragment (#).",
    "connections.refusedHeaders":
      "Die Instanz hat diese Header nicht angenommen. Prüfe Name und Wert jedes Headers.",
    "connections.refusedName":
      "Die Instanz hat diesen Namen nicht angenommen. Wähle einen anderen.",
    "connections.refusedOperation": "Die Instanz hat dieses Tool nicht angenommen.",
    "connections.refusedSettings":
      "Die Instanz hat diese Einstellungen nicht angenommen. Prüfe, ob die Adresse mit https:// oder http:// beginnt und keinen Benutzernamen, kein Passwort, keine Abfrage und kein Fragment enthält.",
    "connections.refusedTestPath":
      "Gib den Testpfad als Pfad an, der mit / beginnt, ohne Abfrage (?).",
    "connections.refusedUnknown":
      "Die Instanz hat diese Verbindung nicht angenommen. Ein Administrator der Instanz sieht den Grund unter Technische Details.",
    "connections.writeFailed": "Die Änderung konnte nicht gespeichert werden.",
    "connections.discoveredTitle": "Gefundene Tools",
    "connections.discoveredDescription":
      "Tools, die der Server anbietet und die diese Verbindung nicht akzeptiert. Niemand kann eines aufrufen, bevor es akzeptiert ist.",
    "connections.discoveredEmpty": "Der Server bietet kein Tool an, das nicht akzeptiert ist.",
    "connections.discoveredWaiting": "Die Instanz liest die Tools des Servers.",
    "connections.discoveredNever": "Die Tools des Servers wurden noch nicht gelesen.",
    "connections.discoveredFailed":
      "Die Tools ließen sich nicht lesen. Teste die Verbindung, um den Grund zu sehen.",
    "connections.discoverAgain": "Tools neu lesen",
    "connections.discoverHeld": "Das Lesen der Tools wartet auf eine Freigabe im Eingang.",
    "connections.discoverFailed": "Die Tools konnten nicht neu gelesen werden.",
    "connections.removeOperation": "Entfernen",
    "connections.acceptNewDescription": "Neue Beschreibung akzeptieren",
    "connections.healthNotConfiguredNextRuntime":
      "Gib den Schlüssel unter Zugangsdaten ein. Teste danach erneut.",
    "connections.healthUnauthorizedNextRuntime":
      "Gib unter Zugangsdaten einen neuen Schlüssel ein. Teste danach erneut.",
    "connections.healthUnauthorizedTextNoKey":
      "Das externe System lässt ohne Zugangsdaten keinen Zugriff zu, und diese Verbindung sendet keine.",
    "connections.healthUnauthorizedNextNoKey":
      "Der Server verlangt einen Schlüssel, und diese Verbindung sendet keinen. Wähl unter Einstellungen Bearbeiten, leg fest, wie der Schlüssel gesendet wird, und speichere. Gib dann den Schlüssel ein.",
    "connections.secretRemove": "Schlüssel entfernen",
    "connections.secretRemoveTitle": "Schlüssel entfernen?",
    "connections.secretRemoveAgents":
      "Der Schlüssel wird gelöscht, und die Verbindung sendet ab jetzt keinen. Aufrufe von {agents} und von Workflows, die diese Verbindung nutzen, lehnt ein Server ab, der einen Schlüssel verlangt.",
    "connections.secretRemoveNoAgents":
      "Der Schlüssel wird gelöscht, und die Verbindung sendet ab jetzt keinen. Kein Agent nutzt ihre Tools; Aufrufe von Workflows, die diese Verbindung nutzen, lehnt ein Server ab, der einen Schlüssel verlangt.",
    "connections.healthSecretUnreadableNextRuntime":
      "Gib den Schlüssel unter Zugangsdaten erneut ein. Teste danach erneut.",
    "connections.healthUnavailableNextRuntime":
      "Prüfe die Adresse unter Einstellungen und ändere sie, wenn sie falsch ist.",
    "connections.healthFailed": "Fehlgeschlagen",
    "connections.healthFailedText":
      "Der Test ist aus einem Grund fehlgeschlagen, den die Instanz nicht nennt.",
    "connections.healthFailedNext":
      "Teste erneut. Schlägt der Test wieder fehl, wende dich an den Betreiber.",
    "connections.healthNetworkDeniedNext":
      "Der Betreiber erlaubt der Instanz diesen Host und startet sie neu. Teste danach erneut.",
    "connections.healthNotConfiguredNext":
      "Der Betreiber stellt die Zugangsdaten in der Umgebung der Instanz bereit und startet die Instanz neu. Teste danach erneut.",
    "connections.healthSecretUnreadableNext":
      "Der Betreiber stellt den Secret-Store-Schlüssel wieder her, mit dem die Zugangsdaten gespeichert wurden, oder stellt die Zugangsdaten in der Umgebung der Instanz erneut bereit, und startet die Instanz neu. Teste danach erneut.",
    "connections.healthUnauthorizedNext":
      "Der Betreiber setzt neue Zugangsdaten in der Umgebung der Instanz und startet die Instanz neu. Teste danach erneut.",
    "connections.healthUnavailableNext":
      "Prüfe die Adresse unter Einstellungen. Ändern kann sie der Betreiber dieser Instanz.",
    "connections.statusDescription": "Ob die Instanz das externe System erreicht.",
    "connections.accessTitle": "Zusätzliche Nutzungsrechte",
    "connections.accessDescription":
      "Personen und Technische Konten mit einem Recht auf dieser Verbindung selbst. Mitglieder eines Arbeitsbereichs verwenden sie über „Verfügbar in“ und stehen nicht hier.",
    "connections.accessEmpty": "Niemand hat ein zusätzliches Recht auf dieser Verbindung.",
    "connections.accessFailed": "Die zusätzlichen Nutzungsrechte konnten nicht geladen werden.",
    "connections.accessServicePrincipal": "Technisches Konto",
    "connections.accessPrincipalDisabled": "Deaktiviert",
    "connections.accessUnknownPerson": "Eine Person, die du nicht sehen kannst",
    "connections.accessUnknownPrincipal": "Ein Technisches Konto, das es nicht mehr gibt",
    "connections.agentsTitle": "Verwendet von",
    "connections.agentsDescription": "Die Agenten, die ein Tool dieser Verbindung führen.",
    "connections.agentsEmpty": "Kein Agent führt ein Tool dieser Verbindung.",
    "connections.agentTool": "1 Tool",
    "connections.agentTools": "{count} Tools",
    "connections.authScheme": "Authentifizierung",
    "connections.connectorType": "Konnektortyp",
    "connections.credential": "Zugangsdaten",
    "connections.credentialNeverShown":
      "Die Zugangsdaten bleiben im Secret Store. Diese Seite zeigt nur, ob sie vorhanden sind.",
    "connections.credentialNoneNeeded": "Nicht nötig",
    "connections.credentialNoneNeededText": "Das externe System verlangt keine Zugangsdaten.",
    "connections.credentialNotSet": "Nicht gesetzt",
    "connections.credentialSet": "Gesetzt",
    "connections.credentialSetVersion": "Gesetzt, Version {version}",
    "connections.credentialUnreadable": "Nicht lesbar",
    "connections.descriptionLabel": "Beschreibung",
    "connections.detailFailed": "Der Status dieser Verbindung konnte nicht gelesen werden.",
    "connections.disabled": "Deaktiviert",
    "connections.disabledNotice": "Diese Verbindung ist deaktiviert. Nichts kann sie aufrufen.",
    "connections.effectChanging": "Ändernd",
    "connections.effectReading": "Lesend",
    "connections.empty":
      "Noch keine Verbindungen. Eine Verbindung hält den Zugang zu einem externen System.",
    "connections.enabled": "Aktiv",
    "connections.exposeOutside": "Externe Clients (CLI, MCP)",
    "connections.exposeOutsideHint":
      "Was ein Aufruf zurückgibt, wird auf den Rechner kopiert, der den Schlüssel hat.",
    "connections.exposureAgent": "Agenten",
    "connections.exposureBridge": "Apps",
    "connections.exposureNone": "Niemand kann sie aufrufen",
    "connections.exposureOutside": "Externe Clients",
    "connections.exposureWorkflow": "Workflows",
    "connections.healthNetworkDenied": "Netzwerk gesperrt",
    "connections.healthNetworkDeniedText":
      "Die Instanz darf diese Adresse nicht erreichen. Ihr Host gehört nicht zu den externen Adressen, die der Betreiber erlaubt hat.",
    "connections.healthNeverTested": "Nicht getestet",
    "connections.healthNeverTestedText": "Diese Verbindung wurde noch nicht getestet.",
    "connections.healthSignInNeeded": "Anmeldung nötig",
    "connections.healthSignInNeededText":
      "Diese Verbindung meldet sich mit OAuth beim Anbieter an, und niemand ist angemeldet.",
    "connections.healthSignInNeededNext":
      "Eine Administratorin oder ein Administrator meldet sie unter Anmeldung an. Bis dahin kann nichts die Verbindung aufrufen.",
    "connections.healthNotConfigured": "Nicht konfiguriert",
    "connections.healthNotConfiguredText":
      "Die Zugangsdaten dieser Verbindung fehlen. Bis der Betreiber sie bereitstellt, erreicht kein Aufruf das externe System.",
    "connections.healthReady": "Bereit",
    "connections.healthReadyText": "Das externe System hat auf den Test geantwortet.",
    "connections.healthSecretUnreadable": "Zugangsdaten nicht lesbar",
    "connections.healthSecretUnreadableText":
      "Zugangsdaten sind gespeichert, aber die Instanz kann sie nicht lesen. Bis sie neu gesetzt sind, erreicht kein Aufruf das externe System.",
    "connections.healthTesting": "Test läuft",
    "connections.healthTestingText":
      "Die Instanz fragt das externe System an. Das kann einen Moment dauern.",
    "connections.healthUnauthorized": "Nicht autorisiert",
    "connections.healthUnauthorizedText":
      "Das externe System hat die Zugangsdaten abgelehnt. Sie können falsch, abgelaufen oder widerrufen sein.",
    "connections.healthUnavailable": "Nicht erreichbar",
    "connections.healthUnavailableText":
      "Das externe System hat auf den Test nicht geantwortet. Es kann ausgefallen sein, oder seine Adresse stimmt nicht.",
    "connections.kind": "Verbindungen",
    "connections.kindSingular": "Verbindung",
    "connections.lastTested": "Zuletzt getestet {time}",
    "connections.missing": "Es gibt keine Verbindung mit der Kennung {name}.",
    "connections.operationExposure": "Aufrufbar durch",
    "connections.paging": "Seitenweise nach",
    "connections.pagingCursor": "Cursor aus {cursor} jeder Antwort, gesendet als {param}",
    "connections.pagingNextLink":
      "nächster Adresse aus {cursor} jeder Antwort, gesendet als {param}",
    "connections.pagingOffset": "Zeilenversatz in {param}, {size} pro Seite in {sizeParam}",
    "connections.pagingPage": "Seitennummer in {param}, {size} pro Seite in {sizeParam}",
    "connections.pagingStart": "{text}, beginnend bei {start}",
    "connections.operationsTitle": "Operationen",
    "connections.operationsDescription":
      "Was diese Verbindung im externen System tun kann und wer es aufrufen darf.",
    "connections.operationsEmpty": "Diese Verbindung hat keine akzeptierte Operation.",
    "connections.scopeInstance": "Instanz",
    "connections.scopeWorkspace": "Arbeitsbereich",
    "connections.search": "Verbindungen durchsuchen",
    "connections.settingsTitle": "Einstellungen",
    "connections.settingsDescription":
      "Wie die Instanz das externe System erreicht. Keine Einstellung enthält Zugangsdaten.",
    "connections.sharedAccountTitle": "Ein gemeinsames Konto",
    "connections.sharedAccountText":
      "Jeder Aufruf über diese Verbindung nutzt dasselbe Konto im externen System. Alle, die die Verbindung nutzen dürfen, sehen, was dieses Konto sieht, unabhängig von ihren eigenen Rechten dort.",
    "connections.statusAwaitingDiscovery": "Wartet auf Erkennung",
    "connections.statusAwaitingDiscoveryText":
      "Die Instanz hat diese Operation noch nicht vom externen System gelesen. Bis dahin kann sie nicht aufgerufen werden.",
    "connections.statusDisabled": "Deaktiviert",
    "connections.statusDisabledText": "Vom Betreiber dieser Instanz abgeschaltet.",
    "connections.statusNeedsReview": "Prüfung nötig",
    "connections.statusNeedsReviewText":
      "Das externe System beschreibt diese Operation jetzt anders als akzeptiert. Sie kann erst wieder aufgerufen werden, wenn der Betreiber die neue Beschreibung akzeptiert.",
    "connections.statusNeedsReviewFingerprint": "Neuer Fingerabdruck:",
    "connections.statusReady": "Bereit",
    "connections.statusTitle": "Status",
    "connections.statusUnknown": "Unbekannt",
    "connections.statusUnknownText":
      "Das externe System bietet diese Operation nicht an. Sie kann nicht aufgerufen werden.",
    "connections.test": "Verbindung testen",
    "connections.testFailed": "Der Test konnte nicht ausgeführt werden.",
    "connections.testHeld":
      "Der Test wartet auf eine Freigabe im Eingang. Er ist noch nicht gelaufen.",
    "connections.testNotAllowed":
      "Du kannst diese Verbindung lesen. Zum Testen brauchst du das Recht, Verbindungen der Instanz zu ändern.",
    "connections.testRefused": "Du darfst diese Verbindung nicht testen. Lesen kannst du sie.",
    "connections.toolsHeld": "Werkzeuge von Verbindungen, die dieser Agent führt",
    "connections.personContextTitle": "Personenkontext",
    "connections.personContextDescription":
      "Der Wert, den jeder Aufruf für die Person oder das technische Konto mitschickt, für die er läuft.",
    "connections.personContextHeader": "Header",
    "connections.personContextExplain":
      "Niemand wird automatisch zugeordnet. Ordne jede Person und jedes technische Konto einzeln zu. Ein Aufruf für jemanden ohne Zuordnung wird abgelehnt.",
    "connections.personContextKind": "Zuordnung für",
    "connections.personContextKindUser": "Person",
    "connections.personContextSubjectId": "ID",
    "connections.personContextSubjectIdHint":
      "Die ID, die die Instanz der Person oder dem technischen Konto gibt.",
    "connections.personContextShow": "Zuordnung anzeigen",
    "connections.personContextChoosePerson": "Person auswählen",
    "connections.personContextChoosePrincipal": "Technisches Konto auswählen",
    "connections.personContextNoPeople": "Diese Instanz hat noch keine Personen.",
    "connections.personContextNoPrincipals": "Diese Instanz hat noch keine technischen Konten.",
    "connections.personContextListFailed": "Die Liste ließ sich nicht laden.",
    "connections.personContextPeopleHidden":
      "Um eine Person nach Namen auszuwählen, brauchst du das Recht, Benutzer zu verwalten. Wer es hat, kann Personen hier zuordnen.",
    "connections.personContextPrincipalsHidden":
      "Um ein technisches Konto nach Namen auszuwählen, brauchst du das Recht, technische Konten zu verwalten. Wer es hat, kann sie hier zuordnen.",
    "connections.personContextEnterId": "Stattdessen eine technische ID eingeben",
    "connections.personContextReadFailed": "Die Zuordnung ließ sich nicht lesen.",
    "connections.personContextMapped": "Zugeordnet",
    "connections.personContextUnmapped": "Nicht zugeordnet",
    "connections.personContextUnmappedText":
      "Aufrufe dieser Verbindung für sie werden abgelehnt, bis du einen Wert speicherst.",
    "connections.personContextValue": "Wert in {header}",
    "connections.personContextValueHint": "Nur wer diese Verbindung ändern darf, sieht ihn.",
    "connections.personContextSave": "Zuordnung speichern",
    "connections.personContextRemove": "Zuordnung entfernen",
    "connections.personContextConflict":
      "Jemand hat diese Zuordnung inzwischen geändert. Der aktuelle Stand wird angezeigt; prüfe ihn und speichere erneut.",
    "connections.personContextWriteFailed": "Die Zuordnung wurde nicht gespeichert.",
    "connections.toolsLoading": "Die Verbindungen werden geprüft.",
    "connections.toolsOpenConnection": "Verbindung öffnen",
    "connections.toolsSelected": "{selected} von {count} ausgewählt",
    "connections.toolsUnavailableText":
      "Diese Werkzeuge werden diesem Agenten nicht mehr angeboten. Der Agent behält sie, bis du sie entfernst.",
    "connections.toolsUnavailableTitle": "Nicht mehr verfügbar",
    "connections.toolsUnknown":
      "Die Verbindungen ließen sich nicht lesen, deshalb wurde das nicht geprüft. Der Agent behält es, bis du es entfernst."
  }
});
