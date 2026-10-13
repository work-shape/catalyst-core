import { defineTranslations } from "./translation-area";

export const connections = defineTranslations({
  en: {
    "connections.description":
      "The operator of this instance sets up its connections. They cannot be changed here.",
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
    "connections.accessTitle": "Who may use it",
    "connections.accessDescription":
      "People and service principals with a right on this Connection itself. Rights on a whole workspace or Namespace are on the Access page.",
    "connections.accessEmpty": "Nobody was given this Connection by itself.",
    "connections.accessFailed": "Who may use this Connection could not be loaded.",
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
    "connections.exposureAgent": "Agents",
    "connections.exposureBridge": "Apps",
    "connections.exposureNone": "Nobody can call it",
    "connections.exposureWorkflow": "Workflows",
    "connections.healthNetworkDenied": "Network denied",
    "connections.healthNetworkDeniedText":
      "The instance may not reach this address. Its host is not among the outside addresses the operator allowed.",
    "connections.healthNeverTested": "Not tested",
    "connections.healthNeverTestedText": "This connection has not been tested yet.",
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
    "connections.toolsEmpty": "No connection you may read offers an operation to agents.",
    "connections.toolsHeld": "Tools of connections this agent holds",
    "connections.toolsHint":
      "What a connection lets agents do in an outside system. You see the connections you may read.",
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
    "connections.description":
      "Der Betreiber dieser Instanz richtet ihre Verbindungen ein. Hier lassen sie sich nicht ändern.",
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
    "connections.accessTitle": "Wer sie verwenden darf",
    "connections.accessDescription":
      "Personen und Service Principals mit einem Recht auf dieser Verbindung selbst. Rechte auf einem ganzen Arbeitsbereich oder Namespace stehen auf der Seite Zugriff.",
    "connections.accessEmpty": "Niemand hat diese Verbindung einzeln erhalten.",
    "connections.accessFailed": "Wer diese Verbindung verwenden darf, konnte nicht geladen werden.",
    "connections.accessServicePrincipal": "Service Principal",
    "connections.accessPrincipalDisabled": "Deaktiviert",
    "connections.accessUnknownPerson": "Eine Person, die du nicht sehen kannst",
    "connections.accessUnknownPrincipal": "Ein Service Principal, den es nicht mehr gibt",
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
    "connections.exposureAgent": "Agenten",
    "connections.exposureBridge": "Apps",
    "connections.exposureNone": "Niemand kann sie aufrufen",
    "connections.exposureWorkflow": "Workflows",
    "connections.healthNetworkDenied": "Netzwerk gesperrt",
    "connections.healthNetworkDeniedText":
      "Die Instanz darf diese Adresse nicht erreichen. Ihr Host gehört nicht zu den externen Adressen, die der Betreiber erlaubt hat.",
    "connections.healthNeverTested": "Nicht getestet",
    "connections.healthNeverTestedText": "Diese Verbindung wurde noch nicht getestet.",
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
    "connections.toolsEmpty":
      "Keine Verbindung, die du lesen darfst, bietet Agenten eine Operation an.",
    "connections.toolsHeld": "Werkzeuge von Verbindungen, die dieser Agent führt",
    "connections.toolsHint":
      "Was eine Verbindung Agenten in einem externen System erlaubt. Du siehst die Verbindungen, die du lesen darfst.",
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
